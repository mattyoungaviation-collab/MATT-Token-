// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMattSlotsTreasuryConverter {
    function recordLoss(uint256 amount) external;
}

/// @title MATT Slots Reward Vault
/// @notice Protects prepaid spin principal, player winnings, bonus-session liability,
///         and settled MATT waiting to be sent to the RON converter.
contract MattSlotsRewardVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_SETTLED = 2;
    uint8 private constant STATUS_CANCELLED = 3;
    uint8 private constant SESSION_ACTIVE = 1;
    uint8 private constant SESSION_COMPLETE = 2;

    struct PaidReservation {
        address recipient;
        uint256 principal;
        uint256 maximumPayout;
        uint256 reservedAmount;
        uint8 status;
    }

    struct BonusReservation {
        address recipient;
        uint256 remainingLiability;
        uint8 status;
    }

    IERC20 public immutable matt;
    IMattSlotsTreasuryConverter public immutable converter;
    address public controller;

    uint256 public totalReserved;
    uint256 public totalClaimable;
    uint256 public pendingTreasuryLoss;
    uint256 public totalTreasuryLossSettled;
    uint256 public totalTreasuryLossFlushed;

    mapping(uint256 spinId => PaidReservation reservation) public paidReservations;
    mapping(uint256 sessionId => BonusReservation reservation) public bonusReservations;
    mapping(address recipient => uint256 amount) public claimable;

    event ControllerUpdated(address indexed previousController, address indexed newController);
    event BankrollFunded(address indexed owner, uint256 amount);
    event BankrollWithdrawn(address indexed owner, uint256 amount);
    event PaidSpinReserved(
        uint256 indexed spinId,
        address indexed recipient,
        uint256 principal,
        uint256 maximumPayout
    );
    event PaidSpinSettled(
        uint256 indexed spinId,
        address indexed recipient,
        uint256 payout,
        uint256 treasuryLoss,
        uint256 indexed bonusSessionId,
        uint256 carriedLiability
    );
    event PaidSpinCancelled(uint256 indexed spinId, address indexed recipient, uint256 principal);
    event BonusSpinSettled(
        uint256 indexed spinId,
        uint256 indexed sessionId,
        address indexed recipient,
        uint256 payout,
        uint256 remainingLiability,
        bool sessionComplete
    );
    event BonusSessionForfeited(uint256 indexed sessionId, address indexed recipient, uint256 released);
    event TreasuryLossFlushed(uint256 amount, uint256 remainingPending);
    event PayoutClaimed(address indexed recipient, uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidReservation();
    error InsufficientBankroll(uint256 available, uint256 required);
    error MattLocked();
    error UnsupportedToken();

    constructor(address mattToken, address converterAddress, address initialOwner)
        Ownable(initialOwner)
    {
        if (
            mattToken == address(0) || converterAddress == address(0)
                || initialOwner == address(0)
        ) revert InvalidAddress();
        if (converterAddress.code.length == 0) revert InvalidAddress();
        matt = IERC20(mattToken);
        converter = IMattSlotsTreasuryConverter(converterAddress);
    }

    modifier onlyController() {
        if (msg.sender != controller) revert Unauthorized();
        _;
    }

    function setController(address newController) external onlyOwner {
        if (newController == address(0) || newController.code.length == 0) {
            revert InvalidAddress();
        }
        if (totalReserved != 0) revert InvalidReservation();
        address previous = controller;
        controller = newController;
        emit ControllerUpdated(previous, newController);
    }

    /// @notice Pulls one paid spin's principal from the controller and protects it
    /// independently while reserving the complete 500x session payout liability.
    function reservePaid(
        uint256 spinId,
        address recipient,
        uint256 principal,
        uint256 maximumPayout
    ) external onlyController nonReentrant {
        if (
            recipient == address(0) || principal == 0 || maximumPayout < principal
                || paidReservations[spinId].status != 0
        ) revert InvalidReservation();

        uint256 beforeBalance = matt.balanceOf(address(this));
        matt.safeTransferFrom(msg.sender, address(this), principal);
        uint256 received = matt.balanceOf(address(this)) - beforeBalance;
        if (received != principal) revert InvalidAmount();

        uint256 reservedAmount = maximumPayout + principal;
        uint256 available = availableBankroll();
        if (available < reservedAmount) {
            revert InsufficientBankroll(available, reservedAmount);
        }

        paidReservations[spinId] = PaidReservation({
            recipient: recipient,
            principal: principal,
            maximumPayout: maximumPayout,
            reservedAmount: reservedAmount,
            status: STATUS_PENDING
        });
        totalReserved += reservedAmount;
        emit PaidSpinReserved(spinId, recipient, principal, maximumPayout);
    }

    /// @notice Settles the paid/root spin. When it starts free spins, the unused part
    /// of the already-reserved 500x cap is carried into a persistent bonus reservation.
    function settlePaid(
        uint256 spinId,
        uint256 payout,
        uint256 bonusSessionId,
        bool carryBonusLiability
    ) external onlyController {
        PaidReservation storage reservation = paidReservations[spinId];
        if (
            reservation.status != STATUS_PENDING
                || payout > reservation.maximumPayout
                || (carryBonusLiability && bonusSessionId == 0)
                || (!carryBonusLiability && bonusSessionId != 0)
        ) revert InvalidReservation();

        reservation.status = STATUS_SETTLED;
        totalReserved -= reservation.reservedAmount;

        if (payout != 0) {
            totalClaimable += payout;
            claimable[reservation.recipient] += payout;
        }

        uint256 treasuryLoss = reservation.principal > payout
            ? reservation.principal - payout
            : 0;
        if (treasuryLoss != 0) {
            pendingTreasuryLoss += treasuryLoss;
            totalTreasuryLossSettled += treasuryLoss;
        }

        uint256 carriedLiability;
        if (carryBonusLiability) {
            if (bonusReservations[bonusSessionId].status != 0) revert InvalidReservation();
            carriedLiability = reservation.maximumPayout - payout;
            if (carriedLiability == 0) revert InvalidReservation();
            bonusReservations[bonusSessionId] = BonusReservation({
                recipient: reservation.recipient,
                remainingLiability: carriedLiability,
                status: SESSION_ACTIVE
            });
            totalReserved += carriedLiability;
        }

        emit PaidSpinSettled(
            spinId,
            reservation.recipient,
            payout,
            treasuryLoss,
            bonusSessionId,
            carriedLiability
        );
    }

    /// @notice Applies one free-spin payout against the persistent session cap.
    function settleBonus(
        uint256 spinId,
        uint256 sessionId,
        uint256 payout,
        bool sessionComplete
    ) external onlyController {
        BonusReservation storage reservation = bonusReservations[sessionId];
        if (
            reservation.status != SESSION_ACTIVE
                || payout > reservation.remainingLiability
        ) revert InvalidReservation();

        if (payout != 0) {
            reservation.remainingLiability -= payout;
            totalReserved -= payout;
            totalClaimable += payout;
            claimable[reservation.recipient] += payout;
        }

        uint256 released;
        if (sessionComplete) {
            released = reservation.remainingLiability;
            if (released != 0) totalReserved -= released;
            reservation.remainingLiability = 0;
            reservation.status = SESSION_COMPLETE;
        }

        emit BonusSpinSettled(
            spinId,
            sessionId,
            reservation.recipient,
            payout,
            reservation.remainingLiability,
            sessionComplete
        );
    }

    function cancelPaid(uint256 spinId) external onlyController nonReentrant {
        PaidReservation storage reservation = paidReservations[spinId];
        if (reservation.status != STATUS_PENDING) revert InvalidReservation();
        reservation.status = STATUS_CANCELLED;
        totalReserved -= reservation.reservedAmount;
        matt.safeTransfer(msg.sender, reservation.principal);
        emit PaidSpinCancelled(spinId, reservation.recipient, reservation.principal);
    }

    /// @notice A player may voluntarily surrender unused free spins so the unspent
    /// liability can be unlocked. No paid principal is involved in a bonus session.
    function forfeitBonusSession(uint256 sessionId, address recipient)
        external
        onlyController
    {
        BonusReservation storage reservation = bonusReservations[sessionId];
        if (
            reservation.status != SESSION_ACTIVE || reservation.recipient != recipient
        ) revert InvalidReservation();
        uint256 released = reservation.remainingLiability;
        reservation.remainingLiability = 0;
        reservation.status = SESSION_COMPLETE;
        totalReserved -= released;
        emit BonusSessionForfeited(sessionId, recipient, released);
    }

    function flushTreasuryLoss(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > pendingTreasuryLoss) revert InvalidAmount();
        pendingTreasuryLoss -= amount;
        totalTreasuryLossFlushed += amount;
        matt.safeTransfer(address(converter), amount);
        converter.recordLoss(amount);
        emit TreasuryLossFlushed(amount, pendingTreasuryLoss);
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert InvalidAmount();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        matt.safeTransfer(msg.sender, amount);
        emit PayoutClaimed(msg.sender, amount);
    }

    function fund(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = matt.balanceOf(address(this));
        matt.safeTransferFrom(msg.sender, address(this), amount);
        if (matt.balanceOf(address(this)) - beforeBalance != amount) revert InvalidAmount();
        emit BankrollFunded(msg.sender, amount);
    }

    function withdrawAvailable(uint256 amount) external onlyOwner nonReentrant {
        uint256 available = availableBankroll();
        if (amount == 0 || amount > available) {
            revert InsufficientBankroll(available, amount);
        }
        matt.safeTransfer(owner(), amount);
        emit BankrollWithdrawn(owner(), amount);
    }

    function protectedBalance() public view returns (uint256) {
        return totalReserved + totalClaimable + pendingTreasuryLoss;
    }

    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        uint256 locked = protectedBalance();
        return balance > locked ? balance - locked : 0;
    }

    function isSolvent() external view returns (bool) {
        return matt.balanceOf(address(this)) >= protectedBalance();
    }

    function recoverUnsupportedToken(address token, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(matt)) revert MattLocked();
        if (token == address(0) || amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(owner(), amount);
    }
}
