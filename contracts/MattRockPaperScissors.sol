// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MATT Rock Paper Scissors
/// @notice Player-versus-player escrow with commit/reveal moves and permissionless timeout settlement.
contract MattRockPaperScissors is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WAGER = 25_000 ether;
    uint256 public constant TOTAL_POT = WAGER * 2;
    uint256 public constant TREASURY_BPS = 1_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FUNDING_WINDOW = 60 seconds;
    uint256 public constant MOVE_WINDOW = 30 seconds;
    uint8 public constant MAX_ROUNDS = 30;

    enum Status { None, Open, Funding, Commit, Reveal, Settled, Refunded, Cancelled }
    enum Move { None, Rock, Paper, Scissors }

    struct Game {
        address creator;
        address opponent;
        Status status;
        uint8 round;
        uint64 deadline;
        bool creatorFunded;
        bool opponentFunded;
        bytes32 creatorCommitment;
        bytes32 opponentCommitment;
        Move creatorMove;
        Move opponentMove;
        bool creatorRevealed;
        bool opponentRevealed;
        address winner;
    }

    IERC20 public immutable matt;
    address public treasury;
    uint256 public nextGameId = 1;
    mapping(uint256 gameId => Game game) private games;

    event GameCreated(uint256 indexed gameId, address indexed creator, uint256 wager);
    event GameAccepted(uint256 indexed gameId, address indexed opponent, uint256 fundingDeadline);
    event GameFunded(uint256 indexed gameId, address indexed player);
    event RoundStarted(uint256 indexed gameId, uint8 indexed round, uint256 commitDeadline);
    event MoveCommitted(uint256 indexed gameId, uint8 indexed round, address indexed player);
    event RevealStarted(uint256 indexed gameId, uint8 indexed round, uint256 revealDeadline);
    event MoveRevealed(uint256 indexed gameId, uint8 indexed round, address indexed player);
    event RoundTied(uint256 indexed gameId, uint8 indexed round);
    event GameSettled(uint256 indexed gameId, address indexed winner, uint256 winnerPayout, uint256 treasuryFee, string reason);
    event GameRefunded(uint256 indexed gameId, uint256 creatorRefund, uint256 opponentRefund, string reason);
    event GameCancelled(uint256 indexed gameId);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    error ZeroAddress();
    error GameNotFound();
    error InvalidStatus();
    error NotCreator();
    error NotPlayer();
    error CannotPlaySelf();
    error AlreadyFunded();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error InvalidMove();
    error InvalidReveal();
    error DeadlinePassed();
    error DeadlineNotReached();
    error MattLocked();

    constructor(address mattToken, address treasuryWallet, address initialOwner) Ownable(initialOwner) {
        if (mattToken == address(0) || treasuryWallet == address(0) || initialOwner == address(0)) revert ZeroAddress();
        matt = IERC20(mattToken);
        treasury = treasuryWallet;
    }

    function createGame() external whenNotPaused returns (uint256 gameId) {
        gameId = nextGameId++;
        Game storage game = games[gameId];
        game.creator = msg.sender;
        game.status = Status.Open;
        game.round = 1;
        emit GameCreated(gameId, msg.sender, WAGER);
    }

    function cancelOpenGame(uint256 gameId) external {
        Game storage game = _game(gameId);
        if (game.status != Status.Open) revert InvalidStatus();
        if (msg.sender != game.creator) revert NotCreator();
        game.status = Status.Cancelled;
        emit GameCancelled(gameId);
    }

    function acceptGame(uint256 gameId) external whenNotPaused {
        Game storage game = _game(gameId);
        if (game.status != Status.Open) revert InvalidStatus();
        if (msg.sender == game.creator) revert CannotPlaySelf();
        game.opponent = msg.sender;
        game.status = Status.Funding;
        game.deadline = uint64(block.timestamp + FUNDING_WINDOW);
        emit GameAccepted(gameId, msg.sender, game.deadline);
    }

    function fundGame(uint256 gameId) external whenNotPaused nonReentrant {
        Game storage game = _game(gameId);
        if (game.status != Status.Funding) revert InvalidStatus();
        if (block.timestamp > game.deadline) revert DeadlinePassed();
        if (msg.sender == game.creator) {
            if (game.creatorFunded) revert AlreadyFunded();
            game.creatorFunded = true;
        } else if (msg.sender == game.opponent) {
            if (game.opponentFunded) revert AlreadyFunded();
            game.opponentFunded = true;
        } else revert NotPlayer();

        matt.safeTransferFrom(msg.sender, address(this), WAGER);
        emit GameFunded(gameId, msg.sender);
        if (game.creatorFunded && game.opponentFunded) {
            game.status = Status.Commit;
            game.deadline = uint64(block.timestamp + MOVE_WINDOW);
            emit RoundStarted(gameId, game.round, game.deadline);
        }
    }

    /// @notice Commitment must equal keccak256(abi.encode(gameId, round, player, move, salt)).
    function commitMove(uint256 gameId, bytes32 commitment) external whenNotPaused {
        Game storage game = _game(gameId);
        if (game.status != Status.Commit) revert InvalidStatus();
        if (block.timestamp > game.deadline) revert DeadlinePassed();
        if (commitment == bytes32(0)) revert InvalidReveal();
        if (msg.sender == game.creator) {
            if (game.creatorCommitment != bytes32(0)) revert AlreadyCommitted();
            game.creatorCommitment = commitment;
        } else if (msg.sender == game.opponent) {
            if (game.opponentCommitment != bytes32(0)) revert AlreadyCommitted();
            game.opponentCommitment = commitment;
        } else revert NotPlayer();

        emit MoveCommitted(gameId, game.round, msg.sender);
        if (game.creatorCommitment != bytes32(0) && game.opponentCommitment != bytes32(0)) {
            game.status = Status.Reveal;
            game.deadline = uint64(block.timestamp + MOVE_WINDOW);
            emit RevealStarted(gameId, game.round, game.deadline);
        }
    }

    function revealMove(uint256 gameId, Move move, bytes32 salt) external whenNotPaused nonReentrant {
        Game storage game = _game(gameId);
        if (game.status != Status.Reveal) revert InvalidStatus();
        if (block.timestamp > game.deadline) revert DeadlinePassed();
        if (move < Move.Rock || move > Move.Scissors) revert InvalidMove();
        bytes32 expected = makeCommitment(gameId, game.round, msg.sender, move, salt);
        if (msg.sender == game.creator) {
            if (game.creatorRevealed) revert AlreadyRevealed();
            if (expected != game.creatorCommitment) revert InvalidReveal();
            game.creatorMove = move;
            game.creatorRevealed = true;
        } else if (msg.sender == game.opponent) {
            if (game.opponentRevealed) revert AlreadyRevealed();
            if (expected != game.opponentCommitment) revert InvalidReveal();
            game.opponentMove = move;
            game.opponentRevealed = true;
        } else revert NotPlayer();

        emit MoveRevealed(gameId, game.round, msg.sender);
        if (game.creatorRevealed && game.opponentRevealed) _resolveRevealedRound(gameId, game);
    }

    function claimFundingTimeout(uint256 gameId) external nonReentrant {
        Game storage game = _game(gameId);
        if (game.status != Status.Funding) revert InvalidStatus();
        if (block.timestamp <= game.deadline) revert DeadlineNotReached();
        _refund(gameId, game, "funding timeout");
    }

    function claimCommitTimeout(uint256 gameId) external nonReentrant {
        Game storage game = _game(gameId);
        if (game.status != Status.Commit) revert InvalidStatus();
        if (block.timestamp <= game.deadline) revert DeadlineNotReached();
        bool creatorCommitted = game.creatorCommitment != bytes32(0);
        bool opponentCommitted = game.opponentCommitment != bytes32(0);
        if (creatorCommitted != opponentCommitted) _settle(gameId, game, creatorCommitted ? game.creator : game.opponent, "opponent failed to commit");
        else _refund(gameId, game, "neither player committed");
    }

    function claimRevealTimeout(uint256 gameId) external nonReentrant {
        Game storage game = _game(gameId);
        if (game.status != Status.Reveal) revert InvalidStatus();
        if (block.timestamp <= game.deadline) revert DeadlineNotReached();
        if (game.creatorRevealed != game.opponentRevealed) _settle(gameId, game, game.creatorRevealed ? game.creator : game.opponent, "opponent failed to reveal");
        else _refund(gameId, game, "neither player revealed");
    }

    function makeCommitment(uint256 gameId, uint8 round, address player, Move move, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(gameId, round, player, move, salt));
    }

    function getGame(uint256 gameId) external view returns (Game memory) {
        Game memory game = games[gameId];
        if (game.creator == address(0)) revert GameNotFound();
        return game;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address previous = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(previous, newTreasury);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(matt)) revert MattLocked();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    function _resolveRevealedRound(uint256 gameId, Game storage game) private {
        Move creatorMove = game.creatorMove;
        Move opponentMove = game.opponentMove;
        if (creatorMove == opponentMove) {
            emit RoundTied(gameId, game.round);
            if (game.round >= MAX_ROUNDS) {
                _refund(gameId, game, "maximum ties reached");
                return;
            }
            unchecked { game.round += 1; }
            game.creatorCommitment = bytes32(0);
            game.opponentCommitment = bytes32(0);
            game.creatorMove = Move.None;
            game.opponentMove = Move.None;
            game.creatorRevealed = false;
            game.opponentRevealed = false;
            game.status = Status.Commit;
            game.deadline = uint64(block.timestamp + MOVE_WINDOW);
            emit RoundStarted(gameId, game.round, game.deadline);
            return;
        }
        bool creatorWins = (creatorMove == Move.Rock && opponentMove == Move.Scissors) || (creatorMove == Move.Paper && opponentMove == Move.Rock) || (creatorMove == Move.Scissors && opponentMove == Move.Paper);
        _settle(gameId, game, creatorWins ? game.creator : game.opponent, "moves revealed");
    }

    function _settle(uint256 gameId, Game storage game, address winner, string memory reason) private {
        game.status = Status.Settled;
        game.winner = winner;
        game.deadline = 0;
        uint256 treasuryFee = TOTAL_POT * TREASURY_BPS / BPS_DENOMINATOR;
        uint256 winnerPayout = TOTAL_POT - treasuryFee;
        matt.safeTransfer(treasury, treasuryFee);
        matt.safeTransfer(winner, winnerPayout);
        emit GameSettled(gameId, winner, winnerPayout, treasuryFee, reason);
    }

    function _refund(uint256 gameId, Game storage game, string memory reason) private {
        game.status = Status.Refunded;
        game.deadline = 0;
        uint256 creatorRefund = game.creatorFunded ? WAGER : 0;
        uint256 opponentRefund = game.opponentFunded ? WAGER : 0;
        game.creatorFunded = false;
        game.opponentFunded = false;
        if (creatorRefund != 0) matt.safeTransfer(game.creator, creatorRefund);
        if (opponentRefund != 0) matt.safeTransfer(game.opponent, opponentRefund);
        emit GameRefunded(gameId, creatorRefund, opponentRefund, reason);
    }

    function _game(uint256 gameId) private view returns (Game storage game) {
        game = games[gameId];
        if (game.creator == address(0)) revert GameNotFound();
    }
}
