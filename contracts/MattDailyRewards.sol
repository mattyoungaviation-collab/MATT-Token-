// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMattCoinFlipRewardsSource {
    function bets(uint256 betId)
        external
        view
        returns (
            address player,
            uint128 amount,
            uint64 entropyBlock,
            uint64 revealDeadlineBlock,
            uint8 choice,
            uint8 state,
            bytes32 commitment
        );
}

/// @title MATT Daily Mission Rewards
/// @notice Pays a fixed MATT reward after a wallet signs in, settles a new coin flip, and self-confirms following MATT on X.
/// @dev Wallet sign-in and X follow confirmation are handled by the website. This contract independently enforces the
///      settled-bet requirement, one-use bet IDs, the 24-hour cooldown, and reward-pool solvency.
contract MattDailyRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error FollowNotConfirmed();
    error CooldownActive(uint256 nextEligibleAt);
    error BetAlreadyUsed(uint256 betId);
    error BetNotOwnedByCaller(uint256 betId, address player, address caller);
    error BetNotSettled(uint256 betId, uint8 state);
    error InsufficientRewardPool(uint256 available, uint256 required);
    error CannotRescueMatt();

    IERC20 public immutable matt;
    IMattCoinFlipRewardsSource public immutable coinFlip;

    uint256 public constant REWARD_AMOUNT = 2_000_000 ether;
    uint256 public constant CLAIM_COOLDOWN = 24 hours;

    uint256 public totalClaims;
    mapping(address wallet => uint64 timestamp) public lastClaimAt;
    mapping(address wallet => uint256 betId) public lastUsedBetId;
    mapping(uint256 betId => bool used) public usedBetId;

    event RewardPoolFunded(address indexed funder, uint256 amount);
    event RewardPoolWithdrawn(address indexed recipient, uint256 amount);
    event RewardClaimed(
        address indexed wallet,
        uint256 indexed betId,
        uint256 rewardAmount,
        uint256 claimedAt,
        uint256 nextEligibleAt
    );

    constructor(address mattToken, address coinFlipContract, address initialOwner) Ownable(initialOwner) {
        if (mattToken == address(0) || coinFlipContract == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }
        matt = IERC20(mattToken);
        coinFlip = IMattCoinFlipRewardsSource(coinFlipContract);
    }

    /// @notice Funds the reward pool using an existing MATT allowance.
    function fund(uint256 amount) external nonReentrant {
        matt.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardPoolFunded(msg.sender, amount);
    }

    /// @notice Claims the daily reward after completing the website tasks.
    /// @param betId A newly settled MATT coin-flip bet owned by the caller.
    /// @param followedMatt Self-attestation that the caller followed the configured MATT account on X.
    function claim(uint256 betId, bool followedMatt) external nonReentrant whenNotPaused {
        if (!followedMatt) revert FollowNotConfirmed();

        uint256 previousClaimAt = lastClaimAt[msg.sender];
        uint256 eligibleAt = previousClaimAt + CLAIM_COOLDOWN;
        if (previousClaimAt != 0 && block.timestamp < eligibleAt) revert CooldownActive(eligibleAt);
        if (usedBetId[betId]) revert BetAlreadyUsed(betId);

        (address player,,,,, uint8 state,) = coinFlip.bets(betId);
        if (player != msg.sender) revert BetNotOwnedByCaller(betId, player, msg.sender);
        if (state != 2 && state != 3) revert BetNotSettled(betId, state);

        uint256 available = matt.balanceOf(address(this));
        if (available < REWARD_AMOUNT) revert InsufficientRewardPool(available, REWARD_AMOUNT);

        uint64 claimedAt = uint64(block.timestamp);
        lastClaimAt[msg.sender] = claimedAt;
        lastUsedBetId[msg.sender] = betId;
        usedBetId[betId] = true;
        unchecked {
            totalClaims += 1;
        }

        matt.safeTransfer(msg.sender, REWARD_AMOUNT);
        emit RewardClaimed(msg.sender, betId, REWARD_AMOUNT, claimedAt, uint256(claimedAt) + CLAIM_COOLDOWN);
    }

    function nextEligibleAt(address wallet) external view returns (uint256) {
        uint256 previousClaimAt = lastClaimAt[wallet];
        return previousClaimAt == 0 ? 0 : previousClaimAt + CLAIM_COOLDOWN;
    }

    function availableClaims() external view returns (uint256) {
        return matt.balanceOf(address(this)) / REWARD_AMOUNT;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function withdrawRewards(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        matt.safeTransfer(recipient, amount);
        emit RewardPoolWithdrawn(recipient, amount);
    }

    function rescueToken(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(matt)) revert CannotRescueMatt();
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
    }
}
