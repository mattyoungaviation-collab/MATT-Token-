// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds Flappy MATT entry payments and pays each completed UTC day's top three wallets.
/// @dev Players transfer exactly ENTRY_FEE directly to this contract. The trusted game operator
///      submits the server-verified winners after the UTC day closes. The contract performs the
///      treasury fee and 50/35/15 transfers atomically.
contract FlappyMattPrizePool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ENTRY_FEE = 50_000 ether;
    uint256 public constant TREASURY_FEE_PER_ENTRY = 1_000 ether;
    uint256 public constant PRIZE_PER_ENTRY = 49_000 ether;

    IERC20 public immutable matt;
    address public immutable treasury;
    address public operator;

    mapping(uint256 roundId => bool settled) public roundSettled;

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event RoundSettled(
        uint256 indexed roundId,
        uint256 entries,
        uint256 treasuryFee,
        uint256 prizePot,
        address indexed first,
        address indexed second,
        address third,
        uint256 firstPrize,
        uint256 secondPrize,
        uint256 thirdPrize
    );

    error NotOperator();
    error RoundStillOpen();
    error RoundAlreadySettled();
    error InvalidWinner();
    error DuplicateWinner();
    error InsufficientMATT();

    constructor(address mattToken, address treasuryWallet, address initialOperator, address initialOwner)
        Ownable(initialOwner)
    {
        require(mattToken != address(0) && treasuryWallet != address(0), "ZERO_ADDRESS");
        matt = IERC20(mattToken);
        treasury = treasuryWallet;
        operator = initialOperator;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @notice UTC round identifier used by the website: floor(timestamp / 1 day).
    function currentRoundId() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function roundEndsAt(uint256 roundId) public pure returns (uint256) {
        return (roundId + 1) * 1 days;
    }

    function setOperator(address newOperator) external onlyOwner {
        address previous = operator;
        operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    /// @notice Settles one completed UTC round and pays all recipients in the same transaction.
    /// @param entries Number of verified 50,000 MATT entries recorded for the round.
    function settleRound(
        uint256 roundId,
        uint256 entries,
        address first,
        address second,
        address third
    ) external onlyOperator nonReentrant {
        if (block.timestamp < roundEndsAt(roundId)) revert RoundStillOpen();
        if (roundSettled[roundId]) revert RoundAlreadySettled();
        if (first == address(0) || second == address(0) || third == address(0)) revert InvalidWinner();
        if (first == second || first == third || second == third) revert DuplicateWinner();

        uint256 treasuryFee = entries * TREASURY_FEE_PER_ENTRY;
        uint256 prizePot = entries * PRIZE_PER_ENTRY;
        uint256 requiredBalance = treasuryFee + prizePot;
        if (matt.balanceOf(address(this)) < requiredBalance) revert InsufficientMATT();

        roundSettled[roundId] = true;

        uint256 firstPrize = prizePot * 50 / 100;
        uint256 secondPrize = prizePot * 35 / 100;
        uint256 thirdPrize = prizePot - firstPrize - secondPrize;

        matt.safeTransfer(treasury, treasuryFee);
        matt.safeTransfer(first, firstPrize);
        matt.safeTransfer(second, secondPrize);
        matt.safeTransfer(third, thirdPrize);

        emit RoundSettled(
            roundId,
            entries,
            treasuryFee,
            prizePot,
            first,
            second,
            third,
            firstPrize,
            secondPrize,
            thirdPrize
        );
    }

    /// @notice Recovers tokens sent by mistake, excluding MATT while unsettled player funds remain.
    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(matt), "MATT_LOCKED");
        IERC20(token).safeTransfer(to, amount);
    }
}
