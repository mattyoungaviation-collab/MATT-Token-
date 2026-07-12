// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MATT Coin Flip
/// @notice A two-transaction commit/reveal coin flip using a future Ronin block hash.
/// @dev The player commits to a cryptographically random secret before the entropy block exists.
///      Revealing settles the bet immediately. Unrevealed bets expire to the immutable treasury.
contract MattCoinFlip is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Choice {
        Heads,
        Tails
    }

    enum BetState {
        None,
        Pending,
        Won,
        Lost,
        Expired
    }

    struct Bet {
        address player;
        uint128 amount;
        uint64 entropyBlock;
        uint64 revealDeadlineBlock;
        Choice choice;
        BetState state;
        bytes32 commitment;
    }

    error ZeroAddress();
    error BetBelowMinimum(uint256 amount, uint256 minimum);
    error BetAboveMaximum(uint256 amount, uint256 maximum);
    error ActiveBetExists(uint256 betId);
    error InsufficientBankroll(uint256 available, uint256 required);
    error UnsupportedTokenBehavior();
    error BetNotPending(uint256 betId);
    error NotBetPlayer(address caller, address player);
    error EntropyBlockNotReady(uint256 currentBlock, uint256 requiredBlock);
    error RevealWindowClosed(uint256 currentBlock, uint256 deadlineBlock);
    error RevealWindowStillOpen(uint256 currentBlock, uint256 deadlineBlock);
    error InvalidSecret();
    error EntropyUnavailable();
    error WithdrawalExceedsAvailable(uint256 requested, uint256 available);
    error CannotRescueMatt();

    IERC20 public immutable matt;
    IERC20Permit public immutable mattPermit;
    address public immutable treasury;

    uint256 public constant MIN_BET = 1 ether;
    uint256 public constant MAX_BET = 1_000_000 ether;
    uint64 public constant ENTROPY_DELAY_BLOCKS = 1;
    uint64 public constant REVEAL_WINDOW_BLOCKS = 200;

    uint256 public nextBetId = 1;
    uint256 public reservedPayouts;

    mapping(uint256 betId => Bet bet) public bets;
    mapping(address player => uint256 betId) public activeBetOf;

    event BankrollFunded(address indexed funder, uint256 amount);
    event BankrollWithdrawn(address indexed recipient, uint256 amount);
    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        Choice choice,
        uint256 amount,
        uint256 entropyBlock,
        uint256 revealDeadlineBlock,
        bytes32 commitment
    );
    event BetSettled(
        uint256 indexed betId,
        address indexed player,
        Choice choice,
        Choice outcome,
        uint256 amount,
        uint256 payout,
        bool won,
        bytes32 entropyBlockHash,
        uint256 randomWord
    );
    event BetExpired(uint256 indexed betId, address indexed player, uint256 amount);

    constructor(address mattToken, address treasuryAddress, address initialOwner) Ownable(initialOwner) {
        if (mattToken == address(0) || treasuryAddress == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }

        matt = IERC20(mattToken);
        mattPermit = IERC20Permit(mattToken);
        treasury = treasuryAddress;
    }

    /// @notice Returns the commitment the website must submit with a bet.
    function commitmentFor(address player, Choice choice, uint256 amount, bytes32 secret)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(secret, player, choice, amount, address(this), block.chainid));
    }

    /// @notice Places a bet using an existing ERC-20 allowance.
    function placeBet(Choice choice, uint256 amount, bytes32 commitment)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        return _placeBet(msg.sender, choice, amount, commitment);
    }

    /// @notice Uses MATT's ERC-2612 permit and places the bet in one on-chain transaction.
    function placeBetWithPermit(
        Choice choice,
        uint256 amount,
        bytes32 commitment,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 betId) {
        mattPermit.permit(msg.sender, address(this), amount, permitDeadline, v, r, s);
        return _placeBet(msg.sender, choice, amount, commitment);
    }

    function _placeBet(address player, Choice choice, uint256 amount, bytes32 commitment)
        internal
        returns (uint256 betId)
    {
        if (amount < MIN_BET) revert BetBelowMinimum(amount, MIN_BET);
        if (amount > MAX_BET) revert BetAboveMaximum(amount, MAX_BET);

        uint256 currentActiveBet = activeBetOf[player];
        if (currentActiveBet != 0) revert ActiveBetExists(currentActiveBet);

        uint256 balanceBefore = matt.balanceOf(address(this));
        matt.safeTransferFrom(player, address(this), amount);
        uint256 balanceAfter = matt.balanceOf(address(this));
        if (balanceAfter - balanceBefore != amount) revert UnsupportedTokenBehavior();

        uint256 payout = amount * 2;
        uint256 requiredBalance = reservedPayouts + payout;
        if (balanceAfter < requiredBalance) {
            revert InsufficientBankroll(balanceAfter - reservedPayouts, amount);
        }

        betId = nextBetId++;
        uint64 entropyBlock = uint64(block.number + ENTROPY_DELAY_BLOCKS);
        uint64 revealDeadlineBlock = entropyBlock + REVEAL_WINDOW_BLOCKS;

        bets[betId] = Bet({
            player: player,
            amount: uint128(amount),
            entropyBlock: entropyBlock,
            revealDeadlineBlock: revealDeadlineBlock,
            choice: choice,
            state: BetState.Pending,
            commitment: commitment
        });

        activeBetOf[player] = betId;
        reservedPayouts += payout;

        emit BetPlaced(
            betId,
            player,
            choice,
            amount,
            entropyBlock,
            revealDeadlineBlock,
            commitment
        );
    }

    /// @notice Reveals the precommitted secret and settles the bet immediately.
    function revealAndSettle(uint256 betId, bytes32 secret) external nonReentrant returns (bool won) {
        Bet storage bet = bets[betId];
        if (bet.state != BetState.Pending) revert BetNotPending(betId);
        if (msg.sender != bet.player) revert NotBetPlayer(msg.sender, bet.player);
        if (block.number <= bet.entropyBlock) {
            revert EntropyBlockNotReady(block.number, uint256(bet.entropyBlock) + 1);
        }
        if (block.number > bet.revealDeadlineBlock) {
            revert RevealWindowClosed(block.number, bet.revealDeadlineBlock);
        }

        if (commitmentFor(msg.sender, bet.choice, bet.amount, secret) != bet.commitment) {
            revert InvalidSecret();
        }

        bytes32 entropyBlockHash = blockhash(bet.entropyBlock);
        if (entropyBlockHash == bytes32(0)) revert EntropyUnavailable();

        uint256 randomWord = uint256(
            keccak256(abi.encodePacked(secret, entropyBlockHash, betId, address(this), block.chainid))
        );
        Choice outcome = Choice(uint8(randomWord & 1));
        won = outcome == bet.choice;

        uint256 amount = bet.amount;
        uint256 payout = amount * 2;

        bet.state = won ? BetState.Won : BetState.Lost;
        activeBetOf[bet.player] = 0;
        reservedPayouts -= payout;

        if (won) {
            matt.safeTransfer(bet.player, payout);
        } else {
            matt.safeTransfer(treasury, amount);
            payout = 0;
        }

        emit BetSettled(
            betId,
            bet.player,
            bet.choice,
            outcome,
            amount,
            payout,
            won,
            entropyBlockHash,
            randomWord
        );
    }

    /// @notice Sends an unrevealed bet to treasury after the reveal window closes.
    function expireBet(uint256 betId) external nonReentrant {
        Bet storage bet = bets[betId];
        if (bet.state != BetState.Pending) revert BetNotPending(betId);
        if (block.number <= bet.revealDeadlineBlock) {
            revert RevealWindowStillOpen(block.number, uint256(bet.revealDeadlineBlock) + 1);
        }

        uint256 amount = bet.amount;
        uint256 payout = amount * 2;

        bet.state = BetState.Expired;
        activeBetOf[bet.player] = 0;
        reservedPayouts -= payout;
        matt.safeTransfer(treasury, amount);

        emit BetExpired(betId, bet.player, amount);
    }

    /// @notice Funds the payout bankroll. Direct MATT transfers to the contract also increase bankroll.
    function fundBankroll(uint256 amount) external nonReentrant {
        uint256 balanceBefore = matt.balanceOf(address(this));
        matt.safeTransferFrom(msg.sender, address(this), amount);
        if (matt.balanceOf(address(this)) - balanceBefore != amount) revert UnsupportedTokenBehavior();
        emit BankrollFunded(msg.sender, amount);
    }

    /// @notice Amount the owner can withdraw without touching any pending-bet liability.
    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        return balance > reservedPayouts ? balance - reservedPayouts : 0;
    }

    /// @notice Maximum bet currently supportable by both the fixed cap and available bankroll.
    function maxAcceptableBet() external view returns (uint256) {
        uint256 available = availableBankroll();
        return available < MAX_BET ? available : MAX_BET;
    }

    function withdrawAvailableBankroll(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = availableBankroll();
        if (amount > available) revert WithdrawalExceedsAvailable(amount, available);
        matt.safeTransfer(recipient, amount);
        emit BankrollWithdrawn(recipient, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueUnsupportedToken(address token, address recipient, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(matt)) revert CannotRescueMatt();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
    }
}
