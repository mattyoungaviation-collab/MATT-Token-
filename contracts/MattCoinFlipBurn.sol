// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMattBurnable is IERC20 {
    function burn(uint256 amount) external;
}

/// @title MATT Coin Flip Burn Edition
/// @notice Fair commit/reveal coin flip with bankroll-limited bets and permanent burning of losing stakes.
/// @dev There is no artificial maximum bet. A bet is limited by the player's MATT and available bankroll.
contract MattCoinFlipBurn is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Choice { Heads, Tails }
    enum BetState { None, Pending, Won, Lost, Expired }

    struct Bet {
        address player;
        uint256 amount;
        uint64 entropyBlock;
        uint64 revealDeadlineBlock;
        Choice choice;
        BetState state;
        bytes32 commitment;
    }

    error ZeroAddress();
    error BetBelowMinimum(uint256 amount, uint256 minimum);
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

    IMattBurnable public immutable matt;
    uint256 public constant MIN_BET = 1 ether;
    uint64 public constant ENTROPY_DELAY_BLOCKS = 1;
    uint64 public constant REVEAL_WINDOW_BLOCKS = 200;

    uint256 public nextBetId = 1;
    uint256 public reservedPayouts;
    uint256 public totalBurnedByGame;

    mapping(uint256 betId => Bet bet) public bets;
    mapping(address player => uint256 betId) public activeBetOf;

    event BankrollFunded(address indexed funder, uint256 amount);
    event BankrollWithdrawn(address indexed recipient, uint256 amount);
    event MattBurned(uint256 indexed betId, address indexed player, uint256 amount, bool expired);
    event BetPlaced(uint256 indexed betId, address indexed player, Choice choice, uint256 amount, uint256 entropyBlock, uint256 revealDeadlineBlock, bytes32 commitment);
    event BetSettled(uint256 indexed betId, address indexed player, Choice choice, Choice outcome, uint256 amount, uint256 payout, bool won, bytes32 entropyBlockHash, uint256 randomWord);
    event BetExpired(uint256 indexed betId, address indexed player, uint256 amount);

    constructor(address mattToken, address initialOwner) Ownable(initialOwner) {
        if (mattToken == address(0) || initialOwner == address(0)) revert ZeroAddress();
        matt = IMattBurnable(mattToken);
    }

    function commitmentFor(address player, Choice choice, uint256 amount, bytes32 secret) public view returns (bytes32) {
        return keccak256(abi.encode(secret, player, choice, amount, address(this), block.chainid));
    }

    function placeBet(Choice choice, uint256 amount, bytes32 commitment) external nonReentrant whenNotPaused returns (uint256 betId) {
        if (amount < MIN_BET) revert BetBelowMinimum(amount, MIN_BET);
        uint256 current = activeBetOf[msg.sender];
        if (current != 0) revert ActiveBetExists(current);

        uint256 availableBefore = availableBankroll();
        if (amount > availableBefore) revert InsufficientBankroll(availableBefore, amount);

        uint256 beforeBalance = matt.balanceOf(address(this));
        IERC20(address(matt)).safeTransferFrom(msg.sender, address(this), amount);
        if (matt.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTokenBehavior();

        betId = nextBetId++;
        uint64 entropyBlock = uint64(block.number + ENTROPY_DELAY_BLOCKS);
        uint64 deadline = entropyBlock + REVEAL_WINDOW_BLOCKS;
        bets[betId] = Bet(msg.sender, amount, entropyBlock, deadline, choice, BetState.Pending, commitment);
        activeBetOf[msg.sender] = betId;
        reservedPayouts += amount * 2;
        emit BetPlaced(betId, msg.sender, choice, amount, entropyBlock, deadline, commitment);
    }

    function revealAndSettle(uint256 betId, bytes32 secret) external nonReentrant returns (bool won) {
        Bet storage bet = bets[betId];
        if (bet.state != BetState.Pending) revert BetNotPending(betId);
        if (msg.sender != bet.player) revert NotBetPlayer(msg.sender, bet.player);
        if (block.number <= bet.entropyBlock) revert EntropyBlockNotReady(block.number, uint256(bet.entropyBlock) + 1);
        if (block.number > bet.revealDeadlineBlock) revert RevealWindowClosed(block.number, bet.revealDeadlineBlock);
        if (commitmentFor(msg.sender, bet.choice, bet.amount, secret) != bet.commitment) revert InvalidSecret();

        bytes32 entropyHash = blockhash(bet.entropyBlock);
        if (entropyHash == bytes32(0)) revert EntropyUnavailable();
        uint256 randomWord = uint256(keccak256(abi.encodePacked(secret, entropyHash, betId, address(this), block.chainid)));
        Choice outcome = Choice(uint8(randomWord & 1));
        won = outcome == bet.choice;
        uint256 amount = bet.amount;
        uint256 payout = amount * 2;

        bet.state = won ? BetState.Won : BetState.Lost;
        activeBetOf[bet.player] = 0;
        reservedPayouts -= payout;

        if (won) {
            IERC20(address(matt)).safeTransfer(bet.player, payout);
        } else {
            matt.burn(amount);
            totalBurnedByGame += amount;
            payout = 0;
            emit MattBurned(betId, bet.player, amount, false);
        }
        emit BetSettled(betId, bet.player, bet.choice, outcome, amount, payout, won, entropyHash, randomWord);
    }

    function expireBet(uint256 betId) external nonReentrant {
        Bet storage bet = bets[betId];
        if (bet.state != BetState.Pending) revert BetNotPending(betId);
        if (block.number <= bet.revealDeadlineBlock) revert RevealWindowStillOpen(block.number, uint256(bet.revealDeadlineBlock) + 1);
        uint256 amount = bet.amount;
        bet.state = BetState.Expired;
        activeBetOf[bet.player] = 0;
        reservedPayouts -= amount * 2;
        matt.burn(amount);
        totalBurnedByGame += amount;
        emit MattBurned(betId, bet.player, amount, true);
        emit BetExpired(betId, bet.player, amount);
    }

    function fundBankroll(uint256 amount) external nonReentrant {
        uint256 beforeBalance = matt.balanceOf(address(this));
        IERC20(address(matt)).safeTransferFrom(msg.sender, address(this), amount);
        if (matt.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTokenBehavior();
        emit BankrollFunded(msg.sender, amount);
    }

    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        return balance > reservedPayouts ? balance - reservedPayouts : 0;
    }

    function maxAcceptableBet() external view returns (uint256) {
        return availableBankroll();
    }

    function withdrawAvailableBankroll(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = availableBankroll();
        if (amount > available) revert WithdrawalExceedsAvailable(amount, available);
        IERC20(address(matt)).safeTransfer(recipient, amount);
        emit BankrollWithdrawn(recipient, amount);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function rescueUnsupportedToken(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(matt)) revert CannotRescueMatt();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
    }
}
