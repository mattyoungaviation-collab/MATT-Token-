// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRoninVRFCoordinatorForConsumers {
    function requestRandomSeed(
        uint256 callbackGasLimit,
        uint256 gasPrice,
        address consumer,
        address refundAddress
    ) external payable returns (bytes32 requestHash);

    function estimateRequestRandomFee(uint256 callbackGasLimit, uint256 gasPrice) external view returns (uint256);
}

/// @title MATT Plinko
/// @notice Fixed-risk Plinko for MATT using the official Ronin VRF coordinator.
/// @dev Multipliers include the returned principal. A 20x result on 100,000 MATT credits 2,000,000 MATT.
contract MattPlinko is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MULTIPLIER_SCALE = 100;
    uint256 public constant MAX_MULTIPLIER = 2_000; // 20x
    uint256 public constant CALLBACK_GAS_LIMIT = 350_000;
    uint256 public constant STALE_REQUEST_DELAY = 2 hours;
    uint8 public constant ROWS = 10;
    uint8 public constant SLOT_COUNT = ROWS + 1;

    struct Drop {
        address player;
        uint128 amount;
        uint64 openedAt;
        uint16 multiplier;
        uint8 slot;
        bool settled;
    }

    IERC20 public immutable matt;
    IRoninVRFCoordinatorForConsumers public immutable vrfCoordinator;
    address public immutable treasury;

    uint256 public lockedWagers;
    uint256 public reservedLiability;
    uint256 public totalClaimable;
    uint256 public totalTreasuryRouted;
    uint256 public totalDrops;
    uint256 public totalSettled;

    mapping(bytes32 requestHash => Drop drop) public drops;
    mapping(address player => uint256 amount) public claimable;

    event BankrollFunded(address indexed treasury, uint256 amount);
    event BankrollWithdrawn(address indexed treasury, uint256 amount);
    event DropRequested(bytes32 indexed requestHash, address indexed player, uint256 amount);
    event DropSettled(
        bytes32 indexed requestHash,
        address indexed player,
        uint8 slot,
        uint256 multiplier,
        uint256 payout,
        uint256 treasuryAmount
    );
    event DropRefunded(bytes32 indexed requestHash, address indexed player, uint256 amount);
    event PlayerWithdrawal(address indexed player, uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidBet();
    error InvalidRequest();
    error RequestAlreadySettled();
    error RequestNotStale();
    error InsufficientBankroll();
    error InvalidAmount();
    error OnlyCoordinatorCanFulfill();
    error MattLocked();

    constructor(address mattToken, address treasuryAddress, address coordinatorAddress)
        Ownable(treasuryAddress)
    {
        if (mattToken == address(0) || treasuryAddress == address(0) || coordinatorAddress == address(0)) {
            revert InvalidAddress();
        }
        matt = IERC20(mattToken);
        treasury = treasuryAddress;
        vrfCoordinator = IRoninVRFCoordinatorForConsumers(coordinatorAddress);
        _pause();
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert Unauthorized();
        _;
    }

    /// @notice Approve MATT first, then send the current Ronin VRF quote as msg.value.
    function play(uint256 amount) external payable whenNotPaused nonReentrant returns (bytes32 requestHash) {
        if (!isAllowedBet(amount)) revert InvalidBet();
        uint256 liability = maxAdditionalLiability(amount);
        if (unreservedBankroll() < liability) revert InsufficientBankroll();

        matt.safeTransferFrom(msg.sender, address(this), amount);
        lockedWagers += amount;
        reservedLiability += liability;

        requestHash = vrfCoordinator.requestRandomSeed{value: msg.value}(
            CALLBACK_GAS_LIMIT,
            fulfillmentGasPrice(),
            address(this),
            msg.sender
        );
        if (requestHash == bytes32(0) || drops[requestHash].player != address(0)) revert InvalidRequest();

        drops[requestHash] = Drop({
            player: msg.sender,
            amount: uint128(amount),
            openedAt: uint64(block.timestamp),
            multiplier: 0,
            slot: 0,
            settled: false
        });
        totalDrops += 1;
        emit DropRequested(requestHash, msg.sender, amount);
    }

    /// @notice Called only by the official Ronin VRF coordinator.
    function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert OnlyCoordinatorCanFulfill();
        Drop storage drop = drops[requestHash];
        if (drop.player == address(0)) revert InvalidRequest();
        if (drop.settled) revert RequestAlreadySettled();

        drop.settled = true;
        uint256 amount = uint256(drop.amount);
        lockedWagers -= amount;
        reservedLiability -= maxAdditionalLiability(amount);

        uint8 slot = slotFromSeed(randomSeed);
        uint256 multiplier = multiplierForSlot(slot);
        uint256 payout = amount * multiplier / MULTIPLIER_SCALE;
        uint256 treasuryAmount;

        drop.slot = slot;
        drop.multiplier = uint16(multiplier);
        claimable[drop.player] += payout;
        totalClaimable += payout;
        totalSettled += 1;

        if (multiplier < MULTIPLIER_SCALE) {
            treasuryAmount = amount;
            totalTreasuryRouted += amount;
            matt.safeTransfer(treasury, amount);
        }

        emit DropSettled(requestHash, drop.player, slot, multiplier, payout, treasuryAmount);
    }

    /// @notice Refunds the original wager if Ronin VRF never fulfills a request.
    function refundStaleDrop(bytes32 requestHash) external nonReentrant {
        Drop storage drop = drops[requestHash];
        if (drop.player == address(0)) revert InvalidRequest();
        if (drop.settled) revert RequestAlreadySettled();
        if (msg.sender != drop.player && msg.sender != owner()) revert Unauthorized();
        if (block.timestamp < uint256(drop.openedAt) + STALE_REQUEST_DELAY) revert RequestNotStale();

        drop.settled = true;
        uint256 amount = uint256(drop.amount);
        lockedWagers -= amount;
        reservedLiability -= maxAdditionalLiability(amount);
        claimable[drop.player] += amount;
        totalClaimable += amount;
        emit DropRefunded(requestHash, drop.player, amount);
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

    function isAllowedBet(uint256 amount) public pure returns (bool) {
        return amount == 10_000 ether
            || amount == 25_000 ether
            || amount == 50_000 ether
            || amount == 75_000 ether
            || amount == 100_000 ether;
    }

    /// @notice Returns a physical 10-row Plinko slot using ten independent bits from the VRF seed.
    function slotFromSeed(uint256 randomSeed) public pure returns (uint8 slot) {
        for (uint8 row = 0; row < ROWS; row++) {
            slot += uint8((randomSeed >> row) & 1);
        }
    }

    /// @notice Slot multipliers: 20x, 8x, 3x, 1.5x, .25x, .25x, .25x, 1.5x, 3x, 8x, 20x.
    function multiplierForSlot(uint8 slot) public pure returns (uint256) {
        if (slot > ROWS) revert InvalidAmount();
        if (slot == 0 || slot == 10) return 2_000;
        if (slot == 1 || slot == 9) return 800;
        if (slot == 2 || slot == 8) return 300;
        if (slot == 3 || slot == 7) return 150;
        return 25;
    }

    function maxPayout(uint256 amount) public pure returns (uint256) {
        return amount * MAX_MULTIPLIER / MULTIPLIER_SCALE;
    }

    function maxAdditionalLiability(uint256 amount) public pure returns (uint256) {
        return amount * (MAX_MULTIPLIER - MULTIPLIER_SCALE) / MULTIPLIER_SCALE;
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
