// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Collects Flappy MATT entries, sends the creator fee immediately,
///         and pays the server-verified top three wallets after each UTC day.
contract FlappyMattPrizePool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ENTRY_FEE = 50_000 ether;
    uint256 public constant TREASURY_FEE_PER_ENTRY = 1_000 ether;
    uint256 public constant PRIZE_PER_ENTRY = 49_000 ether;

    IERC20 public immutable matt;
    address public immutable treasury;
    address public operator;

    mapping(uint256 roundId => uint256 entries) public roundEntries;
    mapping(uint256 roundId => uint256 prizePot) public roundPot;
    mapping(uint256 roundId => uint256 carriedPrize) public roundCarryover;
    mapping(uint256 roundId => bool settled) public roundSettled;

    event EntryPaid(
        uint256 indexed roundId,
        address indexed player,
        uint256 entryNumber,
        uint256 treasuryFee,
        uint256 prizeAdded,
        uint256 potAfter
    );
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event WinnerPaid(uint256 indexed roundId, uint8 indexed rank, address indexed winner, uint256 amount);
    event RoundSettled(
        uint256 indexed roundId,
        uint256 entries,
        uint256 prizePot,
        uint256 carriedForward,
        uint256 carryoverRoundId
    );

    error NotOperator();
    error RoundStillOpen();
    error RoundAlreadySettled();
    error InvalidWinnerOrder();
    error DuplicateWinner();
    error NoPrizePot();
    error MattLocked();
    error ZeroAddress();

    constructor(address mattToken, address treasuryWallet, address initialOperator, address initialOwner)
        Ownable(initialOwner)
    {
        if (
            mattToken == address(0) || treasuryWallet == address(0) ||
            initialOperator == address(0) || initialOwner == address(0)
        ) revert ZeroAddress();
        matt = IERC20(mattToken);
        treasury = treasuryWallet;
        operator = initialOperator;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @notice UTC round identifier: floor(timestamp / 1 day).
    function currentRoundId() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function roundEndsAt(uint256 roundId) public pure returns (uint256) {
        return (roundId + 1) * 1 days;
    }

    function availablePrize(uint256 roundId) public view returns (uint256) {
        return roundPot[roundId] + roundCarryover[roundId];
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    /// @notice Pays one 50,000 MATT game entry.
    /// @dev Requires an allowance of at least ENTRY_FEE. The entire amount is pulled once,
    ///      then 1,000 MATT is sent to treasury and 49,000 MATT remains assigned to this UTC round.
    function enter() external nonReentrant returns (uint256 roundId, uint256 entryNumber) {
        roundId = currentRoundId();
        matt.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);
        matt.safeTransfer(treasury, TREASURY_FEE_PER_ENTRY);

        entryNumber = ++roundEntries[roundId];
        uint256 potAfter = roundPot[roundId] + PRIZE_PER_ENTRY;
        roundPot[roundId] = potAfter;

        emit EntryPaid(
            roundId,
            msg.sender,
            entryNumber,
            TREASURY_FEE_PER_ENTRY,
            PRIZE_PER_ENTRY,
            potAfter
        );
    }

    /// @notice Settles a completed UTC round. Missing winner shares carry forward.
    /// @dev The trusted game operator submits server-verified winners. All-zero winners carry the full pot.
    function settleRound(uint256 roundId, address first, address second, address third)
        external
        onlyOperator
        nonReentrant
    {
        if (block.timestamp < roundEndsAt(roundId)) revert RoundStillOpen();
        if (roundSettled[roundId]) revert RoundAlreadySettled();
        if (first == address(0) && (second != address(0) || third != address(0))) revert InvalidWinnerOrder();
        if (second == address(0) && third != address(0)) revert InvalidWinnerOrder();
        if (
            (second != address(0) && first == second) ||
            (third != address(0) && (first == third || second == third))
        ) revert DuplicateWinner();

        uint256 prizePot = availablePrize(roundId);
        if (prizePot == 0) revert NoPrizePot();

        roundSettled[roundId] = true;
        roundPot[roundId] = 0;
        roundCarryover[roundId] = 0;

        uint256 firstShare = prizePot * 50 / 100;
        uint256 secondShare = prizePot * 35 / 100;
        uint256 thirdShare = prizePot - firstShare - secondShare;

        uint256 carriedForward;
        if (first == address(0)) carriedForward += firstShare;
        else {
            matt.safeTransfer(first, firstShare);
            emit WinnerPaid(roundId, 1, first, firstShare);
        }

        if (second == address(0)) carriedForward += secondShare;
        else {
            matt.safeTransfer(second, secondShare);
            emit WinnerPaid(roundId, 2, second, secondShare);
        }

        if (third == address(0)) carriedForward += thirdShare;
        else {
            matt.safeTransfer(third, thirdShare);
            emit WinnerPaid(roundId, 3, third, thirdShare);
        }

        uint256 carryoverRoundId = currentRoundId();
        if (carriedForward != 0) roundCarryover[carryoverRoundId] += carriedForward;

        emit RoundSettled(
            roundId,
            roundEntries[roundId],
            prizePot,
            carriedForward,
            carryoverRoundId
        );
    }

    /// @notice Recovers unrelated tokens accidentally sent to this contract. MATT remains locked to prizes.
    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(matt)) revert MattLocked();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
