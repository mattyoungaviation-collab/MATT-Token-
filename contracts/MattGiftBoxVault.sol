// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MATT Gift Box Vault
/// @notice Holds and protects the MATT bankroll used by the gift-box controller.
contract MattGiftBoxVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_SETTLED = 2;

    struct Reservation {
        address recipient;
        uint256 maximumPayout;
        uint8 status;
    }

    IERC20 public immutable matt;
    address public controller;
    uint256 public totalReserved;
    uint256 public totalClaimable;

    mapping(uint256 boxId => Reservation reservation) public reservations;
    mapping(address recipient => uint256 amount) public claimable;

    event ControllerUpdated(address indexed previousController, address indexed newController);
    event BankrollFunded(address indexed owner, uint256 amount);
    event BankrollWithdrawn(address indexed owner, uint256 amount);
    event PayoutReserved(uint256 indexed boxId, address indexed recipient, uint256 maximumPayout);
    event PayoutSettled(uint256 indexed boxId, address indexed recipient, uint256 payout);
    event PayoutClaimed(address indexed recipient, uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidReservation();
    error InsufficientBankroll();
    error MattLocked();

    constructor(address mattToken, address initialOwner) Ownable(initialOwner) {
        if (mattToken == address(0) || initialOwner == address(0)) revert InvalidAddress();
        matt = IERC20(mattToken);
    }

    modifier onlyController() {
        if (msg.sender != controller) revert Unauthorized();
        _;
    }

    function setController(address newController) external onlyOwner {
        if (newController == address(0)) revert InvalidAddress();
        address previous = controller;
        controller = newController;
        emit ControllerUpdated(previous, newController);
    }

    function reserve(uint256 boxId, address recipient, uint256 maximumPayout)
        external
        onlyController
    {
        if (recipient == address(0) || maximumPayout == 0 || reservations[boxId].status != 0) {
            revert InvalidReservation();
        }
        if (availableBankroll() < maximumPayout) revert InsufficientBankroll();

        reservations[boxId] = Reservation({
            recipient: recipient,
            maximumPayout: maximumPayout,
            status: STATUS_PENDING
        });
        totalReserved += maximumPayout;
        emit PayoutReserved(boxId, recipient, maximumPayout);
    }

    function settle(uint256 boxId, uint256 payout) external onlyController {
        Reservation storage reservation = reservations[boxId];
        if (
            reservation.status != STATUS_PENDING
                || payout == 0
                || payout > uint256(reservation.maximumPayout)
        ) revert InvalidReservation();

        reservation.status = STATUS_SETTLED;
        totalReserved -= reservation.maximumPayout;
        totalClaimable += payout;
        claimable[reservation.recipient] += payout;
        emit PayoutSettled(boxId, reservation.recipient, payout);
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
        matt.safeTransferFrom(msg.sender, address(this), amount);
        emit BankrollFunded(msg.sender, amount);
    }

    function withdrawAvailable(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > availableBankroll()) revert InsufficientBankroll();
        matt.safeTransfer(owner(), amount);
        emit BankrollWithdrawn(owner(), amount);
    }

    function availableBankroll() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(this));
        uint256 locked = totalReserved + totalClaimable;
        return balance > locked ? balance - locked : 0;
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
