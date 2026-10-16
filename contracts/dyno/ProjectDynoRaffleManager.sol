// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IRoninVRFCoordinator} from "./interfaces/IRoninVRFCoordinator.sol";
import {IProjectDynoBuybackVault} from "./interfaces/IProjectDynoBuybackVault.sol";
import {ProjectDynoVRFRefundReceiver} from "./ProjectDynoVRFRefundReceiver.sol";

/// @notice Project DYNO raffle manager. Chain state is the source of truth for money, entries, snapshots and winners.
/// @dev Multisig and configured emergency admin have immediate UUPS authority in every phase.
contract ProjectDynoRaffleManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    uint16 public constant DRAW_COUNT = 6;
    uint16 public constant RON_PRIZE_COUNT = 5;
    uint32 public constant MIN_REVIEW_DURATION = 24 hours;
    uint256 public constant DAY_SECONDS = 86_400;

    bytes32 private constant PURCHASE_TYPEHASH = keccak256(
        "PurchaseVoucher(uint256 roundId,bytes32 accountCommitment,address wallet,uint8 quantity,uint32 identityVersion,bytes32 nonce,uint64 dayIndex,uint64 expiry)"
    );
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "ClaimAuthorization(bytes32 kind,uint256 itemId,address receiver,uint256 nonce,uint64 expiry)"
    );
    bytes32 private constant RELINK_TYPEHASH = keccak256(
        "RelinkAuthorization(bytes32 accountCommitment,address newWallet,uint32 expectedVersion,uint64 expiry)"
    );
    bytes32 private constant REFUND_KIND = keccak256("REFUND");
    bytes32 private constant PRIZE_KIND = keccak256("PRIZE");

    enum Phase { NONE, DRAFT, OPEN, REVIEW, FROZEN, RANDOMNESS_PENDING, RANDOMNESS_READY, WINNERS_ASSIGNED, SETTLED, CANCELLED }
    enum TicketStatus { NONE, ELIGIBLE, REFUND_CREDITED, REFUND_PAID, CANCELLED_CREDITED, CANCELLED_PAID }
    enum FlagStatus { NONE, PENDING, UPHELD, DISMISSED }

    struct RoundConfig {
        address matt;
        address nftCollection;
        uint256 nftTokenId;
        address nftDepositor;
        address treasury;
        address swapAdapter;
        address priceGuard;
        address vrfCoordinator;
        uint256 ticketRon;
        uint256 ticketMatt;
        uint16 capacity;
        uint256[5] ronPrizes;
        uint256 nextDynoReserve;
        uint16 saleSlippageBps;
        uint16 buybackSlippageBps;
        uint32 reviewDuration;
        uint32 vrfCallbackGasLimit;
        uint64 vrfGasPrice;
        uint256 minimumOperationsFunding;
        bytes32 termsHash;
    }

    struct Round {
        Phase phase;
        bytes32 configHash;
        RoundConfig config;
        uint64 reviewEndsAt;
        uint64 frozenAt;
        uint32 snapshotVersion;
        bytes32 snapshotDigest;
        bytes32 vrfRequestHash;
        uint256 randomSeed;
        uint16 eligibleCount;
        uint32 pendingFlags;
        uint32 upheldFlags;
        uint256 directActive;
        uint256 saleActive;
        uint256 operationsBalance;
        uint256 refundLiability;
        uint256 prizeLiability;
        uint256 treasuryLiability;
        uint256 firstTicketId;
        uint256 lastTicketId;
        uint256 cancellationCursor;
        bool nftDeposited;
        bool cancellationRefundsComplete;
        bool nftReturned;
        bool settled;
        uint256[6] winnerTicketIds;
    }

    struct Ticket {
        uint256 id;
        uint256 roundId;
        address originalWallet;
        bytes32 accountCommitment;
        uint64 purchasedAt;
        uint64 dayIndex;
        uint256 directRon;
        uint256 saleRon;
        uint16 eligibleIndex;
        TicketStatus status;
        uint256 refundAmount;
        bytes32 reasonCode;
        bytes32 evidenceHash;
        uint8 winningBitmap;
    }

    struct PurchaseVoucher {
        uint256 roundId;
        bytes32 accountCommitment;
        address wallet;
        uint8 quantity;
        uint32 identityVersion;
        bytes32 nonce;
        uint64 dayIndex;
        uint64 expiry;
    }

    struct ReviewFlag {
        FlagStatus status;
        bytes32 reasonCode;
        bytes32 evidenceHash;
        address reporter;
    }

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidPhase();
    error InvalidVoucher();
    error InvalidTicket();
    error InvalidClaim();
    error Paused();
    error TransferFailed();
    error Insolvent();

    IProjectDynoBuybackVault public buybackVault;
    address public multisig;
    address public identitySigner;
    uint256 public activeRoundId;
    uint256 public nextRoundId;
    uint256 public nextTicketId;
    bool public checkoutPaused;
    bool public reviewPaused;
    bool public claimsPaused;

    mapping(uint256 => Round) private _rounds;
    mapping(uint256 => Ticket) private _tickets;
    mapping(uint256 => uint256[]) private _eligibleTicketIds;
    mapping(uint256 => mapping(uint256 => ReviewFlag)) public reviewFlags;
    mapping(bytes32 => address) public walletForAccount;
    mapping(address => bytes32) public accountForWallet;
    mapping(bytes32 => uint32) public identityVersion;
    mapping(bytes32 => bool) public accountSuspended;
    mapping(bytes32 => mapping(uint64 => uint8)) public accountDayCount;
    mapping(address => mapping(uint64 => uint8)) public walletDayCount;
    mapping(bytes32 => mapping(bytes32 => bool)) public usedVoucherNonce;
    mapping(address => uint256) public claimNonce;
    mapping(uint256 => mapping(uint8 => uint256)) public prizeAmount;
    mapping(uint256 => mapping(uint8 => bool)) public prizePaid;
    mapping(uint256 => bool) public refundPaid;
    mapping(address => bool) public reviewer;
    // Appended fields consume the storage gap; historical round/ticket layouts are unchanged.
    mapping(uint256 => uint256) public nftPrizeChainId;
    mapping(uint256 => bytes32) public reportedNftDelivery;
    address public emergencyAdmin;
    address public vrfRefundReceiver;
    mapping(uint256 => address) public vrfRefundReceiverForRound;
    mapping(uint256 => uint256) public mattActive;
    mapping(uint256 => uint256) public mattRefundLiability;
    mapping(uint256 => uint256) public treasuryMattLiability;
    mapping(uint256 => uint256) public ticketRefundMatt;

    event RoundCreated(uint256 indexed roundId, bytes32 indexed configHash, address indexed actor);
    event ManualPrizeDeliveryConfigured(uint256 indexed roundId, uint256 nftChainId, address indexed depositor);
    event NFTDeliveryReported(uint256 indexed roundId, bytes32 indexed transactionHash, bytes32 previousTransactionHash, address winner, address indexed actor);
    event RoundOpened(uint256 indexed roundId, uint256 ticketRon, uint256 ticketMatt, uint16 capacity);
    event TicketPurchased(uint256 indexed roundId, uint256 indexed ticketId, address indexed wallet, bytes32 accountCommitment, uint64 dayIndex, uint256 directRon, uint256 saleRon);
    event ReviewStarted(uint256 indexed roundId, uint64 reviewEndsAt, uint32 snapshotAttempt);
    event TicketFlagged(uint256 indexed roundId, uint256 indexed ticketId, bytes32 reasonCode, bytes32 evidenceHash, address indexed reporter);
    event FlagResolved(uint256 indexed roundId, uint256 indexed ticketId, bool upheld, address indexed actor);
    event TicketDisqualified(uint256 indexed roundId, uint256 indexed ticketId, bytes32 reasonCode, bytes32 evidenceHash, address indexed actor);
    event RefundCredited(uint256 indexed roundId, uint256 indexed ticketId, address indexed beneficiary, uint256 amount);
    event RefundPaid(uint256 indexed roundId, uint256 indexed ticketId, address indexed receiver, uint256 amount);
    event MattRefundCredited(uint256 indexed roundId, uint256 indexed ticketId, address indexed beneficiary, uint256 amount);
    event MattRefundPaid(uint256 indexed roundId, uint256 indexed ticketId, address indexed receiver, uint256 amount);
    event TreasuryMattAllocated(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event TreasuryMattClaimed(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event EligibilityFrozen(uint256 indexed roundId, uint16 count, bytes32 indexed digest, bytes32 indexed configHash, uint64 frozenAt, uint32 snapshotVersion);
    event RandomnessRequested(uint256 indexed roundId, bytes32 indexed requestHash, bytes32 indexed snapshotDigest, address coordinator, uint256 fee);
    event RandomnessReceived(uint256 indexed roundId, bytes32 indexed requestHash, uint256 seed);
    event WinnerAssigned(uint256 indexed roundId, uint8 indexed prizeIndex, uint256 indexed ticketId, address winner, uint256 ronAmount);
    event PrizePaid(uint256 indexed roundId, uint8 indexed prizeIndex, uint256 indexed ticketId, address receiver, uint256 amount, bool nft);
    event PrizePaymentFailed(uint256 indexed roundId, uint8 indexed prizeIndex, uint256 indexed ticketId, address receiver, bytes32 reasonHash);
    event NextDynoReserved(uint256 indexed roundId, address indexed treasury, uint256 amount, bool transferred);
    event TreasuryTransferred(uint256 indexed roundId, address indexed treasury, uint256 amount, bool transferred);
    event TreasuryLiabilityClaimed(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event RoundSettled(uint256 indexed roundId, uint256 prizeLiability, uint256 reserve, uint256 treasuryRemainder, uint256 buybackBudget);
    event RoundCancelled(uint256 indexed roundId, bytes32 indexed reasonCode, address indexed actor);
    event CancellationProgress(uint256 indexed roundId, uint256 cursor, bool complete);
    event IdentityRelinked(bytes32 indexed accountCommitment, address indexed oldWallet, address indexed newWallet, uint32 identityVersion);
    event SignerChanged(address indexed oldSigner, address indexed newSigner, address indexed actor);
    event ParameterChanged(uint256 indexed roundId, bytes32 indexed parameter, uint256 oldValue, uint256 newValue, address actor);
    event SubsystemPauseChanged(bytes32 indexed subsystem, bool paused, address indexed actor);
    event OperationsFunded(uint256 indexed roundId, address indexed funder, uint256 amount);
    event ReviewerUpdated(address indexed account, bool enabled, address indexed actor);
    event EmergencyAdminChanged(address indexed oldAdmin, address indexed newAdmin, address indexed actor);
    event VrfRefundReceiverChanged(address indexed oldReceiver, address indexed newReceiver, address indexed actor);

    modifier onlyMultisig() {
        // Legacy internal name; BOTH configured administrators may act alone.
        if (!isAdmin(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyReviewer() {
        if (!reviewer[msg.sender] && !isAdmin(msg.sender)) revert Unauthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address multisig_, address identitySigner_, address vault, address reviewer_) external initializer {
        if (multisig_ == address(0) || identitySigner_ == address(0) || vault == address(0)) revert InvalidConfiguration();
        __ReentrancyGuard_init();
        __EIP712_init("Project DYNO", "1");
        __UUPSUpgradeable_init();
        multisig = multisig_;
        if (reviewer_ != address(0)) reviewer[reviewer_] = true;
        identitySigner = identitySigner_;
        buybackVault = IProjectDynoBuybackVault(vault);
        nextRoundId = 1;
        nextTicketId = 1;
    }

    function createRound(RoundConfig calldata config, uint256 nftChainId) external onlyMultisig returns (uint256 roundId) {
        if (activeRoundId != 0) {
            Round storage previous = _rounds[activeRoundId];
            if (previous.phase != Phase.SETTLED && previous.phase != Phase.CANCELLED) revert InvalidPhase();
            // The no-sale model has no buyback schedule to await.
        }
        _validateConfig(config);
        if (nftChainId == 0) revert InvalidConfiguration();
        roundId = nextRoundId++;
        Round storage round = _rounds[roundId];
        round.phase = Phase.DRAFT;
        round.config = config;
        nftPrizeChainId[roundId] = nftChainId;
        round.configHash = keccak256(abi.encode(config, nftChainId, keccak256("MANUAL_PRIZE_DELIVERY_V1")));
        round.firstTicketId = nextTicketId;
        activeRoundId = roundId;
        emit RoundCreated(roundId, round.configHash, msg.sender);
        emit ManualPrizeDeliveryConfigured(roundId, nftChainId, config.nftDepositor);
    }

    function fundOperations(uint256 roundId) external payable {
        Round storage round = _rounds[roundId];
        if (round.phase == Phase.NONE || round.phase == Phase.SETTLED || round.phase == Phase.CANCELLED) revert InvalidPhase();
        round.operationsBalance += msg.value;
        emit OperationsFunded(roundId, msg.sender, msg.value);
    }

    function openRound(uint256 roundId) external onlyMultisig {
        Round storage round = _rounds[roundId];
        if (roundId != activeRoundId || round.phase != Phase.DRAFT) revert InvalidPhase();
        if (vrfRefundReceiver == address(0)) revert InvalidConfiguration();
        if (round.operationsBalance < round.config.minimumOperationsFunding) revert Insolvent();
        round.phase = Phase.OPEN;
        emit RoundOpened(roundId, round.config.ticketRon, round.config.ticketMatt, round.config.capacity);
    }

    function buyTickets(PurchaseVoucher calldata voucher, bytes calldata signature) external payable nonReentrant {
        if (checkoutPaused) revert Paused();
        Round storage round = _rounds[voucher.roundId];
        if (voucher.roundId != activeRoundId || round.phase != Phase.OPEN) revert InvalidPhase();
        if (voucher.wallet != msg.sender || voucher.quantity == 0 || voucher.quantity > 3) revert InvalidVoucher();
        if (voucher.expiry < block.timestamp || voucher.dayIndex != block.timestamp / DAY_SECONDS || voucher.expiry / DAY_SECONDS != voucher.dayIndex) revert InvalidVoucher();
        if (voucher.accountCommitment == bytes32(0) || accountSuspended[voucher.accountCommitment]) revert InvalidVoucher();
        if (round.eligibleCount + voucher.quantity > round.config.capacity) revert InvalidVoucher();
        if (msg.value != round.config.ticketRon * voucher.quantity) revert InvalidVoucher();
        if (usedVoucherNonce[voucher.accountCommitment][voucher.nonce]) revert InvalidVoucher();
        if (!_validPurchaseVoucher(voucher, signature)) revert InvalidVoucher();

        _bindIdentity(voucher.accountCommitment, voucher.wallet, voucher.identityVersion);
        uint8 accountUsed = accountDayCount[voucher.accountCommitment][voucher.dayIndex];
        uint8 walletUsed = walletDayCount[voucher.wallet][voucher.dayIndex];
        if (accountUsed + voucher.quantity > 3 || walletUsed + voucher.quantity > 3) revert InvalidVoucher();
        usedVoucherNonce[voucher.accountCommitment][voucher.nonce] = true;
        accountDayCount[voucher.accountCommitment][voucher.dayIndex] = accountUsed + voucher.quantity;
        walletDayCount[voucher.wallet][voucher.dayIndex] = walletUsed + voucher.quantity;

        IERC20 token = IERC20(round.config.matt);
        uint256 totalMatt = round.config.ticketMatt * voucher.quantity;
        uint256 tokenBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), totalMatt);
        if (token.balanceOf(address(this)) - tokenBefore != totalMatt) revert InvalidConfiguration();

        for (uint8 i = 0; i < voucher.quantity; ++i) _recordTicket(round, voucher, 0);
        mattActive[voucher.roundId] += totalMatt;
        round.directActive += msg.value;
        if (round.eligibleCount == round.config.capacity) {
            round.phase = Phase.REVIEW;
            round.reviewEndsAt = uint64(block.timestamp + round.config.reviewDuration);
            round.snapshotVersion += 1;
            emit ReviewStarted(voucher.roundId, round.reviewEndsAt, round.snapshotVersion);
        }
    }

    function flagTicket(uint256 ticketId, bytes32 reasonCode, bytes32 evidenceHash) external onlyReviewer {
        if (reviewPaused) revert Paused();
        Ticket storage ticket = _tickets[ticketId];
        Round storage round = _rounds[ticket.roundId];
        if (ticket.status != TicketStatus.ELIGIBLE || (round.phase != Phase.OPEN && round.phase != Phase.REVIEW)) revert InvalidTicket();
        ReviewFlag storage flag = reviewFlags[ticket.roundId][ticketId];
        if (flag.status == FlagStatus.PENDING || flag.status == FlagStatus.UPHELD) revert InvalidTicket();
        flag.status = FlagStatus.PENDING;
        flag.reasonCode = reasonCode;
        flag.evidenceHash = evidenceHash;
        flag.reporter = msg.sender;
        round.pendingFlags += 1;
        emit TicketFlagged(ticket.roundId, ticketId, reasonCode, evidenceHash, msg.sender);
    }

    function resolveFlag(uint256 ticketId, bool uphold) external onlyMultisig {
        Ticket storage ticket = _tickets[ticketId];
        Round storage round = _rounds[ticket.roundId];
        ReviewFlag storage flag = reviewFlags[ticket.roundId][ticketId];
        if (flag.status != FlagStatus.PENDING) revert InvalidTicket();
        round.pendingFlags -= 1;
        if (uphold) {
            flag.status = FlagStatus.UPHELD;
            round.upheldFlags += 1;
        } else flag.status = FlagStatus.DISMISSED;
        emit FlagResolved(ticket.roundId, ticketId, uphold, msg.sender);
    }

    function disqualifyTicket(uint256 ticketId, bytes32 reasonCode, bytes32 evidenceHash) external onlyMultisig nonReentrant {
        Ticket storage ticket = _tickets[ticketId];
        Round storage round = _rounds[ticket.roundId];
        if (ticket.status != TicketStatus.ELIGIBLE || (round.phase != Phase.OPEN && round.phase != Phase.REVIEW)) revert InvalidTicket();
        ReviewFlag storage flag = reviewFlags[ticket.roundId][ticketId];
        bool wasUpheld = flag.status == FlagStatus.UPHELD;
        if (flag.status == FlagStatus.PENDING) {
            round.pendingFlags -= 1;
            flag.status = FlagStatus.UPHELD;
        }
        if (wasUpheld) round.upheldFlags -= 1;
        _removeEligible(ticket, round);
        ticket.status = TicketStatus.REFUND_CREDITED;
        ticket.reasonCode = reasonCode;
        ticket.evidenceHash = evidenceHash;
        ticket.refundAmount = ticket.directRon;
        round.directActive -= ticket.directRon;
        mattActive[ticket.roundId] -= round.config.ticketMatt;
        mattRefundLiability[ticket.roundId] += round.config.ticketMatt;
        ticketRefundMatt[ticketId] = round.config.ticketMatt;
        round.refundLiability += ticket.refundAmount;
        if (round.phase == Phase.REVIEW) {
            round.phase = Phase.OPEN;
            round.reviewEndsAt = 0;
        }
        emit TicketDisqualified(ticket.roundId, ticketId, reasonCode, evidenceHash, msg.sender);
        emit RefundCredited(ticket.roundId, ticketId, ticket.originalWallet, ticket.refundAmount);
        emit MattRefundCredited(ticket.roundId, ticketId, ticket.originalWallet, round.config.ticketMatt);
    }

    function finalizeEligibility(uint256 roundId) external onlyMultisig {
        if (reviewPaused) revert Paused();
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.REVIEW || round.eligibleCount != round.config.capacity || block.timestamp < round.reviewEndsAt) revert InvalidPhase();
        if (round.pendingFlags != 0 || round.upheldFlags != 0) revert InvalidPhase();
        bytes32 digest;
        uint256[] storage ids = _eligibleTicketIds[roundId];
        for (uint256 i = 0; i < ids.length; ++i) digest = keccak256(abi.encode(digest, i, ids[i]));
        round.snapshotDigest = digest;
        round.frozenAt = uint64(block.timestamp);
        round.phase = Phase.FROZEN;
        emit EligibilityFrozen(roundId, round.eligibleCount, digest, round.configHash, round.frozenAt, round.snapshotVersion);
    }

    function requestDraw(uint256 roundId) external nonReentrant returns (bytes32 requestHash) {
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.FROZEN || round.eligibleCount != round.config.capacity) revert InvalidPhase();
        if (round.directActive != round.config.ticketRon * round.config.capacity) revert Insolvent();
        uint256 fee = IRoninVRFCoordinator(round.config.vrfCoordinator).estimateRequestRandomFee(round.config.vrfCallbackGasLimit, round.config.vrfGasPrice);
        if (fee == 0 || round.operationsBalance < fee) revert Insolvent();
        round.operationsBalance -= fee;
        address refundReceiver = vrfRefundReceiver;
        if (refundReceiver == address(0)) revert InvalidConfiguration();
        vrfRefundReceiverForRound[roundId] = refundReceiver;
        requestHash = IRoninVRFCoordinator(round.config.vrfCoordinator).requestRandomSeed{value: fee}(
            round.config.vrfCallbackGasLimit,
            round.config.vrfGasPrice,
            address(this),
            refundReceiver
        );
        if (requestHash == bytes32(0)) revert InvalidConfiguration();
        round.vrfRequestHash = requestHash;
        round.phase = Phase.RANDOMNESS_PENDING;
        emit RandomnessRequested(roundId, requestHash, round.snapshotDigest, round.config.vrfCoordinator, fee);
    }

    function rawFulfillRandomSeed(bytes32 requestHash, uint256 seed) external {
        Round storage round = _rounds[activeRoundId];
        if (msg.sender != round.config.vrfCoordinator || round.phase != Phase.RANDOMNESS_PENDING || requestHash != round.vrfRequestHash || seed == 0) revert Unauthorized();
        round.randomSeed = seed;
        round.phase = Phase.RANDOMNESS_READY;
        emit RandomnessReceived(activeRoundId, requestHash, seed);
    }

    function finalizeWinners(uint256 roundId) external {
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.RANDOMNESS_READY) revert InvalidPhase();
        ProjectDynoVRFRefundReceiver(payable(vrfRefundReceiverForRound[roundId])).sweep(roundId);
        uint256[] storage ids = _eligibleTicketIds[roundId];
        for (uint8 prizeIndex = 0; prizeIndex < DRAW_COUNT; ++prizeIndex) {
            uint256 candidate = _unbiasedCandidate(round.randomSeed, roundId, prizeIndex, ids.length);
            uint256 ticketId = ids[candidate];
            round.winnerTicketIds[prizeIndex] = ticketId;
            _tickets[ticketId].winningBitmap |= uint8(1 << prizeIndex);
            uint256 amount = prizeIndex < RON_PRIZE_COUNT ? round.config.ronPrizes[prizeIndex] : 0;
            emit WinnerAssigned(roundId, prizeIndex, ticketId, _tickets[ticketId].originalWallet, amount);
        }
        round.phase = Phase.WINNERS_ASSIGNED;
    }

    function settleRound(uint256 roundId) external nonReentrant {
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.WINNERS_ASSIGNED || round.settled) revert InvalidPhase();
        uint256 prizeTotal;
        for (uint8 i = 0; i < RON_PRIZE_COUNT; ++i) {
            prizeAmount[roundId][i] = round.config.ronPrizes[i];
            prizeTotal += round.config.ronPrizes[i];
        }
        if (round.directActive != round.config.ticketRon * round.config.capacity) revert Insolvent();
        uint256 treasuryRemainder = round.directActive - prizeTotal - round.config.nextDynoReserve;
        uint256 retainedMatt = mattActive[roundId];
        if (retainedMatt != round.config.ticketMatt * round.config.capacity || round.saleActive != 0) revert Insolvent();
        round.directActive = 0;
        mattActive[roundId] = 0;
        treasuryMattLiability[roundId] += retainedMatt;
        round.prizeLiability += prizeTotal;
        round.settled = true;
        round.phase = Phase.SETTLED;

        emit TreasuryMattAllocated(roundId, round.config.treasury, retainedMatt);
        bool reservePaid = _sendRon(round.config.treasury, round.config.nextDynoReserve);
        bool treasuryPaid = _sendRon(round.config.treasury, treasuryRemainder);
        if (!reservePaid) round.treasuryLiability += round.config.nextDynoReserve;
        if (!treasuryPaid) round.treasuryLiability += treasuryRemainder;
        emit NextDynoReserved(roundId, round.config.treasury, round.config.nextDynoReserve, reservePaid);
        emit TreasuryTransferred(roundId, round.config.treasury, treasuryRemainder, treasuryPaid);
        emit RoundSettled(roundId, prizeTotal, round.config.nextDynoReserve, treasuryRemainder, 0);
    }

    function attemptPrizePayout(uint256 roundId, uint8 prizeIndex) external onlyMultisig nonReentrant returns (bool) {
        if (claimsPaused) revert Paused();
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.SETTLED || prizeIndex >= RON_PRIZE_COUNT || prizePaid[roundId][prizeIndex]) revert InvalidClaim();
        uint256 ticketId = round.winnerTicketIds[prizeIndex];
        address receiver = _tickets[ticketId].originalWallet;
        return _payPrize(round, roundId, prizeIndex, ticketId, receiver);
    }

    function claimPrizeTo(uint256 roundId, uint8 prizeIndex, address receiver, uint64 expiry, bytes calldata signature) external nonReentrant {
        if (claimsPaused) revert Paused();
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.SETTLED || prizeIndex >= RON_PRIZE_COUNT || prizePaid[roundId][prizeIndex] || receiver == address(0) || expiry < block.timestamp) revert InvalidClaim();
        uint256 ticketId = round.winnerTicketIds[prizeIndex];
        address beneficiary = _tickets[ticketId].originalWallet;
        uint256 nonce = claimNonce[beneficiary]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, PRIZE_KIND, uint256(keccak256(abi.encode(roundId, prizeIndex))), receiver, nonce, expiry)));
        if (!SignatureChecker.isValidSignatureNow(beneficiary, digest, signature)) revert InvalidClaim();
        if (!_payPrize(round, roundId, prizeIndex, ticketId, receiver)) revert TransferFailed();
    }

    function claimRefund(uint256 ticketId) external nonReentrant {
        Ticket storage ticket = _tickets[ticketId];
        if (msg.sender != ticket.originalWallet) revert Unauthorized();
        _claimRefund(ticket, ticket.originalWallet);
    }

    function claimRefundTo(uint256 ticketId, address receiver, uint64 expiry, bytes calldata signature) external nonReentrant {
        Ticket storage ticket = _tickets[ticketId];
        if (receiver == address(0) || expiry < block.timestamp) revert InvalidClaim();
        uint256 nonce = claimNonce[ticket.originalWallet]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, REFUND_KIND, ticketId, receiver, nonce, expiry)));
        if (!SignatureChecker.isValidSignatureNow(ticket.originalWallet, digest, signature)) revert InvalidClaim();
        _claimRefund(ticket, receiver);
    }

    function cancelRound(uint256 roundId, bytes32 reasonCode) external onlyMultisig {
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.DRAFT && round.phase != Phase.OPEN && round.phase != Phase.REVIEW && round.phase != Phase.FROZEN) revert InvalidPhase();
        round.phase = Phase.CANCELLED;
        round.cancellationCursor = round.firstTicketId;
        uint256 unusedOperations = round.operationsBalance;
        if (unusedOperations != 0) {
            round.operationsBalance = 0;
            round.treasuryLiability += unusedOperations;
            emit TreasuryTransferred(roundId, round.config.treasury, unusedOperations, false);
        }
        emit RoundCancelled(roundId, reasonCode, msg.sender);
    }

    function processCancellationRefunds(uint256 roundId, uint256 maxTickets) external {
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.CANCELLED || round.cancellationRefundsComplete || maxTickets == 0) revert InvalidPhase();
        uint256 cursor = round.cancellationCursor;
        uint256 end = round.lastTicketId;
        uint256 processed;
        while (cursor <= end && processed < maxTickets) {
            Ticket storage ticket = _tickets[cursor];
            if (ticket.roundId == roundId && ticket.status == TicketStatus.ELIGIBLE) {
                ticket.status = TicketStatus.CANCELLED_CREDITED;
                ticket.refundAmount = ticket.directRon;
                round.directActive -= ticket.directRon;
                mattActive[roundId] -= round.config.ticketMatt;
                mattRefundLiability[roundId] += round.config.ticketMatt;
                ticketRefundMatt[cursor] = round.config.ticketMatt;
                round.refundLiability += ticket.refundAmount;
                emit RefundCredited(roundId, cursor, ticket.originalWallet, ticket.refundAmount);
                emit MattRefundCredited(roundId, cursor, ticket.originalWallet, round.config.ticketMatt);
            }
            cursor += 1;
            processed += 1;
        }
        round.cancellationCursor = cursor;
        if (cursor > end) round.cancellationRefundsComplete = true;
        emit CancellationProgress(roundId, cursor, round.cancellationRefundsComplete);
    }

    /// @notice Reports evidence only. Ronin cannot verify an Ethereum receipt; this is never a PrizePaid event.
    function reportManualNftDelivery(uint256 roundId, bytes32 transactionHash) external onlyMultisig {
        Round storage round = _rounds[roundId];
        if (round.phase != Phase.SETTLED || transactionHash == bytes32(0)) revert InvalidPhase();
        bytes32 previous = reportedNftDelivery[roundId];
        if (previous == transactionHash) revert InvalidClaim();
        reportedNftDelivery[roundId] = transactionHash;
        emit NFTDeliveryReported(roundId, transactionHash, previous, _tickets[round.winnerTicketIds[5]].originalWallet, msg.sender);
    }

    function claimTreasuryLiability(uint256 roundId) external nonReentrant {
        Round storage round = _rounds[roundId];
        if (msg.sender != round.config.treasury || round.treasuryLiability == 0) revert Unauthorized();
        uint256 amount = round.treasuryLiability;
        round.treasuryLiability = 0;
        if (!_sendRon(msg.sender, amount)) {
            round.treasuryLiability = amount;
            revert TransferFailed();
        }
        emit TreasuryLiabilityClaimed(roundId, msg.sender, amount);
    }

    /// @notice The multisig claims only eligible MATT after settlement; refund MATT remains segregated.
    function claimTreasuryMatt(uint256 roundId) external nonReentrant {
        Round storage round = _rounds[roundId];
        if (msg.sender != round.config.treasury || round.phase != Phase.SETTLED) revert Unauthorized();
        uint256 amount = treasuryMattLiability[roundId];
        if (amount == 0) revert InvalidClaim();
        treasuryMattLiability[roundId] = 0;
        _sendMattExact(round.config.matt, msg.sender, amount);
        emit TreasuryMattClaimed(roundId, msg.sender, amount);
    }

    function relinkIdentity(bytes32 accountCommitment, address newWallet, uint32 expectedVersion, uint64 expiry, bytes calldata newWalletSignature) external onlyMultisig {
        address oldWallet = walletForAccount[accountCommitment];
        if (oldWallet == address(0) || newWallet == address(0) || accountForWallet[newWallet] != bytes32(0) || identityVersion[accountCommitment] != expectedVersion || expiry < block.timestamp) revert InvalidConfiguration();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RELINK_TYPEHASH, accountCommitment, newWallet, expectedVersion, expiry)));
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, newWalletSignature)) revert InvalidClaim();
        delete accountForWallet[oldWallet];
        walletForAccount[accountCommitment] = newWallet;
        accountForWallet[newWallet] = accountCommitment;
        uint32 version = ++identityVersion[accountCommitment];
        emit IdentityRelinked(accountCommitment, oldWallet, newWallet, version);
    }

    function setAccountSuspended(bytes32 accountCommitment, bool suspended) external onlyMultisig {
        accountSuspended[accountCommitment] = suspended;
    }

    function rotateIdentitySigner(address newSigner) external onlyMultisig {
        if (newSigner == address(0)) revert InvalidConfiguration();
        address oldSigner = identitySigner;
        identitySigner = newSigner;
        emit SignerChanged(oldSigner, newSigner, msg.sender);
    }

    function setSubsystemPaused(bytes32 subsystem, bool paused) external onlyMultisig {
        if (subsystem == keccak256("CHECKOUT")) checkoutPaused = paused;
        else if (subsystem == keccak256("REVIEW")) reviewPaused = paused;
        else if (subsystem == keccak256("CLAIMS")) claimsPaused = paused;
        else revert InvalidConfiguration();
        emit SubsystemPauseChanged(subsystem, paused, msg.sender);
    }

    function getRoundStatus(uint256 roundId) external view returns (
        Phase phase,
        uint16 eligibleCount,
        uint64 reviewEndsAt,
        uint64 frozenAt,
        bytes32 snapshotDigest,
        uint256 directActive,
        uint256 saleActive,
        uint256 operationsBalance,
        uint256 refundLiability,
        uint256 prizeLiability,
        uint256 treasuryLiability
    ) {
        Round storage round = _rounds[roundId];
        return (
            round.phase, round.eligibleCount, round.reviewEndsAt, round.frozenAt, round.snapshotDigest,
            round.directActive, round.saleActive, round.operationsBalance, round.refundLiability,
            round.prizeLiability, round.treasuryLiability
        );
    }

    function getRoundTerms(uint256 roundId) external view returns (
        address matt, uint256 ticketRon, uint256 ticketMatt, uint16 capacity, uint256[5] memory ronPrizes,
        uint256 nextDynoReserve, uint256 nftTokenId, bytes32 termsHash, bytes32 configHash
    ) {
        Round storage round = _rounds[roundId];
        if (round.phase == Phase.NONE) revert InvalidPhase();
        return (
            round.config.matt, round.config.ticketRon, round.config.ticketMatt, round.config.capacity,
            round.config.ronPrizes, round.config.nextDynoReserve, round.config.nftTokenId,
            round.config.termsHash, round.configHash
        );
    }

    function getTicket(uint256 ticketId) external view returns (
        uint256 roundId,
        address originalWallet,
        bytes32 accountCommitment,
        uint64 purchasedAt,
        uint64 dayIndex,
        uint256 directRon,
        uint256 saleRon,
        uint16 eligibleIndex,
        TicketStatus status,
        uint256 refundAmount,
        uint8 winningBitmap
    ) {
        Ticket storage ticket = _tickets[ticketId];
        return (
            ticket.roundId, ticket.originalWallet, ticket.accountCommitment, ticket.purchasedAt, ticket.dayIndex,
            ticket.directRon, ticket.saleRon, ticket.eligibleIndex, ticket.status, ticket.refundAmount, ticket.winningBitmap
        );
    }
    function getEligibleTicketId(uint256 roundId, uint256 index) external view returns (uint256) { return _eligibleTicketIds[roundId][index]; }
    function getWinnerTicketId(uint256 roundId, uint8 prizeIndex) external view returns (uint256) {
        if (prizeIndex >= DRAW_COUNT) revert InvalidClaim();
        return _rounds[roundId].winnerTicketIds[prizeIndex];
    }
    function getNftPrize(uint256 roundId) external view returns (uint256 chainId, address collection, uint256 tokenId, address depositor, address winner) {
        Round storage round = _rounds[roundId];
        return (nftPrizeChainId[roundId], round.config.nftCollection, round.config.nftTokenId, round.config.nftDepositor, _tickets[round.winnerTicketIds[5]].originalWallet);
    }
    function getFlagCounts(uint256 roundId) external view returns (uint32 pending, uint32 upheld) {
        Round storage round = _rounds[roundId];
        return (round.pendingFlags, round.upheldFlags);
    }

    function _recordTicket(Round storage round, PurchaseVoucher calldata voucher, uint256 saleRon) internal {
        uint256 ticketId = nextTicketId++;
        uint16 index = round.eligibleCount;
        _eligibleTicketIds[voucher.roundId].push(ticketId);
        _tickets[ticketId] = Ticket({
            id: ticketId,
            roundId: voucher.roundId,
            originalWallet: voucher.wallet,
            accountCommitment: voucher.accountCommitment,
            purchasedAt: uint64(block.timestamp),
            dayIndex: voucher.dayIndex,
            directRon: round.config.ticketRon,
            saleRon: saleRon,
            eligibleIndex: index,
            status: TicketStatus.ELIGIBLE,
            refundAmount: 0,
            reasonCode: bytes32(0),
            evidenceHash: bytes32(0),
            winningBitmap: 0
        });
        round.eligibleCount += 1;
        round.saleActive += saleRon;
        round.lastTicketId = ticketId;
        emit TicketPurchased(voucher.roundId, ticketId, voucher.wallet, voucher.accountCommitment, voucher.dayIndex, round.config.ticketRon, saleRon);
    }

    function _removeEligible(Ticket storage ticket, Round storage round) internal {
        uint256[] storage ids = _eligibleTicketIds[ticket.roundId];
        uint256 index = ticket.eligibleIndex;
        uint256 lastId = ids[ids.length - 1];
        if (index != ids.length - 1) {
            ids[index] = lastId;
            _tickets[lastId].eligibleIndex = uint16(index);
        }
        ids.pop();
        round.eligibleCount -= 1;
    }

    function _bindIdentity(bytes32 accountCommitment, address wallet, uint32 voucherVersion) internal {
        uint32 version = identityVersion[accountCommitment];
        if (version == 0) {
            if (voucherVersion != 1 || walletForAccount[accountCommitment] != address(0) || accountForWallet[wallet] != bytes32(0)) revert InvalidVoucher();
            identityVersion[accountCommitment] = 1;
            walletForAccount[accountCommitment] = wallet;
            accountForWallet[wallet] = accountCommitment;
        } else if (voucherVersion != version || walletForAccount[accountCommitment] != wallet || accountForWallet[wallet] != accountCommitment) revert InvalidVoucher();
    }

    function _validPurchaseVoucher(PurchaseVoucher calldata voucher, bytes calldata signature) internal view returns (bool) {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            PURCHASE_TYPEHASH,
            voucher.roundId,
            voucher.accountCommitment,
            voucher.wallet,
            voucher.quantity,
            voucher.identityVersion,
            voucher.nonce,
            voucher.dayIndex,
            voucher.expiry
        )));
        return SignatureChecker.isValidSignatureNow(identitySigner, digest, signature);
    }

    function _unbiasedCandidate(uint256 seed, uint256 roundId, uint8 prizeIndex, uint256 count) internal view returns (uint256 selected) {
        uint256 limit = type(uint256).max - (type(uint256).max % count);
        for (uint256 counter = 0; ; ++counter) {
            uint256 candidate = uint256(keccak256(abi.encode(seed, block.chainid, address(this), roundId, prizeIndex, counter)));
            if (candidate < limit) return candidate % count;
        }
    }

    function _payPrize(Round storage round, uint256 roundId, uint8 prizeIndex, uint256 ticketId, address receiver) internal returns (bool) {
        if (prizeIndex < RON_PRIZE_COUNT) {
            uint256 amount = prizeAmount[roundId][prizeIndex];
            if (_sendRon(receiver, amount)) {
                prizePaid[roundId][prizeIndex] = true;
                round.prizeLiability -= amount;
                emit PrizePaid(roundId, prizeIndex, ticketId, receiver, amount, false);
                return true;
            }
            emit PrizePaymentFailed(roundId, prizeIndex, ticketId, receiver, keccak256("RON_TRANSFER_FAILED"));
            return false;
        }
        revert InvalidClaim();
    }

    function _claimRefund(Ticket storage ticket, address receiver) internal {
        if (claimsPaused) revert Paused();
        if (ticket.status != TicketStatus.REFUND_CREDITED && ticket.status != TicketStatus.CANCELLED_CREDITED) revert InvalidClaim();
        Round storage round = _rounds[ticket.roundId];
        uint256 amount = ticket.refundAmount;
        uint256 mattAmount = ticketRefundMatt[ticket.id];
        if (mattAmount == 0) revert InvalidClaim();
        TicketStatus paidStatus = ticket.status == TicketStatus.REFUND_CREDITED ? TicketStatus.REFUND_PAID : TicketStatus.CANCELLED_PAID;
        ticket.status = paidStatus;
        refundPaid[ticket.id] = true;
        round.refundLiability -= amount;
        ticketRefundMatt[ticket.id] = 0;
        mattRefundLiability[ticket.roundId] -= mattAmount;
        _sendMattExact(round.config.matt, receiver, mattAmount);
        if (!_sendRon(receiver, amount)) {
            revert TransferFailed();
        }
        emit RefundPaid(ticket.roundId, ticket.id, receiver, amount);
        emit MattRefundPaid(ticket.roundId, ticket.id, receiver, mattAmount);
    }

    function _validateConfig(RoundConfig calldata config) internal view {
        if (
            config.matt == address(0) || config.nftCollection == address(0) || config.nftDepositor == address(0) ||
            config.treasury == address(0) || config.swapAdapter != address(0) || config.priceGuard != address(0) ||
            config.vrfCoordinator == address(0) || config.ticketRon == 0 || config.ticketMatt == 0 || config.capacity != 1_000 ||
            config.reviewDuration < MIN_REVIEW_DURATION || config.saleSlippageBps != 0 ||
            config.buybackSlippageBps != 0 || config.vrfCallbackGasLimit == 0 || config.vrfGasPrice == 0 ||
            config.termsHash == bytes32(0)
        ) revert InvalidConfiguration();
        uint256 total;
        for (uint256 i = 0; i < RON_PRIZE_COUNT; ++i) {
            if (config.ronPrizes[i] == 0 || (i > 0 && config.ronPrizes[i] <= config.ronPrizes[i - 1])) revert InvalidConfiguration();
            total += config.ronPrizes[i];
        }
        if (total + config.nextDynoReserve > config.ticketRon * config.capacity) revert InvalidConfiguration();
        if (config.matt.code.length == 0 || config.vrfCoordinator.code.length == 0) revert InvalidConfiguration();
    }

    function _sendRon(address receiver, uint256 amount) internal returns (bool ok) {
        (ok,) = payable(receiver).call{value: amount}("");
    }

    function _sendMattExact(address matt, address receiver, uint256 amount) internal {
        IERC20 token = IERC20(matt);
        uint256 beforeBalance = token.balanceOf(receiver);
        token.safeTransfer(receiver, amount);
        if (token.balanceOf(receiver) - beforeBalance != amount) revert InvalidConfiguration();
    }

    // Unsolicited/forced RON is never classified as ticket, sale or VRF revenue.
    receive() external payable {}

    function setReviewer(address account, bool enabled) external onlyMultisig {
        reviewer[account] = enabled;
        emit ReviewerUpdated(account, enabled, msg.sender);
    }

    function isAdmin(address account) public view returns (bool) {
        return account != address(0) && (account == multisig || account == emergencyAdmin);
    }

    /// @notice Immediate rotation/revocation by either admin. Zero revokes emergency authority.
    /// @dev Vault and bound price guard derive this same address; no stale duplicate grants.
    function setEmergencyAdmin(address account) external onlyMultisig {
        if (account == multisig || account == address(buybackVault) || account == address(this)) revert InvalidConfiguration();
        emit EmergencyAdminChanged(emergencyAdmin, account, msg.sender);
        emergencyAdmin = account;
    }

    function setVrfRefundReceiver(address receiver) external onlyMultisig {
        if (receiver.code.length == 0 || ProjectDynoVRFRefundReceiver(payable(receiver)).manager() != address(this)) revert InvalidConfiguration();
        emit VrfRefundReceiverChanged(vrfRefundReceiver, receiver, msg.sender);
        vrfRefundReceiver = receiver;
    }

    function _authorizeUpgrade(address) internal override onlyMultisig {}

    uint256[19] private __gap;
}
