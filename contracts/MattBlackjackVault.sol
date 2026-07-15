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

contract MattBlackjackVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Outcome {
        Loss,
        Surrender,
        Push,
        Win,
        Blackjack
    }

    struct Wager {
        address player;
        uint128 amount;
        uint64 openedAt;
        bool settled;
    }

    IERC20Burnable public immutable matt;
    address public immutable treasury;
    address public settlementOperator;
    uint256 public refundDelay;

    uint256 public lockedWagers;
    uint256 public reservedProfit;
    uint256 public totalClaimable;
    uint256 public totalBurned;
    uint256 public totalTreasuryFunded;
    uint256 public totalTreasuryWithdrawn;

    mapping(bytes32 => Wager) public wagers;
    mapping(address => uint256) public claimable;

    event SettlementOperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event RefundDelayUpdated(uint256 previousDelay, uint256 newDelay);
    event BankrollFunded(address indexed treasury, uint256 amount);
    event BankrollWithdrawn(address indexed treasury, uint256 amount);
    event WagerOpened(bytes32 indexed wagerId, bytes32 indexed roundId, address indexed player, uint256 amount);
    event WagerSettled(bytes32 indexed wagerId, address indexed player, Outcome outcome, uint256 returnedPrincipal, uint256 profit, uint256 burned);
    event WagerRefunded(bytes32 indexed wagerId, address indexed player, uint256 amount);
    event PlayerWithdrawal(address indexed player, uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error WagerAlreadyExists();
    error WagerNotOpen();
    error InsufficientBankroll();
    error RefundNotAvailable();

    constructor(address mattToken, address treasuryAddress, address operatorAddress) Ownable(treasuryAddress) {
        if (mattToken == address(0) || treasuryAddress == address(0) || operatorAddress == address(0)) {
            revert InvalidAddress();
        }
        matt = IERC20Burnable(mattToken);
        treasury = treasuryAddress;
        settlementOperator = operatorAddress;
        refundDelay = 2 hours;
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

    function setRefundDelay(uint256 newDelay) external onlyOwner {
        if (newDelay < 15 minutes || newDelay > 7 days) revert InvalidAmount();
        uint256 previous = refundDelay;
        refundDelay = newDelay;
        emit RefundDelayUpdated(previous, newDelay);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function fundBankroll(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0) revert InvalidAmount();
        IERC20(address(matt)).safeTransferFrom(msg.sender, address(this), amount);
        totalTreasuryFunded += amount;
        emit BankrollFunded(msg.sender, amount);
    }

    function withdrawBankroll(uint256 amount) external onlyTreasury nonReentrant {
        if (amount == 0 || amount > availableBankroll()) revert InsufficientBankroll();
        totalTreasuryWithdrawn += amount;
        IERC20(address(matt)).safeTransfer(treasury, amount);
        emit BankrollWithdrawn(treasury, amount);
    }

    function openWager(bytes32 roundId, uint256 amount) external whenNotPaused nonReentrant returns (bytes32 wagerId) {
        if (roundId == bytes32(0) || amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        wagerId = keccak256(abi.encodePacked(block.chainid, address(this), roundId, msg.sender));
        if (wagers[wagerId].player != address(0)) revert WagerAlreadyExists();

        uint256 maxProfit = blackjackProfit(amount);
        if (availableBankroll() < maxProfit) revert InsufficientBankroll();

        IERC20(address(matt)).safeTransferFrom(msg.sender, address(this), amount);
        wagers[wagerId] = Wager({player: msg.sender, amount: uint128(amount), openedAt: uint64(block.timestamp), settled: false});
        lockedWagers += amount;
        reservedProfit += maxProfit;

        emit WagerOpened(wagerId, roundId, msg.sender, amount);
    }

    function settleWager(bytes32 wagerId, Outcome outcome) external onlyOperator whenNotPaused nonReentrant {
        Wager storage wager = wagers[wagerId];
        if (wager.player == address(0) || wager.settled) revert WagerNotOpen();

        wager.settled = true;
        uint256 amount = uint256(wager.amount);
        lockedWagers -= amount;
        reservedProfit -= blackjackProfit(amount);

        uint256 returnedPrincipal;
        uint256 profit;
        uint256 burned;

        if (outcome == Outcome.Loss) {
            burned = amount;
        } else if (outcome == Outcome.Surrender) {
            returnedPrincipal = amount / 2;
            burned = amount - returnedPrincipal;
        } else if (outcome == Outcome.Push) {
            returnedPrincipal = amount;
        } else if (outcome == Outcome.Win) {
            returnedPrincipal = amount;
            profit = amount;
        } else {
            returnedPrincipal = amount;
            profit = blackjackProfit(amount);
        }

        uint256 credit = returnedPrincipal + profit;
        if (credit != 0) {
            if (profit > availableBankroll()) revert InsufficientBankroll();
            claimable[wager.player] += credit;
            totalClaimable += credit;
        }

        if (burned != 0) {
            matt.burn(burned);
            totalBurned += burned;
        }

        emit WagerSettled(wagerId, wager.player, outcome, returnedPrincipal, profit, burned);
    }

    function refundExpiredWager(bytes32 wagerId) external nonReentrant {
        Wager storage wager = wagers[wagerId];
        if (wager.player == address(0) || wager.settled) revert WagerNotOpen();
        if (msg.sender != wager.player && msg.sender != owner()) revert Unauthorized();
        if (!paused() && block.timestamp < uint256(wager.openedAt) + refundDelay) revert RefundNotAvailable();

        wager.settled = true;
        uint256 amount = uint256(wager.amount);
        lockedWagers -= amount;
        reservedProfit -= blackjackProfit(amount);
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

    function blackjackProfit(uint256 wagerAmount) public pure returns (uint256) {
        return (wagerAmount * 3) / 2;
    }

    function protectedBalance() public view returns (uint256) {
        return lockedWagers + totalClaimable;
    }

    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        uint256 protectedTokens = protectedBalance();
        if (balance <= protectedTokens) return 0;
        return balance - protectedTokens;
    }

    function unreservedBankroll() external view returns (uint256) {
        uint256 available = availableBankroll();
        if (available <= reservedProfit) return 0;
        return available - reservedProfit;
    }

    function isSolvent() external view returns (bool) {
        return matt.balanceOf(address(this)) >= protectedBalance() + reservedProfit;
    }
}
