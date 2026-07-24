// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRoninVRFCoordinatorForPlinkoV4 {
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

/// @title MATT Plinko V4
/// @notice Sixteen-row, batch-play Plinko using one Ronin VRF request for 1–100 MATT coins.
/// @dev A coin always costs 10,000 MATT. Multipliers include returned principal.
///      Slot outcomes are packed into two storage words (five bits per coin) to keep
///      a 100-coin settlement compact and inexpensive.
contract MattPlinkoV4 is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MULTIPLIER_SCALE = 10_000;
    uint256 public constant MAX_MULTIPLIER = 500_000; // 50x
    uint256 public constant RTP_NUMERATOR = 643_563_520;
    uint256 public constant RTP_DENOMINATOR = 655_360_000;
    uint256 public constant COIN_PRICE = 10_000 ether;
    uint256 public constant CALLBACK_GAS_LIMIT = 420_000;
    uint256 public constant STALE_REQUEST_DELAY = 2 hours;
    uint8 public constant ROWS = 16;
    uint8 public constant SLOT_COUNT = ROWS + 1;
    uint8 public constant MIN_BATCH_SIZE = 1;
    uint8 public constant MAX_BATCH_SIZE = 100;
    uint8 private constant SLOTS_IN_FIRST_WORD = 51;
    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_SETTLED = 2;
    uint8 private constant STATUS_REFUNDED = 3;

    struct Batch {
        address player;
        uint96 wager;
        uint64 openedAt;
        uint8 coinCount;
        uint8 status;
        uint256 payout;
        uint256 packedSlotsA;
        uint256 packedSlotsB;
    }

    IERC20 public immutable matt;
    IRoninVRFCoordinatorForPlinkoV4 public immutable vrfCoordinator;
    address public immutable treasury;

    uint256 public lockedWagers;
    uint256 public reservedLiability;
    uint256 public totalClaimable;
    uint256 public totalBatches;
    uint256 public totalSettledBatches;
    uint256 public totalCoinsPurchased;
    uint256 public totalCoinsSettled;
    uint256 public totalWagered;
    uint256 public totalPaid;

    mapping(bytes32 requestHash => Batch batch) public batches;
    mapping(address player => uint256 amount) public claimable;

    event BankrollFunded(address indexed treasury, uint256 amount);
    event BankrollWithdrawn(address indexed treasury, uint256 amount);
    event BatchRequested(
        bytes32 indexed requestHash,
        address indexed player,
        uint8 coinCount,
        uint256 wager
    );
    event BatchSettled(
        bytes32 indexed requestHash,
        address indexed player,
        uint8 coinCount,
        uint256 payout,
        uint256 packedSlotsA,
        uint256 packedSlotsB
    );
    event BatchRefunded(bytes32 indexed requestHash, address indexed player, uint256 wager);
    event LateFulfillmentIgnored(bytes32 indexed requestHash);
    event PlayerWithdrawal(address indexed player, uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidBatchSize();
    error InvalidRequest();
    error RequestAlreadySettled();
    error RequestNotStale();
    error BatchNotSettled();
    error InvalidSlot();
    error InvalidCoinIndex();
    error InsufficientBankroll();
    error InvalidAmount();
    error OnlyCoordinatorCanFulfill();
    error MattLocked();

    constructor(address mattToken, address treasuryAddress, address coordinatorAddress)
        Ownable(treasuryAddress)
    {
        if (
            mattToken == address(0)
                || treasuryAddress == address(0)
                || coordinatorAddress == address(0)
        ) revert InvalidAddress();

        matt = IERC20(mattToken);
        treasury = treasuryAddress;
        vrfCoordinator = IRoninVRFCoordinatorForPlinkoV4(coordinatorAddress);
        _pause();
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert Unauthorized();
        _;
    }

    function purchaseBatch(uint8 coinCount)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (bytes32 requestHash)
    {
        if (coinCount < MIN_BATCH_SIZE || coinCount > MAX_BATCH_SIZE) {
            revert InvalidBatchSize();
        }

        uint256 wager = batchPrice(coinCount);
        uint256 additionalLiability = maxAdditionalLiability(coinCount);
        if (unreservedBankroll() < additionalLiability) revert InsufficientBankroll();

        matt.safeTransferFrom(msg.sender, address(this), wager);
        lockedWagers += wager;
        reservedLiability += additionalLiability;

        requestHash = vrfCoordinator.requestRandomSeed{value: msg.value}(
            CALLBACK_GAS_LIMIT,
            fulfillmentGasPrice(),
            address(this),
            msg.sender
        );
        if (requestHash == bytes32(0) || batches[requestHash].player != address(0)) {
            revert InvalidRequest();
        }

        batches[requestHash] = Batch({
            player: msg.sender,
            wager: uint96(wager),
            openedAt: uint64(block.timestamp),
            coinCount: coinCount,
            status: STATUS_PENDING,
            payout: 0,
            packedSlotsA: 0,
            packedSlotsB: 0
        });

        totalBatches += 1;
        totalCoinsPurchased += coinCount;
        totalWagered += wager;
        emit BatchRequested(requestHash, msg.sender, coinCount, wager);
    }

    function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert OnlyCoordinatorCanFulfill();

        Batch storage batch = batches[requestHash];
        if (batch.player == address(0)) revert InvalidRequest();
        if (batch.status == STATUS_REFUNDED) {
            emit LateFulfillmentIgnored(requestHash);
            return;
        }
        if (batch.status != STATUS_PENDING) revert RequestAlreadySettled();

        uint8 count = batch.coinCount;
        uint256 payout;
        uint256 packedA;
        uint256 packedB;

        for (uint8 coinIndex = 0; coinIndex < count; coinIndex++) {
            uint256 coinRandomness =
                uint256(keccak256(abi.encode(randomSeed, requestHash, batch.player, coinIndex)));
            uint8 slot = slotFromSeed(coinRandomness);
            payout += COIN_PRICE * multiplierForSlot(slot) / MULTIPLIER_SCALE;

            if (coinIndex < SLOTS_IN_FIRST_WORD) {
                packedA |= uint256(slot) << (uint256(coinIndex) * 5);
            } else {
                packedB |= uint256(slot) << (uint256(coinIndex - SLOTS_IN_FIRST_WORD) * 5);
            }
        }

        uint256 wager = uint256(batch.wager);
        lockedWagers -= wager;
        reservedLiability -= maxAdditionalLiability(count);

        batch.status = STATUS_SETTLED;
        batch.payout = payout;
        batch.packedSlotsA = packedA;
        batch.packedSlotsB = packedB;

        claimable[batch.player] += payout;
        totalClaimable += payout;
        totalSettledBatches += 1;
        totalCoinsSettled += count;
        totalPaid += payout;

        emit BatchSettled(requestHash, batch.player, count, payout, packedA, packedB);
    }

    function refundStaleBatch(bytes32 requestHash) external nonReentrant {
        Batch storage batch = batches[requestHash];
        if (batch.player == address(0)) revert InvalidRequest();
        if (batch.status != STATUS_PENDING) revert RequestAlreadySettled();
        if (msg.sender != batch.player && msg.sender != owner()) revert Unauthorized();
        if (block.timestamp < uint256(batch.openedAt) + STALE_REQUEST_DELAY) {
            revert RequestNotStale();
        }

        uint256 wager = uint256(batch.wager);
        lockedWagers -= wager;
        reservedLiability -= maxAdditionalLiability(batch.coinCount);
        batch.status = STATUS_REFUNDED;
        batch.payout = wager;

        claimable[batch.player] += wager;
        totalClaimable += wager;
        emit BatchRefunded(requestHash, batch.player, wager);
    }

    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert InvalidAmount();

        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        matt.safeTransfer(msg.sender, amount);
        emit PlayerWithdrawal(msg.sender, amount);
    }

    function fundBankroll(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0) revert InvalidAmount();
        matt.safeTransferFrom(msg.sender, address(this), amount);
        emit BankrollFunded(msg.sender, amount);
    }

    function withdrawBankroll(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0 || amount > unreservedBankroll()) revert InsufficientBankroll();
        matt.safeTransfer(treasury, amount);
        emit BankrollWithdrawn(treasury, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function quoteRandomFee() external view returns (uint256) {
        return vrfCoordinator.estimateRequestRandomFee(CALLBACK_GAS_LIMIT, fulfillmentGasPrice());
    }

    function fulfillmentGasPrice() public view returns (uint256) {
        return 20 gwei + block.basefee * 2;
    }

    function batchPrice(uint8 coinCount) public pure returns (uint256) {
        if (coinCount < MIN_BATCH_SIZE || coinCount > MAX_BATCH_SIZE) {
            revert InvalidBatchSize();
        }
        return uint256(coinCount) * COIN_PRICE;
    }

    function maxPayout(uint8 coinCount) public pure returns (uint256) {
        return batchPrice(coinCount) * MAX_MULTIPLIER / MULTIPLIER_SCALE;
    }

    function maxAdditionalLiability(uint8 coinCount) public pure returns (uint256) {
        uint256 wager = batchPrice(coinCount);
        return wager * (MAX_MULTIPLIER - MULTIPLIER_SCALE) / MULTIPLIER_SCALE;
    }

    function slotFromSeed(uint256 randomSeed) public pure returns (uint8) {
        uint256 bits = randomSeed & 0xffff;
        bits = bits - ((bits >> 1) & 0x5555);
        bits = (bits & 0x3333) + ((bits >> 2) & 0x3333);
        bits = (bits + (bits >> 4)) & 0x0f0f;
        bits = bits + (bits >> 8);
        return uint8(bits & 0x1f);
    }

    /// @notice Board RTP is exactly 98.2%.
    /// 50x, 25x, 10.0174x, 5x, 2x, 1.5x, .8x, .7x, .4848x,
    /// .7x, .8x, 1.5x, 2x, 5x, 10.0174x, 25x, 50x.
    function multiplierForSlot(uint8 slot) public pure returns (uint256) {
        if (slot >= SLOT_COUNT) revert InvalidSlot();
        if (slot == 0 || slot == 16) return 500_000;
        if (slot == 1 || slot == 15) return 250_000;
        if (slot == 2 || slot == 14) return 100_174;
        if (slot == 3 || slot == 13) return 50_000;
        if (slot == 4 || slot == 12) return 20_000;
        if (slot == 5 || slot == 11) return 15_000;
        if (slot == 6 || slot == 10) return 8_000;
        if (slot == 7 || slot == 9) return 7_000;
        return 4_848;
    }

    function slotAt(bytes32 requestHash, uint8 coinIndex) public view returns (uint8) {
        Batch storage batch = batches[requestHash];
        if (batch.status != STATUS_SETTLED) revert BatchNotSettled();
        if (coinIndex >= batch.coinCount) revert InvalidCoinIndex();

        if (coinIndex < SLOTS_IN_FIRST_WORD) {
            return uint8((batch.packedSlotsA >> (uint256(coinIndex) * 5)) & 0x1f);
        }
        return uint8(
            (batch.packedSlotsB >> (uint256(coinIndex - SLOTS_IN_FIRST_WORD) * 5)) & 0x1f
        );
    }

    function batchSlots(bytes32 requestHash) external view returns (uint8[] memory slots) {
        Batch storage batch = batches[requestHash];
        if (batch.status != STATUS_SETTLED) revert BatchNotSettled();

        slots = new uint8[](batch.coinCount);
        for (uint8 i = 0; i < batch.coinCount; i++) {
            if (i < SLOTS_IN_FIRST_WORD) {
                slots[i] = uint8((batch.packedSlotsA >> (uint256(i) * 5)) & 0x1f);
            } else {
                slots[i] = uint8(
                    (batch.packedSlotsB >> (uint256(i - SLOTS_IN_FIRST_WORD) * 5)) & 0x1f
                );
            }
        }
    }

    function protectedBalance() public view returns (uint256) {
        return lockedWagers + totalClaimable;
    }

    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        uint256 protected = protectedBalance();
        return balance > protected ? balance - protected : 0;
    }

    function unreservedBankroll() public view returns (uint256) {
        uint256 available = availableBankroll();
        return available > reservedLiability ? available - reservedLiability : 0;
    }

    function isSolvent() external view returns (bool) {
        return matt.balanceOf(address(this)) >= protectedBalance() + reservedLiability;
    }

    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(matt)) revert MattLocked();
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
