// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC20Burnable is IERC20 {
    function burn(uint256 amount) external;
}

contract MattCrashVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant HOUSE_EDGE_BPS = 100;
    uint256 private constant HASH_SPACE = 1 << 52;
    bytes32 private constant CRASH_DOMAIN = keccak256("MATT-CRASH-V2");

    struct Round {
        bytes32 commitment;
        uint64 bettingClosesAt;
        uint32 crashPointBps;
        bool revealed;
    }

    struct Wager {
        address player;
        bytes32 roundId;
        uint128 amount;
        uint64 openedAt;
        bool settled;
    }

    IERC20Burnable public immutable matt;
    address public immutable treasury;
    address public rewardsWallet;
    address public settlementOperator;

    uint256 public minWager;
    uint256 public maxWager;
    uint256 public maxCashoutBps;
    uint256 public refundDelay;
    uint256 public burnBps;
    uint256 public rewardsBps;

    uint256 public lockedWagers;
    uint256 public reservedProfit;
    uint256 public totalClaimable;
    uint256 public totalBurned;
    uint256 public totalRewardsSent;
    uint256 public totalTreasuryFunded;
    uint256 public totalTreasuryWithdrawn;

    mapping(bytes32 => Round) public rounds;
    mapping(bytes32 => Wager) public wagers;
    mapping(address => uint256) public claimable;

    event SettlementOperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event RewardsWalletUpdated(address indexed previousWallet, address indexed newWallet);
    event LimitsUpdated(uint256 minWager, uint256 maxWager, uint256 maxCashoutBps);
    event LossAllocationUpdated(uint256 burnBps, uint256 rewardsBps);
    event RefundDelayUpdated(uint256 previousDelay, uint256 newDelay);
    event BankrollFunded(address indexed treasury, uint256 amount);
    event BankrollWithdrawn(address indexed treasury, uint256 amount);
    event RoundCommitted(bytes32 indexed roundId, bytes32 indexed commitment, uint256 bettingClosesAt);
    event RoundRevealed(bytes32 indexed roundId, bytes32 seed, uint256 crashPointBps);
    event WagerOpened(bytes32 indexed wagerId, bytes32 indexed roundId, address indexed player, uint256 amount);
    event WagerSettled(bytes32 indexed wagerId, address indexed player, uint256 cashoutBps, uint256 payout, uint256 burned, uint256 rewards);
    event WagerRefunded(bytes32 indexed wagerId, address indexed player, uint256 amount);
    event PlayerWithdrawal(address indexed player, uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRound();
    error RoundAlreadyExists();
    error RoundNotOpen();
    error RoundNotRevealed();
    error InvalidReveal();
    error WagerAlreadyExists();
    error WagerNotOpen();
    error InvalidCashout();
    error InsufficientBankroll();
    error RefundNotAvailable();

    constructor(
        address mattToken,
        address treasuryAddress,
        address operatorAddress,
        address rewardsAddress
    ) Ownable(treasuryAddress) {
        if (
            mattToken == address(0) ||
            treasuryAddress == address(0) ||
            operatorAddress == address(0) ||
            rewardsAddress == address(0)
        ) revert InvalidAddress();

        matt = IERC20Burnable(mattToken);
        treasury = treasuryAddress;
        settlementOperator = operatorAddress;
        rewardsWallet = rewardsAddress;

        minWager = 10_000 ether;
        maxWager = 10_000_000 ether;
        maxCashoutBps = 100 * BPS;
        refundDelay = 2 hours;
        burnBps = 1_000;
        rewardsBps = 500;
        _pause();
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != settlementOperator) revert Unauthorized();
        _;
    }

    function setSettlementOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address previous = settlementOperator;
        settlementOperator = newOperator;
        emit SettlementOperatorUpdated(previous, newOperator);
    }

    function setRewardsWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert InvalidAddress();
        address previous = rewardsWallet;
        rewardsWallet = newWallet;
        emit RewardsWalletUpdated(previous, newWallet);
    }

    function setLimits(uint256 newMinWager, uint256 newMaxWager, uint256 newMaxCashoutBps) external onlyOwner {
        if (
            newMinWager == 0 ||
            newMaxWager < newMinWager ||
            newMaxCashoutBps < BPS ||
            newMaxCashoutBps > 1_000 * BPS
        ) revert InvalidAmount();
        minWager = newMinWager;
        maxWager = newMaxWager;
        maxCashoutBps = newMaxCashoutBps;
        emit LimitsUpdated(newMinWager, newMaxWager, newMaxCashoutBps);
    }

    function setLossAllocation(uint256 newBurnBps, uint256 newRewardsBps) external onlyOwner {
        if (newBurnBps + newRewardsBps > 5_000) revert InvalidAmount();
        burnBps = newBurnBps;
        rewardsBps = newRewardsBps;
        emit LossAllocationUpdated(newBurnBps, newRewardsBps);
    }

    function setRefundDelay(uint256 newDelay) external onlyOwner {
        if (newDelay < 15 minutes || newDelay > 7 days) revert InvalidAmount();
        uint256 previous = refundDelay;
        refundDelay = newDelay;
        emit RefundDelayUpdated(previous, newDelay);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function fundBankroll(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0) revert InvalidAmount();
        IERC20(address(matt)).safeTransferFrom(msg.sender, address(this), amount);
        totalTreasuryFunded += amount;
        emit BankrollFunded(msg.sender, amount);
    }

    function withdrawBankroll(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0 || amount > unreservedBankroll()) revert InsufficientBankroll();
        totalTreasuryWithdrawn += amount;
        IERC20(address(matt)).safeTransfer(treasury, amount);
        emit BankrollWithdrawn(treasury, amount);
    }

    function commitRound(bytes32 roundId, bytes32 commitment, uint256 bettingClosesAt) external onlyOperator whenNotPaused {
        if (roundId == bytes32(0) || commitment == bytes32(0)) revert InvalidRound();
        if (rounds[roundId].commitment != bytes32(0)) revert RoundAlreadyExists();
        if (bettingClosesAt <= block.timestamp || bettingClosesAt > block.timestamp + 1 hours) revert InvalidRound();
        rounds[roundId] = Round(commitment, uint64(bettingClosesAt), 0, false);
        emit RoundCommitted(roundId, commitment, bettingClosesAt);
    }

    function revealRound(bytes32 roundId, bytes32 seed) external onlyOperator whenNotPaused returns (uint256 crashPointBps) {
        Round storage round = rounds[roundId];
        if (round.commitment == bytes32(0) || round.revealed) revert InvalidRound();
        if (block.timestamp < round.bettingClosesAt) revert RoundNotOpen();
        if (keccak256(abi.encodePacked(seed)) != round.commitment) revert InvalidReveal();

        crashPointBps = calculateCrashPointBps(seed, roundId);
        round.crashPointBps = uint32(crashPointBps);
        round.revealed = true;
        emit RoundRevealed(roundId, seed, crashPointBps);
    }

    function openWager(bytes32 roundId, uint256 amount) external whenNotPaused nonReentrant returns (bytes32 wagerId) {
        Round storage round = rounds[roundId];
        if (round.commitment == bytes32(0) || round.revealed || block.timestamp >= round.bettingClosesAt) revert RoundNotOpen();
        if (amount < minWager || amount > maxWager || amount > type(uint128).max) revert InvalidAmount();

        wagerId = keccak256(abi.encodePacked(block.chainid, address(this), roundId, msg.sender));
        if (wagers[wagerId].player != address(0)) revert WagerAlreadyExists();

        uint256 maxProfit = profitFor(amount, maxCashoutBps);
        if (unreservedBankroll() < maxProfit) revert InsufficientBankroll();

        IERC20(address(matt)).safeTransferFrom(msg.sender, address(this), amount);
        wagers[wagerId] = Wager(msg.sender, roundId, uint128(amount), uint64(block.timestamp), false);
        lockedWagers += amount;
        reservedProfit += maxProfit;
        emit WagerOpened(wagerId, roundId, msg.sender, amount);
    }

    function settleWager(bytes32 wagerId, uint256 cashoutBps) external onlyOperator whenNotPaused nonReentrant {
        _settleWager(wagerId, cashoutBps);
    }

    function settleWagers(bytes32[] calldata wagerIds, uint256[] calldata cashoutBpsValues) external onlyOperator whenNotPaused nonReentrant {
        if (wagerIds.length == 0 || wagerIds.length != cashoutBpsValues.length || wagerIds.length > 100) revert InvalidAmount();
        for (uint256 i = 0; i < wagerIds.length; ++i) {
            _settleWager(wagerIds[i], cashoutBpsValues[i]);
        }
    }

    function _settleWager(bytes32 wagerId, uint256 cashoutBps) internal {
        Wager storage wager = wagers[wagerId];
        if (wager.player == address(0) || wager.settled) revert WagerNotOpen();

        Round storage round = rounds[wager.roundId];
        if (!round.revealed) revert RoundNotRevealed();
        if (cashoutBps != 0 && (cashoutBps < BPS || cashoutBps >= round.crashPointBps || cashoutBps > maxCashoutBps)) {
            revert InvalidCashout();
        }

        wager.settled = true;
        uint256 amount = uint256(wager.amount);
        lockedWagers -= amount;
        reservedProfit -= profitFor(amount, maxCashoutBps);

        uint256 payout;
        uint256 burned;
        uint256 rewards;

        if (cashoutBps == 0) {
            burned = (amount * burnBps) / BPS;
            rewards = (amount * rewardsBps) / BPS;
            if (burned != 0) {
                matt.burn(burned);
                totalBurned += burned;
            }
            if (rewards != 0) {
                IERC20(address(matt)).safeTransfer(rewardsWallet, rewards);
                totalRewardsSent += rewards;
            }
        } else {
            payout = (amount * cashoutBps) / BPS;
            claimable[wager.player] += payout;
            totalClaimable += payout;
        }

        emit WagerSettled(wagerId, wager.player, cashoutBps, payout, burned, rewards);
    }

    function refundExpiredWager(bytes32 wagerId) external nonReentrant {
        Wager storage wager = wagers[wagerId];
        if (wager.player == address(0) || wager.settled) revert WagerNotOpen();
        if (msg.sender != wager.player && msg.sender != owner()) revert Unauthorized();

        Round storage round = rounds[wager.roundId];
        uint256 refundableAt = uint256(round.bettingClosesAt) + refundDelay;
        if (!paused() && block.timestamp < refundableAt) revert RefundNotAvailable();

        wager.settled = true;
        uint256 amount = uint256(wager.amount);
        lockedWagers -= amount;
        reservedProfit -= profitFor(amount, maxCashoutBps);
        claimable[wager.player] += amount;
        totalClaimable += amount;
        emit WagerRefunded(wagerId, wager.player, amount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert InvalidAmount();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        IERC20(address(matt)).safeTransfer(msg.sender, amount);
        emit PlayerWithdrawal(msg.sender, amount);
    }

    function calculateCrashPointBps(bytes32 seed, bytes32 roundId) public pure returns (uint256) {
        uint256 hashValue = uint256(keccak256(abi.encodePacked(seed, roundId, CRASH_DOMAIN)));
        uint256 h = hashValue >> 204;
        uint256 denominator = HASH_SPACE - h;
        uint256 result = ((BPS - HOUSE_EDGE_BPS) * HASH_SPACE) / denominator;
        if (result < BPS) return BPS;
        if (result > 1_000 * BPS) return 1_000 * BPS;
        return result;
    }

    function profitFor(uint256 wagerAmount, uint256 cashoutBps) public pure returns (uint256) {
        if (cashoutBps <= BPS) return 0;
        return (wagerAmount * (cashoutBps - BPS)) / BPS;
    }

    function protectedBalance() public view returns (uint256) {
        return lockedWagers + totalClaimable;
    }

    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        uint256 protectedTokens = protectedBalance();
        return balance > protectedTokens ? balance - protectedTokens : 0;
    }

    function unreservedBankroll() public view returns (uint256) {
        uint256 available = availableBankroll();
        return available > reservedProfit ? available - reservedProfit : 0;
    }

    function isSolvent() external view returns (bool) {
        return matt.balanceOf(address(this)) >= protectedBalance() + reservedProfit;
    }
}
