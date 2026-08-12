// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPokerCoordinatorV25 {
    struct RandomWordsRequest {bytes32 keyHash;uint256 subId;uint16 requestConfirmations;uint32 callbackGasLimit;uint32 numWords;bytes extraArgs;}
    function requestRandomWords(RandomWordsRequest calldata request) external returns(uint256);
}
interface IPokerConsumer {function rawFulfillPokerRandomness(uint64 handId,uint256 randomWord) external;}

contract MattPokerVRFV25Adapter is Ownable2Step,ReentrancyGuard {
    bytes4 private constant EXTRA_ARGS_V1_TAG=bytes4(keccak256("VRF ExtraArgsV1"));
    uint32 public constant MAX_CALLBACK_GAS_LIMIT=2_500_000;
    struct Request {uint64 handId;uint256 word;bool fulfilled;bool delivered;}
    IPokerCoordinatorV25 public immutable coordinator;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;
    address public consumer;
    uint256 public outstandingRequests;
    mapping(uint256=>Request) public requests;
    mapping(uint64=>uint256) public requestIdForHand;
    event ConsumerSet(address indexed consumer);
    event Requested(uint64 indexed handId,uint256 indexed requestId);
    event Fulfilled(uint64 indexed handId,uint256 indexed requestId,uint256 word);
    event DeliveryDeferred(uint64 indexed handId,uint256 indexed requestId);

    modifier onlyConsumer(){require(msg.sender==consumer,"Poker VRF: consumer only");_;}

    constructor(address coordinator_,uint256 subId_,bytes32 keyHash_,uint16 confirmations_,uint32 callbackGas_,address owner_)
        Ownable(owner_)
    {
        require(coordinator_.code.length>0&&subId_!=0&&keyHash_!=bytes32(0),"Poker VRF: config");
        require(confirmations_>0&&callbackGas_>0&&callbackGas_<=MAX_CALLBACK_GAS_LIMIT,"Poker VRF: gas");
        coordinator=IPokerCoordinatorV25(coordinator_);subscriptionId=subId_;keyHash=keyHash_;
        requestConfirmations=confirmations_;callbackGasLimit=callbackGas_;
    }
    receive() external payable {revert("Poker VRF: direct RON disabled");}
    function setConsumer(address next) external onlyOwner {
        require(consumer==address(0)&&next.code.length>0,"Poker VRF: consumer locked");consumer=next;emit ConsumerSet(next);
    }
    function requestRandomWord(uint64 handId) external onlyConsumer nonReentrant returns(uint256 id){
        require(handId>0&&requestIdForHand[handId]==0,"Poker VRF: duplicate");
        id=coordinator.requestRandomWords(IPokerCoordinatorV25.RandomWordsRequest({
            keyHash:keyHash,subId:subscriptionId,requestConfirmations:requestConfirmations,
            callbackGasLimit:callbackGasLimit,numWords:1,extraArgs:abi.encodeWithSelector(EXTRA_ARGS_V1_TAG,true)
        }));
        requests[id].handId=handId;requestIdForHand[handId]=id;outstandingRequests++;emit Requested(handId,id);
    }
    function rawFulfillRandomWords(uint256 id,uint256[] calldata words) external {
        require(msg.sender==address(coordinator)&&words.length>0,"Poker VRF: coordinator");
        Request storage r=requests[id];require(r.handId>0&&!r.fulfilled,"Poker VRF: request");
        r.word=words[0];r.fulfilled=true;outstandingRequests--;emit Fulfilled(r.handId,id,r.word);
        try IPokerConsumer(consumer).rawFulfillPokerRandomness(r.handId,r.word){r.delivered=true;}
        catch{emit DeliveryDeferred(r.handId,id);}
    }
    function retryDelivery(uint256 id) external nonReentrant {
        Request storage r=requests[id];require(r.fulfilled&&!r.delivered,"Poker VRF: nothing to retry");
        IPokerConsumer(consumer).rawFulfillPokerRandomness(r.handId,r.word);r.delivered=true;
    }
}
