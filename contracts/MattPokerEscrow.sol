// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPokerVRFAdapter { function requestRandomWord(uint64 handId) external returns (uint256); }

contract MattPokerEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint8 public constant MAX_SEATS=6;
    uint16 public constant MAX_RAKE_BPS=500;
    uint48 public constant CONFIG_DELAY=1 days;
    uint48 public constant STALE_HAND_DELAY=30 minutes;

    struct Seat { address wallet; address sessionKey; uint128 balance; }
    struct Config { uint128 buyIn; uint128 rakeCap; uint16 rakeBps; uint32 version; }
    struct PendingConfig { uint128 buyIn; uint128 rakeCap; uint16 rakeBps; uint48 activatesAt; bool exists; }
    struct Hand {
        uint64 id; uint48 startedAt; uint32 configVersion; uint8 playerMask;
        bytes32 dealerCommitment; uint256 requestId; uint256 randomWord; bool randomnessReady;
        uint128[6] openingBalances;
    }

    IERC20 public immutable matt;
    IPokerVRFAdapter public immutable vrfAdapter;
    address public immutable treasury;
    address public operator;
    Config public config;
    PendingConfig public pendingConfig;
    Hand private hand;
    Seat[6] private seats;
    mapping(address=>uint8) public seatPlusOne;
    uint256 public totalPlayerLiability;
    uint64 public latestHandId;
    uint64 public lastFinalizedHandId;

    event BoughtIn(address indexed player,uint8 indexed seat,address indexed sessionKey,uint256 amount);
    event CashedOut(address indexed player,uint8 indexed seat,uint256 amount);
    event HandStarted(uint64 indexed handId,uint8 playerMask,bytes32 dealerCommitment,uint256 requestId);
    event RandomnessReady(uint64 indexed handId,uint256 randomWord);
    event HandSettled(uint64 indexed handId,uint256 matchedPot,uint256 rake,bytes32 transcriptHash,bytes32 resultHash);
    event HandCancelled(uint64 indexed handId);
    event ConfigProposed(uint128 buyIn,uint16 rakeBps,uint128 rakeCap,uint48 activatesAt);
    event ConfigActivated(uint128 buyIn,uint16 rakeBps,uint128 rakeCap,uint32 version);

    modifier onlyOperator(){require(msg.sender==operator,"Poker: operator only");_;}

    constructor(address matt_,address adapter_,address treasury_,address operator_,address owner_,uint128 buyIn_)
        Ownable(owner_)
    {
        require(matt_.code.length>0&&adapter_.code.length>0,"Poker: contracts required");
        require(treasury_!=address(0)&&operator_!=address(0),"Poker: zero address");
        _checkBuyIn(buyIn_);
        matt=IERC20(matt_); vrfAdapter=IPokerVRFAdapter(adapter_);
        treasury=treasury_; operator=operator_; config=Config(buyIn_,0,0,1); _pause();
    }

    function seatAt(uint8 i) external view returns(Seat memory){require(i<6,"Poker: seat");return seats[i];}
    function activeHand() external view returns(Hand memory){return hand;}
    function smallBlind() external view returns(uint256){return uint256(config.buyIn)/200;}
    function bigBlind() external view returns(uint256){return uint256(config.buyIn)/100;}
    function isSolvent() public view returns(bool){return matt.balanceOf(address(this))>=totalPlayerLiability;}

    function buyIn(uint8 i,address sessionKey) external whenNotPaused nonReentrant {
        require(hand.id==0&&i<6&&seats[i].wallet==address(0)&&seatPlusOne[msg.sender]==0,"Poker: seat unavailable");
        require(sessionKey!=address(0)&&sessionKey!=msg.sender,"Poker: session key");
        uint256 amount=config.buyIn; uint256 beforeBalance=matt.balanceOf(address(this));
        matt.safeTransferFrom(msg.sender,address(this),amount);
        require(matt.balanceOf(address(this))==beforeBalance+amount,"Poker: fee token");
        seats[i]=Seat(msg.sender,sessionKey,uint128(amount)); seatPlusOne[msg.sender]=i+1;
        totalPlayerLiability+=amount; emit BoughtIn(msg.sender,i,sessionKey,amount);
    }

    function changeSessionKey(address next) external {
        require(hand.id==0&&next!=address(0)&&next!=msg.sender,"Poker: session key");
        uint8 i=seatPlusOne[msg.sender]; require(i!=0,"Poker: not seated");
        seats[i-1].sessionKey=next;
    }

    function cashOut() external nonReentrant {
        require(hand.id==0,"Poker: hand active");
        uint8 n=seatPlusOne[msg.sender]; require(n!=0,"Poker: not seated");
        uint8 i=n-1; uint256 amount=seats[i].balance;
        delete seats[i]; delete seatPlusOne[msg.sender]; totalPlayerLiability-=amount;
        if(amount>0)matt.safeTransfer(msg.sender,amount);
        emit CashedOut(msg.sender,i,amount);
    }

    function beginHand(uint8 mask,bytes32 commitment)
        external onlyOperator whenNotPaused nonReentrant returns(uint64 id,uint256 requestId)
    {
        require(hand.id==0&&commitment!=bytes32(0)&&mask>>6==0&&_count(mask)>=2,"Poker: invalid hand");
        id=++latestHandId; hand.id=id; hand.startedAt=uint48(block.timestamp);
        hand.configVersion=config.version; hand.playerMask=mask; hand.dealerCommitment=commitment;
        for(uint8 i;i<6;i++){
            hand.openingBalances[i]=seats[i].balance;
            if((mask&(uint8(1)<<i))!=0)require(seats[i].wallet!=address(0)&&seats[i].balance>0,"Poker: player");
        }
        requestId=vrfAdapter.requestRandomWord(id); hand.requestId=requestId;
        emit HandStarted(id,mask,commitment,requestId);
    }

    function rawFulfillPokerRandomness(uint64 id,uint256 word) external {
        require(msg.sender==address(vrfAdapter)&&hand.id==id&&id!=0&&!hand.randomnessReady,"Poker: callback");
        hand.randomWord=word; hand.randomnessReady=true; emit RandomnessReady(id,word);
    }

    function settleHand(uint64 id,uint128[6] calldata closing,uint256 matchedPot,uint8 boardCards,bytes32 transcriptHash,bytes32 resultHash)
        external onlyOperator nonReentrant
    {
        require(hand.id==id&&id!=0&&hand.randomnessReady,"Poker: hand not ready");
        require(boardCards<=5&&transcriptHash!=bytes32(0)&&resultHash!=bytes32(0),"Poker: audit");
        uint256 beforeTotal; uint256 afterTotal;
        for(uint8 i;i<6;i++){
            beforeTotal+=hand.openingBalances[i]; afterTotal+=closing[i];
            if(seats[i].wallet==address(0))require(closing[i]==0,"Poker: empty seat");
            if((hand.playerMask&(uint8(1)<<i))==0)require(closing[i]==hand.openingBalances[i],"Poker: inactive changed");
        }
        require(beforeTotal>=afterTotal&&matchedPot<=beforeTotal,"Poker: settlement");
        uint256 rake=beforeTotal-afterTotal; uint256 allowed;
        if(boardCards>=3&&config.rakeBps>0){allowed=matchedPot*config.rakeBps/10000;if(allowed>config.rakeCap)allowed=config.rakeCap;}
        require(rake<=allowed,"Poker: rake");
        for(uint8 i;i<6;i++)seats[i].balance=closing[i];
        totalPlayerLiability-=rake; lastFinalizedHandId=id; delete hand;
        if(rake>0)matt.safeTransfer(treasury,rake);
        require(isSolvent(),"Poker: insolvent");
        emit HandSettled(id,matchedPot,rake,transcriptHash,resultHash);
    }

    function cancelStaleHand() external {
        uint64 id=hand.id; require(id!=0&&block.timestamp>=uint256(hand.startedAt)+STALE_HAND_DELAY,"Poker: not stale");
        delete hand; emit HandCancelled(id);
    }

    function proposeConfig(uint128 buyIn_,uint16 rakeBps_,uint128 rakeCap_) external onlyOwner whenPaused {
        require(hand.id==0&&totalPlayerLiability==0,"Poker: table not empty");
        _checkBuyIn(buyIn_); require(rakeBps_<=MAX_RAKE_BPS&&(rakeBps_>0||rakeCap_==0),"Poker: rake config");
        uint48 at=uint48(block.timestamp)+CONFIG_DELAY;
        pendingConfig=PendingConfig(buyIn_,rakeCap_,rakeBps_,at,true);
        emit ConfigProposed(buyIn_,rakeBps_,rakeCap_,at);
    }

    function activateConfig() external onlyOwner whenPaused {
        PendingConfig memory p=pendingConfig;
        require(p.exists&&block.timestamp>=p.activatesAt&&hand.id==0&&totalPlayerLiability==0,"Poker: config locked");
        config=Config(p.buyIn,p.rakeCap,p.rakeBps,config.version+1); delete pendingConfig;
        emit ConfigActivated(config.buyIn,config.rakeBps,config.rakeCap,config.version);
    }

    function setOperator(address next) external onlyOwner whenPaused {
        require(hand.id==0&&next!=address(0),"Poker: operator"); operator=next;
    }
    function pause() external onlyOwner {_pause();}
    function unpause() external onlyOwner {_unpause();}
    function recoverUnsupportedToken(address token,address to,uint256 amount) external onlyOwner {
        require(token!=address(matt)&&to!=address(0),"Poker: protected");IERC20(token).safeTransfer(to,amount);
    }
    function _checkBuyIn(uint128 amount) private pure {require(amount>=200&&amount%200==0,"Poker: blind division");}
    function _count(uint8 v) private pure returns(uint8 n){while(v!=0){n+=v&1;v>>=1;}}
}
