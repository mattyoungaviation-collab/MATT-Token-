// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IRoninVRFCoordinatorForMattSlots {
    function requestRandomSeed(
        uint256 callbackGasLimit,
        uint256 gasPrice,
        address consumer,
        address refundAddress
    ) external payable returns (bytes32 requestHash);

    function estimateRequestRandomFee(uint256 callbackGasLimit, uint256 gasPrice)
        external
        view
        returns (uint256);
}

interface IMattSlotsRewardVault {
    function reservePaid(
        uint256 spinId,
        address recipient,
        uint256 principal,
        uint256 maximumPayout
    ) external;

    function settlePaid(
        uint256 spinId,
        uint256 payout,
        uint256 bonusSessionId,
        bool carryBonusLiability
    ) external;

    function settleBonus(
        uint256 spinId,
        uint256 sessionId,
        uint256 payout,
        bool sessionComplete
    ) external;

    function cancelPaid(uint256 spinId) external;
    function forfeitBonusSession(uint256 sessionId, address recipient) external;
    function availableBankroll() external view returns (uint256);
    function claimable(address recipient) external view returns (uint256);
    function pendingTreasuryLoss() external view returns (uint256);
}

/// @title MATT Slots V1 — Resource Rush
/// @notice Five-reel, three-row, twenty-payline MATT slots with prepaid spin credits,
///         one Ronin VRF request per click, onchain reel grids, and onchain payouts.
/// @dev Every paid spin reserves the complete 500x session cap before randomness is
///      requested. Triggered free spins inherit that reservation and the root wager.
contract MattSlotsV1 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MULTIPLIER_BPS = 5_000_000; // 500x
    uint256 public constant CALLBACK_GAS_LIMIT = 1_000_000;
    uint256 public constant STALE_REQUEST_DELAY = 2 hours;
    uint256 public constant MATH_CONFIG_DELAY = 24 hours;
    uint8 public constant REELS = 5;
    uint8 public constant ROWS = 3;
    uint8 public constant PAYLINES = 20;
    uint8 public constant SYMBOL_COUNT = 10;
    uint8 public constant WILD_SYMBOL = 8;
    uint8 public constant SCATTER_SYMBOL = 9;
    uint8 public constant MIN_SPINS_PER_PURCHASE = 1;
    uint8 public constant MAX_SPINS_PER_PURCHASE = 25;
    uint8 public constant MAX_BONUS_SPINS = 50;

    uint8 private constant CREDIT_PAID = 1;
    uint8 private constant CREDIT_BONUS = 2;
    uint8 private constant SPIN_PENDING = 1;
    uint8 private constant SPIN_SETTLED = 2;
    uint8 private constant SPIN_REFUNDED = 3;
    uint8 private constant NO_WILD_REEL = type(uint8).max;

    // Each payline uses two bits per reel and ten bits total. Twenty lines fit in 200 bits.
    uint256 private constant PACKED_PAYLINES =
        0x2a22222165516661111964656151a94041aa4246192aa00155;

    struct MathConfig {
        uint256[5] reels;
        uint32[30] linePaysBps;
        uint32[3] scatterPaysBps;
        uint8[3] bonusAwards;
        uint16 declaredRtpBps;
        uint64 activatesAt;
        bool exists;
    }

    struct CreditBatch {
        uint96 wager;
        uint32 remaining;
        uint32 purchased;
        uint32 mathVersion;
        uint64 purchasedAt;
    }

    struct BonusSession {
        address player;
        uint96 wager;
        uint32 remaining;
        uint32 totalAwarded;
        uint32 totalPlayed;
        uint32 mathVersion;
        uint64 rootSpinId;
        uint256 totalPayout;
        bool completed;
    }

    struct Spin {
        address player;
        uint96 wager;
        uint64 requestedAt;
        uint64 previousPlayerSpinId;
        uint32 mathVersion;
        uint32 creditIndex;
        uint8 creditType;
        uint8 status;
        uint8 wildReel;
        uint8 scatterCount;
        uint8 freeSpinsAwarded;
        uint32 winningLinesMask;
        uint64 packedGrid;
        uint256 sessionId;
        uint256 payout;
        uint256 treasuryLoss;
        bytes32 requestHash;
    }

    IERC20 public immutable matt;
    IMattSlotsRewardVault public immutable rewardVault;
    IRoninVRFCoordinatorForMattSlots public immutable vrfCoordinator;

    uint256 public minBet = 500 ether;
    uint256 public maxBet = 50_000 ether;
    uint256 public nextSpinId = 1;
    uint256 public nextSessionId = 1;
    uint32 public activeMathVersion = 1;
    uint32 public pendingMathVersion;
    uint32 public latestMathVersion = 1;

    uint256 public totalCreditEscrow;
    uint256 public totalSpinsPurchased;
    uint256 public totalPaidSpinsPlayed;
    uint256 public totalBonusSpinsPlayed;
    uint256 public totalWagered;
    uint256 public totalPaid;
    uint256 public totalTreasuryLoss;

    mapping(uint32 version => MathConfig config) private mathConfigs;
    mapping(address player => CreditBatch[] batches) private paidBatches;
    mapping(uint256 sessionId => BonusSession session) public bonusSessions;
    mapping(address player => uint256[] sessionIds) private playerBonusSessions;
    mapping(uint256 spinId => Spin spin) public spins;
    mapping(bytes32 requestHash => uint256 spinId) public requestToSpin;
    mapping(address player => uint256 spinId) public activeSpinOf;
    mapping(address player => uint256 spinId) public lastSpinOf;

    event BetLimitsChanged(
        uint256 previousMinimum,
        uint256 newMinimum,
        uint256 previousMaximum,
        uint256 newMaximum
    );
    event MathConfigProposed(uint32 indexed version, uint64 activatesAt, bytes32 configHash);
    event MathConfigActivated(uint32 indexed version, uint16 declaredRtpBps);
    event MathConfigCancelled(uint32 indexed version);
    event SpinsPurchased(
        address indexed player,
        uint256 indexed batchIndex,
        uint32 indexed mathVersion,
        uint256 wagerPerSpin,
        uint8 quantity,
        uint256 totalCost
    );
    event PaidSpinsRefunded(
        address indexed player,
        uint256 indexed batchIndex,
        uint8 quantity,
        uint256 amount
    );
    event SpinRequested(
        uint256 indexed spinId,
        bytes32 indexed requestHash,
        address indexed player,
        uint8 creditType,
        uint256 creditIndex,
        uint32 mathVersion,
        uint256 wager,
        uint256 maximumSessionPayout
    );
    event SpinSettled(
        uint256 indexed spinId,
        bytes32 indexed requestHash,
        address indexed player,
        uint8 creditType,
        uint256 sessionId,
        uint32 mathVersion,
        uint64 packedGrid,
        uint32 winningLinesMask,
        uint8 scatterCount,
        uint8 wildReel,
        uint8 freeSpinsAwarded,
        uint256 wager,
        uint256 payout,
        uint256 treasuryLoss
    );
    event BonusSessionCreated(
        uint256 indexed sessionId,
        address indexed player,
        uint256 indexed rootSpinId,
        uint32 mathVersion,
        uint256 wager,
        uint8 freeSpins,
        uint256 rootPayout,
        uint256 maximumSessionPayout
    );
    event BonusSessionCompleted(
        uint256 indexed sessionId,
        address indexed player,
        uint256 totalPayout,
        uint32 spinsPlayed,
        bool maximumWinReached
    );
    event BonusSessionForfeited(
        uint256 indexed sessionId,
        address indexed player,
        uint32 freeSpinsSurrendered
    );
    event StaleSpinRefunded(uint256 indexed spinId, address indexed player, uint8 creditType);
    event LateFulfillmentIgnored(bytes32 indexed requestHash, uint256 indexed spinId);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidBetLimits();
    error InvalidQuantity();
    error InvalidBatch();
    error InvalidSession();
    error InvalidSpin();
    error InvalidMathConfiguration();
    error MathConfigurationNotReady();
    error PendingMathConfigurationExists();
    error ActiveSpinExists(uint256 spinId);
    error NoActiveCredit();
    error InsufficientBankroll(uint256 availableMaximumBet, uint256 requestedBet);
    error OnlyCoordinatorCanFulfill();
    error RequestNotStale();
    error UnsupportedToken();
    error MattLocked(uint256 protectedAmount);

    constructor(
        address mattToken,
        address rewardVaultAddress,
        address coordinatorAddress,
        address initialOwner,
        uint256[5] memory initialReels,
        uint32[30] memory initialLinePaysBps,
        uint32[3] memory initialScatterPaysBps,
        uint8[3] memory initialBonusAwards,
        uint16 initialDeclaredRtpBps
    ) Ownable(initialOwner) {
        if (
            mattToken == address(0) || rewardVaultAddress == address(0)
                || coordinatorAddress == address(0) || initialOwner == address(0)
        ) revert InvalidAddress();
        if (rewardVaultAddress.code.length == 0 || coordinatorAddress.code.length == 0) {
            revert InvalidAddress();
        }

        matt = IERC20(mattToken);
        rewardVault = IMattSlotsRewardVault(rewardVaultAddress);
        vrfCoordinator = IRoninVRFCoordinatorForMattSlots(coordinatorAddress);
        matt.forceApprove(rewardVaultAddress, type(uint256).max);

        _validateMathConfiguration(
            initialReels,
            initialLinePaysBps,
            initialScatterPaysBps,
            initialBonusAwards,
            initialDeclaredRtpBps
        );
        _storeMathConfiguration(
            1,
            initialReels,
            initialLinePaysBps,
            initialScatterPaysBps,
            initialBonusAwards,
            initialDeclaredRtpBps,
            uint64(block.timestamp)
        );
        _pause();
        emit MathConfigActivated(1, initialDeclaredRtpBps);
    }

    function buySpins(uint256 wagerPerSpin, uint8 quantity)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 batchIndex)
    {
        if (
            wagerPerSpin < minBet || wagerPerSpin > maxBet
                || wagerPerSpin > type(uint96).max
        ) revert InvalidAmount();
        if (quantity < MIN_SPINS_PER_PURCHASE || quantity > MAX_SPINS_PER_PURCHASE) {
            revert InvalidQuantity();
        }
        uint256 playable = currentPlayableMaxBet();
        if (wagerPerSpin > playable) {
            revert InsufficientBankroll(playable, wagerPerSpin);
        }

        uint256 totalCost = wagerPerSpin * quantity;
        uint256 beforeBalance = matt.balanceOf(address(this));
        matt.safeTransferFrom(msg.sender, address(this), totalCost);
        if (matt.balanceOf(address(this)) - beforeBalance != totalCost) {
            revert InvalidAmount();
        }

        batchIndex = paidBatches[msg.sender].length;
        paidBatches[msg.sender].push(CreditBatch({
            wager: uint96(wagerPerSpin),
            remaining: quantity,
            purchased: quantity,
            mathVersion: activeMathVersion,
            purchasedAt: uint64(block.timestamp)
        }));
        totalCreditEscrow += totalCost;
        totalSpinsPurchased += quantity;

        emit SpinsPurchased(
            msg.sender,
            batchIndex,
            activeMathVersion,
            wagerPerSpin,
            quantity,
            totalCost
        );
    }

    /// @notice One click consumes exactly one prepaid credit and requests one fresh VRF seed.
    function playPaid(uint256 batchIndex)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 spinId, bytes32 requestHash)
    {
        _requireNoActiveSpin(msg.sender);
        if (batchIndex >= paidBatches[msg.sender].length) revert InvalidBatch();
        CreditBatch storage batch = paidBatches[msg.sender][batchIndex];
        if (batch.remaining == 0) revert NoActiveCredit();

        uint256 playable = bankrollSupportedMaxBet();
        if (uint256(batch.wager) > playable) {
            revert InsufficientBankroll(playable, uint256(batch.wager));
        }

        batch.remaining -= 1;
        uint256 wager = uint256(batch.wager);
        totalCreditEscrow -= wager;
        totalPaidSpinsPlayed += 1;
        totalWagered += wager;

        spinId = _createSpin(
            msg.sender,
            wager,
            batch.mathVersion,
            uint32(batchIndex),
            CREDIT_PAID,
            0
        );
        uint256 maximumPayout = maxSessionPayout(wager);
        rewardVault.reservePaid(spinId, msg.sender, wager, maximumPayout);
        requestHash = _requestRandomness(spinId);

        emit SpinRequested(
            spinId,
            requestHash,
            msg.sender,
            CREDIT_PAID,
            batchIndex,
            batch.mathVersion,
            wager,
            maximumPayout
        );
    }

    function playBonus(uint256 sessionId)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 spinId, bytes32 requestHash)
    {
        _requireNoActiveSpin(msg.sender);
        BonusSession storage session = bonusSessions[sessionId];
        if (
            session.player != msg.sender || session.completed || session.remaining == 0
        ) revert InvalidSession();

        session.remaining -= 1;
        session.totalPlayed += 1;
        totalBonusSpinsPlayed += 1;

        spinId = _createSpin(
            msg.sender,
            uint256(session.wager),
            session.mathVersion,
            0,
            CREDIT_BONUS,
            sessionId
        );
        requestHash = _requestRandomness(spinId);

        emit SpinRequested(
            spinId,
            requestHash,
            msg.sender,
            CREDIT_BONUS,
            sessionId,
            session.mathVersion,
            uint256(session.wager),
            maxSessionPayout(uint256(session.wager))
        );
    }

    function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed)
        external
        nonReentrant
    {
        if (msg.sender != address(vrfCoordinator)) revert OnlyCoordinatorCanFulfill();
        uint256 spinId = requestToSpin[requestHash];
        if (spinId == 0) revert InvalidSpin();
        Spin storage spin = spins[spinId];
        if (spin.status == SPIN_REFUNDED) {
            emit LateFulfillmentIgnored(requestHash, spinId);
            return;
        }
        if (spin.status != SPIN_PENDING) revert InvalidSpin();

        bool isBonus = spin.creditType == CREDIT_BONUS;
        (uint64 packedGrid, uint8 wildReel) = _generateGrid(
            randomSeed,
            requestHash,
            spinId,
            spin.mathVersion,
            isBonus
        );
        (
            uint256 multiplierBps,
            uint32 winningLinesMask,
            uint8 scatterCount,
            uint8 paidBonusAward
        ) = _evaluateGrid(spin.mathVersion, packedGrid);

        uint256 maximumPayout = maxSessionPayout(uint256(spin.wager));
        uint256 payout = Math.mulDiv(uint256(spin.wager), multiplierBps, BPS);
        uint8 freeSpinsAwarded;
        uint256 sessionId = spin.sessionId;
        bool sessionComplete;

        if (!isBonus) {
            if (payout > maximumPayout) payout = maximumPayout;
            if (paidBonusAward != 0 && payout < maximumPayout) {
                sessionId = nextSessionId++;
                freeSpinsAwarded = paidBonusAward > MAX_BONUS_SPINS
                    ? MAX_BONUS_SPINS
                    : paidBonusAward;
                bonusSessions[sessionId] = BonusSession({
                    player: spin.player,
                    wager: spin.wager,
                    remaining: freeSpinsAwarded,
                    totalAwarded: freeSpinsAwarded,
                    totalPlayed: 0,
                    mathVersion: spin.mathVersion,
                    rootSpinId: uint64(spinId),
                    totalPayout: payout,
                    completed: false
                });
                playerBonusSessions[spin.player].push(sessionId);
                emit BonusSessionCreated(
                    sessionId,
                    spin.player,
                    spinId,
                    spin.mathVersion,
                    uint256(spin.wager),
                    freeSpinsAwarded,
                    payout,
                    maximumPayout
                );
            }
        } else {
            BonusSession storage session = bonusSessions[sessionId];
            if (session.player != spin.player || session.completed) revert InvalidSession();
            uint256 remainingCap = maximumPayout - session.totalPayout;
            if (payout > remainingCap) payout = remainingCap;
            session.totalPayout += payout;

            if (
                scatterCount >= 3 && session.totalAwarded < MAX_BONUS_SPINS
                    && session.totalPayout < maximumPayout
            ) {
                uint8 retrigger = _retriggerAward(scatterCount);
                uint32 room = uint32(MAX_BONUS_SPINS) - session.totalAwarded;
                if (retrigger > room) retrigger = uint8(room);
                session.remaining += retrigger;
                session.totalAwarded += retrigger;
                freeSpinsAwarded = retrigger;
            }

            bool maximumReached = session.totalPayout >= maximumPayout;
            if (maximumReached) session.remaining = 0;
            sessionComplete = maximumReached || session.remaining == 0;
            if (sessionComplete) {
                session.completed = true;
                emit BonusSessionCompleted(
                    sessionId,
                    spin.player,
                    session.totalPayout,
                    session.totalPlayed,
                    maximumReached
                );
            }
        }

        uint256 treasuryLoss = !isBonus && uint256(spin.wager) > payout
            ? uint256(spin.wager) - payout
            : 0;

        spin.status = SPIN_SETTLED;
        spin.packedGrid = packedGrid;
        spin.winningLinesMask = winningLinesMask;
        spin.scatterCount = scatterCount;
        spin.wildReel = wildReel;
        spin.freeSpinsAwarded = freeSpinsAwarded;
        spin.sessionId = sessionId;
        spin.payout = payout;
        spin.treasuryLoss = treasuryLoss;
        activeSpinOf[spin.player] = 0;

        if (!isBonus) {
            rewardVault.settlePaid(spinId, payout, sessionId, sessionId != 0);
        } else {
            rewardVault.settleBonus(spinId, sessionId, payout, sessionComplete);
        }

        totalPaid += payout;
        totalTreasuryLoss += treasuryLoss;
        emit SpinSettled(
            spinId,
            requestHash,
            spin.player,
            spin.creditType,
            sessionId,
            spin.mathVersion,
            packedGrid,
            winningLinesMask,
            scatterCount,
            wildReel,
            freeSpinsAwarded,
            uint256(spin.wager),
            payout,
            treasuryLoss
        );
    }

    function refundStaleSpin(uint256 spinId) external nonReentrant {
        Spin storage spin = spins[spinId];
        if (spin.status != SPIN_PENDING) revert InvalidSpin();
        if (msg.sender != spin.player && msg.sender != owner()) revert Unauthorized();
        if (block.timestamp < uint256(spin.requestedAt) + STALE_REQUEST_DELAY) {
            revert RequestNotStale();
        }

        spin.status = SPIN_REFUNDED;
        if (activeSpinOf[spin.player] == spinId) activeSpinOf[spin.player] = 0;

        if (spin.creditType == CREDIT_PAID) {
            rewardVault.cancelPaid(spinId);
            CreditBatch storage batch = paidBatches[spin.player][spin.creditIndex];
            batch.remaining += 1;
            totalCreditEscrow += uint256(spin.wager);
            totalPaidSpinsPlayed -= 1;
            totalWagered -= uint256(spin.wager);
        } else if (spin.creditType == CREDIT_BONUS) {
            BonusSession storage session = bonusSessions[spin.sessionId];
            if (session.completed) revert InvalidSession();
            session.remaining += 1;
            session.totalPlayed -= 1;
            totalBonusSpinsPlayed -= 1;
        } else {
            revert InvalidSpin();
        }

        emit StaleSpinRefunded(spinId, spin.player, spin.creditType);
    }

    /// @notice Unused paid credits are redeemable for their original MATT value at any time.
    function refundPaidSpins(uint256 batchIndex, uint8 quantity) external nonReentrant {
        if (batchIndex >= paidBatches[msg.sender].length) revert InvalidBatch();
        CreditBatch storage batch = paidBatches[msg.sender][batchIndex];
        if (quantity == 0 || quantity > batch.remaining) revert InvalidQuantity();
        batch.remaining -= quantity;
        uint256 amount = uint256(batch.wager) * quantity;
        totalCreditEscrow -= amount;
        matt.safeTransfer(msg.sender, amount);
        emit PaidSpinsRefunded(msg.sender, batchIndex, quantity, amount);
    }

    function forfeitBonusSession(uint256 sessionId) external nonReentrant {
        BonusSession storage session = bonusSessions[sessionId];
        if (session.player != msg.sender || session.completed) revert InvalidSession();
        if (activeSpinOf[msg.sender] != 0) revert ActiveSpinExists(activeSpinOf[msg.sender]);
        uint32 surrendered = session.remaining;
        session.remaining = 0;
        session.completed = true;
        rewardVault.forfeitBonusSession(sessionId, msg.sender);
        emit BonusSessionForfeited(sessionId, msg.sender, surrendered);
        emit BonusSessionCompleted(
            sessionId,
            msg.sender,
            session.totalPayout,
            session.totalPlayed,
            false
        );
    }

    function setBetLimits(uint256 newMinimum, uint256 newMaximum) external onlyOwner {
        if (
            newMinimum == 0 || newMaximum < newMinimum
                || newMaximum > type(uint96).max
        ) revert InvalidBetLimits();
        uint256 previousMinimum = minBet;
        uint256 previousMaximum = maxBet;
        minBet = newMinimum;
        maxBet = newMaximum;
        emit BetLimitsChanged(
            previousMinimum,
            newMinimum,
            previousMaximum,
            newMaximum
        );
    }

    function proposeMathConfiguration(
        uint256[5] calldata reels,
        uint32[30] calldata linePaysBps,
        uint32[3] calldata scatterPaysBps,
        uint8[3] calldata bonusAwards,
        uint16 declaredRtpBps
    ) external onlyOwner whenPaused returns (uint32 version) {
        if (pendingMathVersion != 0) revert PendingMathConfigurationExists();
        _validateMathConfiguration(
            reels,
            linePaysBps,
            scatterPaysBps,
            bonusAwards,
            declaredRtpBps
        );
        version = ++latestMathVersion;
        uint64 activatesAt = uint64(block.timestamp + MATH_CONFIG_DELAY);
        _storeMathConfiguration(
            version,
            reels,
            linePaysBps,
            scatterPaysBps,
            bonusAwards,
            declaredRtpBps,
            activatesAt
        );
        pendingMathVersion = version;
        emit MathConfigProposed(
            version,
            activatesAt,
            keccak256(abi.encode(reels, linePaysBps, scatterPaysBps, bonusAwards, declaredRtpBps))
        );
    }

    function activateMathConfiguration(uint32 version) external onlyOwner whenPaused {
        if (version == 0 || version != pendingMathVersion) {
            revert InvalidMathConfiguration();
        }
        MathConfig storage config = mathConfigs[version];
        if (!config.exists || block.timestamp < config.activatesAt) {
            revert MathConfigurationNotReady();
        }
        activeMathVersion = version;
        pendingMathVersion = 0;
        emit MathConfigActivated(version, config.declaredRtpBps);
    }

    function cancelPendingMathConfiguration() external onlyOwner whenPaused {
        uint32 version = pendingMathVersion;
        if (version == 0) revert InvalidMathConfiguration();
        pendingMathVersion = 0;
        emit MathConfigCancelled(version);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        if (currentPlayableMaxBet() < minBet) {
            revert InsufficientBankroll(currentPlayableMaxBet(), minBet);
        }
        _unpause();
    }

    function quoteRandomFee() external view returns (uint256) {
        return vrfCoordinator.estimateRequestRandomFee(
            CALLBACK_GAS_LIMIT,
            fulfillmentGasPrice()
        );
    }

    function fulfillmentGasPrice() public view returns (uint256) {
        return 20 gwei + block.basefee * 2;
    }

    function maxSessionPayout(uint256 wager) public pure returns (uint256) {
        return Math.mulDiv(wager, MAX_MULTIPLIER_BPS, BPS);
    }

    function bankrollSupportedMaxBet() public view returns (uint256) {
        return Math.mulDiv(
            rewardVault.availableBankroll(),
            BPS,
            MAX_MULTIPLIER_BPS
        );
    }

    function currentPlayableMaxBet() public view returns (uint256) {
        uint256 bankrollSupported = bankrollSupportedMaxBet();
        return bankrollSupported < maxBet ? bankrollSupported : maxBet;
    }

    function paidBatchCount(address player) external view returns (uint256) {
        return paidBatches[player].length;
    }

    function paidBatchAt(address player, uint256 batchIndex)
        external
        view
        returns (CreditBatch memory)
    {
        if (batchIndex >= paidBatches[player].length) revert InvalidBatch();
        return paidBatches[player][batchIndex];
    }

    function playerBonusSessionCount(address player) external view returns (uint256) {
        return playerBonusSessions[player].length;
    }

    function playerBonusSessionIdAt(address player, uint256 index)
        external
        view
        returns (uint256)
    {
        if (index >= playerBonusSessions[player].length) revert InvalidSession();
        return playerBonusSessions[player][index];
    }

    function getSpinGrid(uint256 spinId) external view returns (uint8[15] memory grid) {
        Spin storage spin = spins[spinId];
        if (spin.status != SPIN_SETTLED) revert InvalidSpin();
        for (uint8 position = 0; position < 15; position++) {
            grid[position] = uint8((uint256(spin.packedGrid) >> (position * 4)) & 0x0f);
        }
    }

    function symbolAt(uint64 packedGrid, uint8 reel, uint8 row)
        public
        pure
        returns (uint8)
    {
        if (reel >= REELS || row >= ROWS) revert InvalidAmount();
        uint8 position = reel * ROWS + row;
        return uint8((uint256(packedGrid) >> (position * 4)) & 0x0f);
    }

    function getPayline(uint8 line) external pure returns (uint8[5] memory rows) {
        if (line >= PAYLINES) revert InvalidAmount();
        for (uint8 reel = 0; reel < REELS; reel++) {
            rows[reel] = _lineRow(line, reel);
        }
    }

    function getMathConfiguration(uint32 version)
        external
        view
        returns (
            uint256[5] memory reels,
            uint32[30] memory linePaysBps,
            uint32[3] memory scatterPaysBps,
            uint8[3] memory bonusAwards,
            uint16 declaredRtpBps,
            uint64 activatesAt,
            bool exists
        )
    {
        MathConfig storage config = mathConfigs[version];
        return (
            config.reels,
            config.linePaysBps,
            config.scatterPaysBps,
            config.bonusAwards,
            config.declaredRtpBps,
            config.activatesAt,
            config.exists
        );
    }

    function previewGrid(uint32 mathVersion, uint64 packedGrid)
        external
        view
        returns (
            uint256 multiplierBps,
            uint32 winningLinesMask,
            uint8 scatterCount,
            uint8 paidBonusAward
        )
    {
        return _evaluateGrid(mathVersion, packedGrid);
    }

    function recoverUnsupportedToken(address token, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(matt)) revert UnsupportedToken();
        if (token == address(0) || amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(owner(), amount);
    }

    function withdrawExcessMatt(uint256 amount) external onlyOwner whenPaused nonReentrant {
        uint256 balance = matt.balanceOf(address(this));
        uint256 excess = balance > totalCreditEscrow ? balance - totalCreditEscrow : 0;
        if (amount == 0 || amount > excess) revert MattLocked(totalCreditEscrow);
        matt.safeTransfer(owner(), amount);
    }

    function _createSpin(
        address player,
        uint256 wager,
        uint32 mathVersion,
        uint32 creditIndex,
        uint8 creditType,
        uint256 sessionId
    ) internal returns (uint256 spinId) {
        if (!mathConfigs[mathVersion].exists) revert InvalidMathConfiguration();
        spinId = nextSpinId++;
        uint256 previous = lastSpinOf[player];
        spins[spinId] = Spin({
            player: player,
            wager: uint96(wager),
            requestedAt: uint64(block.timestamp),
            previousPlayerSpinId: uint64(previous),
            mathVersion: mathVersion,
            creditIndex: creditIndex,
            creditType: creditType,
            status: SPIN_PENDING,
            wildReel: NO_WILD_REEL,
            scatterCount: 0,
            freeSpinsAwarded: 0,
            winningLinesMask: 0,
            packedGrid: 0,
            sessionId: sessionId,
            payout: 0,
            treasuryLoss: 0,
            requestHash: bytes32(0)
        });
        lastSpinOf[player] = spinId;
        activeSpinOf[player] = spinId;
    }

    function _requestRandomness(uint256 spinId) internal returns (bytes32 requestHash) {
        Spin storage spin = spins[spinId];
        requestHash = vrfCoordinator.requestRandomSeed{value: msg.value}(
            CALLBACK_GAS_LIMIT,
            fulfillmentGasPrice(),
            address(this),
            spin.player
        );
        if (requestHash == bytes32(0) || requestToSpin[requestHash] != 0) {
            revert InvalidSpin();
        }
        spin.requestHash = requestHash;
        requestToSpin[requestHash] = spinId;
    }

    function _generateGrid(
        uint256 randomSeed,
        bytes32 requestHash,
        uint256 spinId,
        uint32 mathVersion,
        bool bonus
    ) internal view returns (uint64 packedGrid, uint8 wildReel) {
        MathConfig storage config = mathConfigs[mathVersion];
        if (!config.exists) revert InvalidMathConfiguration();
        wildReel = bonus
            ? uint8(uint256(keccak256(abi.encode(randomSeed, requestHash, spinId, "WILD_REEL"))) % REELS)
            : NO_WILD_REEL;

        for (uint8 reel = 0; reel < REELS; reel++) {
            uint8 stop = uint8(
                uint256(keccak256(abi.encode(randomSeed, requestHash, spinId, reel))) & 63
            );
            for (uint8 row = 0; row < ROWS; row++) {
                uint8 symbol = reel == wildReel
                    ? WILD_SYMBOL
                    : _stripSymbol(config.reels[reel], uint8((stop + row) & 63));
                uint8 position = reel * ROWS + row;
                packedGrid |= uint64(symbol) << (position * 4);
            }
        }
    }

    function _evaluateGrid(uint32 mathVersion, uint64 packedGrid)
        internal
        view
        returns (
            uint256 multiplierBps,
            uint32 winningLinesMask,
            uint8 scatterCount,
            uint8 paidBonusAward
        )
    {
        MathConfig storage config = mathConfigs[mathVersion];
        if (!config.exists) revert InvalidMathConfiguration();

        for (uint8 line = 0; line < PAYLINES; line++) {
            uint256 lineWin = _lineWin(config, packedGrid, line);
            if (lineWin != 0) {
                multiplierBps += lineWin;
                winningLinesMask |= uint32(1) << line;
            }
        }

        for (uint8 reel = 0; reel < REELS; reel++) {
            for (uint8 row = 0; row < ROWS; row++) {
                if (symbolAt(packedGrid, reel, row) == SCATTER_SYMBOL) {
                    scatterCount += 1;
                }
            }
        }
        if (scatterCount >= 3) {
            uint8 index = scatterCount >= 5 ? 2 : scatterCount - 3;
            multiplierBps += config.scatterPaysBps[index];
            paidBonusAward = config.bonusAwards[index];
        }
        if (multiplierBps > MAX_MULTIPLIER_BPS) {
            multiplierBps = MAX_MULTIPLIER_BPS;
        }
    }

    function _lineWin(MathConfig storage config, uint64 packedGrid, uint8 line)
        internal
        view
        returns (uint256)
    {
        uint8 first = symbolAt(packedGrid, 0, _lineRow(line, 0));
        if (first == SCATTER_SYMBOL) return 0;

        uint8 target = WILD_SYMBOL;
        for (uint8 reel = 0; reel < REELS; reel++) {
            uint8 symbol = symbolAt(packedGrid, reel, _lineRow(line, reel));
            if (symbol == SCATTER_SYMBOL) break;
            if (symbol != WILD_SYMBOL) {
                target = symbol;
                break;
            }
        }

        uint8 count;
        for (uint8 reel = 0; reel < REELS; reel++) {
            uint8 symbol = symbolAt(packedGrid, reel, _lineRow(line, reel));
            if (symbol == SCATTER_SYMBOL) break;
            if (symbol == target || symbol == WILD_SYMBOL) count += 1;
            else break;
        }
        if (count < 3 || target >= SCATTER_SYMBOL) return 0;
        uint256 payIndex = uint256(target) * 3 + (count - 3);
        return config.linePaysBps[payIndex];
    }

    function _lineRow(uint8 line, uint8 reel) internal pure returns (uint8) {
        return uint8((PACKED_PAYLINES >> (uint256(line) * 10 + uint256(reel) * 2)) & 3);
    }

    function _stripSymbol(uint256 packedReel, uint8 index) internal pure returns (uint8) {
        return uint8((packedReel >> (uint256(index) * 4)) & 0x0f);
    }

    function _retriggerAward(uint8 scatterCount) internal pure returns (uint8) {
        if (scatterCount >= 5) return 12;
        if (scatterCount == 4) return 8;
        return 5;
    }

    function _requireNoActiveSpin(address player) internal view {
        uint256 active = activeSpinOf[player];
        if (active != 0) revert ActiveSpinExists(active);
    }

    function _validateMathConfiguration(
        uint256[5] memory reels,
        uint32[30] memory linePaysBps,
        uint32[3] memory scatterPaysBps,
        uint8[3] memory bonusAwards,
        uint16 declaredRtpBps
    ) internal pure {
        if (declaredRtpBps < 8_000 || declaredRtpBps > 10_000) {
            revert InvalidMathConfiguration();
        }
        for (uint8 reel = 0; reel < REELS; reel++) {
            uint8 scatterSymbols;
            uint8 wildSymbols;
            for (uint8 index = 0; index < 64; index++) {
                uint8 symbol = _stripSymbol(reels[reel], index);
                if (symbol >= SYMBOL_COUNT) revert InvalidMathConfiguration();
                if (symbol == SCATTER_SYMBOL) scatterSymbols += 1;
                if (symbol == WILD_SYMBOL) wildSymbols += 1;
            }
            if (
                scatterSymbols == 0 || scatterSymbols > 4
                    || wildSymbols == 0 || wildSymbols > 4
            ) revert InvalidMathConfiguration();
        }
        for (uint8 symbol = 0; symbol <= WILD_SYMBOL; symbol++) {
            uint256 offset = uint256(symbol) * 3;
            if (
                linePaysBps[offset] == 0
                    || linePaysBps[offset] > linePaysBps[offset + 1]
                    || linePaysBps[offset + 1] > linePaysBps[offset + 2]
            ) revert InvalidMathConfiguration();
        }
        if (
            scatterPaysBps[0] < BPS
                || scatterPaysBps[0] > scatterPaysBps[1]
                || scatterPaysBps[1] > scatterPaysBps[2]
                || bonusAwards[0] == 0
                || bonusAwards[0] > bonusAwards[1]
                || bonusAwards[1] > bonusAwards[2]
                || bonusAwards[2] > 25
        ) revert InvalidMathConfiguration();
    }

    function _storeMathConfiguration(
        uint32 version,
        uint256[5] memory reels,
        uint32[30] memory linePaysBps,
        uint32[3] memory scatterPaysBps,
        uint8[3] memory bonusAwards,
        uint16 declaredRtpBps,
        uint64 activatesAt
    ) internal {
        MathConfig storage config = mathConfigs[version];
        config.reels = reels;
        config.linePaysBps = linePaysBps;
        config.scatterPaysBps = scatterPaysBps;
        config.bonusAwards = bonusAwards;
        config.declaredRtpBps = declaredRtpBps;
        config.activatesAt = activatesAt;
        config.exists = true;
    }
}
