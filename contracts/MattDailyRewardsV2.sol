// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IMattCoinFlipRewardsSourceV2 {
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

/// @title MATT Daily Mission Rewards V2
/// @notice Pays 1,000,000 MATT after a settled coin flip and a server-verified X follow.
/// @dev A dedicated, no-funds verifier key signs short-lived proofs after X OAuth verification.
contract MattDailyRewardsV2 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MessageHashUtils for bytes32;

    error ZeroAddress();
    error CooldownActive(uint256 nextEligibleAt);
    error BetAlreadyUsed(uint256 betId);
    error BetNotOwnedByCaller(uint256 betId, address player, address caller);
    error BetNotSettled(uint256 betId, uint8 state);
    error ProofExpired(uint256 deadline, uint256 currentTime);
    error InvalidFollowProof();
    error XAccountAlreadyBound(bytes32 xUserHash, address wallet);
    error InsufficientRewardPool(uint256 available, uint256 required);
    error CannotRescueMatt();

    IERC20 public immutable matt;
    IMattCoinFlipRewardsSourceV2 public immutable coinFlip;

    uint256 public constant REWARD_AMOUNT = 1_000_000 ether;
    uint256 public constant CLAIM_COOLDOWN = 24 hours;

    address public verifier;
    uint256 public totalClaims;

    mapping(address wallet => uint64 timestamp) public lastClaimAt;
    mapping(address wallet => uint256 betId) public lastUsedBetId;
    mapping(uint256 betId => bool used) public usedBetId;
    mapping(bytes32 xUserHash => address wallet) public xAccountWallet;
    mapping(address wallet => bytes32 xUserHash) public walletXAccount;

    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event RewardPoolFunded(address indexed funder, uint256 amount);
    event RewardPoolWithdrawn(address indexed recipient, uint256 amount);
    event XAccountBound(address indexed wallet, bytes32 indexed xUserHash);
    event RewardClaimed(
        address indexed wallet,
        uint256 indexed betId,
        bytes32 indexed xUserHash,
        uint256 rewardAmount,
        uint256 claimedAt,
        uint256 nextEligibleAt
    );

    constructor(address mattToken, address coinFlipContract, address proofVerifier, address initialOwner)
        Ownable(initialOwner)
    {
        if (
            mattToken == address(0) || coinFlipContract == address(0) ||
            proofVerifier == address(0) || initialOwner == address(0)
        ) revert ZeroAddress();

        matt = IERC20(mattToken);
        coinFlip = IMattCoinFlipRewardsSourceV2(coinFlipContract);
        verifier = proofVerifier;
    }

    function followProofDigest(
        address wallet,
        uint256 betId,
        bytes32 xUserHash,
        uint256 proofDeadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(address(this), block.chainid, wallet, betId, xUserHash, proofDeadline)
        );
    }

    function fund(uint256 amount) external nonReentrant {
        matt.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardPoolFunded(msg.sender, amount);
    }

    function claim(
        uint256 betId,
        bytes32 xUserHash,
        uint256 proofDeadline,
        bytes calldata followProof
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > proofDeadline) revert ProofExpired(proofDeadline, block.timestamp);

        bytes32 digest = followProofDigest(msg.sender, betId, xUserHash, proofDeadline);
        if (ECDSA.recover(digest.toEthSignedMessageHash(), followProof) != verifier) {
            revert InvalidFollowProof();
        }

        address boundWallet = xAccountWallet[xUserHash];
        if (boundWallet != address(0) && boundWallet != msg.sender) {
            revert XAccountAlreadyBound(xUserHash, boundWallet);
        }

        uint256 previousClaimAt = lastClaimAt[msg.sender];
        uint256 eligibleAt = previousClaimAt + CLAIM_COOLDOWN;
        if (previousClaimAt != 0 && block.timestamp < eligibleAt) revert CooldownActive(eligibleAt);
        if (usedBetId[betId]) revert BetAlreadyUsed(betId);

        (address player,,,,, uint8 state,) = coinFlip.bets(betId);
        if (player != msg.sender) revert BetNotOwnedByCaller(betId, player, msg.sender);
        if (state != 2 && state != 3) revert BetNotSettled(betId, state);

        uint256 available = matt.balanceOf(address(this));
        if (available < REWARD_AMOUNT) revert InsufficientRewardPool(available, REWARD_AMOUNT);

        if (boundWallet == address(0)) {
            xAccountWallet[xUserHash] = msg.sender;
            walletXAccount[msg.sender] = xUserHash;
            emit XAccountBound(msg.sender, xUserHash);
        }

        uint64 claimedAt = uint64(block.timestamp);
        lastClaimAt[msg.sender] = claimedAt;
        lastUsedBetId[msg.sender] = betId;
        usedBetId[betId] = true;
        unchecked { totalClaims += 1; }

        matt.safeTransfer(msg.sender, REWARD_AMOUNT);
        emit RewardClaimed(
            msg.sender,
            betId,
            xUserHash,
            REWARD_AMOUNT,
            claimedAt,
            uint256(claimedAt) + CLAIM_COOLDOWN
        );
    }

    function nextEligibleAt(address wallet) external view returns (uint256) {
        uint256 previousClaimAt = lastClaimAt[wallet];
        return previousClaimAt == 0 ? 0 : previousClaimAt + CLAIM_COOLDOWN;
    }

    function availableClaims() external view returns (uint256) {
        return matt.balanceOf(address(this)) / REWARD_AMOUNT;
    }

    function setVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert ZeroAddress();
        address previous = verifier;
        verifier = newVerifier;
        emit VerifierUpdated(previous, newVerifier);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

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