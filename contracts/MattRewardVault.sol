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

/// @title MATT BurnFlip Reward Vault
/// @notice Holds only MATT and exposes narrowly scoped pay and burn operations to BurnFlip.
contract MattRewardVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error UnauthorizedBurnFlip(address caller);
    error BurnFlipNotConfigured();
    error CannotRescueMatt();
    error InsufficientMatt(uint256 available, uint256 required);

    IMattBurnable public immutable matt;
    address public burnFlip;
    uint256 public totalPaid;
    uint256 public totalBurned;

    event BurnFlipConfigured(address indexed previousBurnFlip, address indexed newBurnFlip);
    event MattDeposited(address indexed depositor, uint256 amount);
    event WinnerPaid(address indexed winner, uint256 amount);
    event MattBurned(uint256 amount);
    event AccidentalTokenRescued(address indexed token, address indexed recipient, uint256 amount);

    modifier onlyBurnFlip() {
        if (msg.sender != burnFlip || burnFlip == address(0)) {
            revert UnauthorizedBurnFlip(msg.sender);
        }
        _;
    }

    constructor(address mattToken, address initialOwner) Ownable(initialOwner) {
        if (mattToken == address(0) || initialOwner == address(0)) revert ZeroAddress();
        matt = IMattBurnable(mattToken);
        _pause();
    }

    function configureBurnFlip(address newBurnFlip) external onlyOwner whenPaused {
        if (newBurnFlip == address(0)) revert ZeroAddress();
        address previous = burnFlip;
        burnFlip = newBurnFlip;
        emit BurnFlipConfigured(previous, newBurnFlip);
    }

    function depositMatt(uint256 amount) external nonReentrant {
        _deposit(msg.sender, amount);
    }

    function ownerRefill(uint256 amount) external onlyOwner nonReentrant {
        _deposit(msg.sender, amount);
    }

    function payWinner(address winner, uint256 amount)
        external
        onlyBurnFlip
        whenNotPaused
        nonReentrant
    {
        if (winner == address(0)) revert ZeroAddress();
        _requireBalance(amount);
        totalPaid += amount;
        IERC20(address(matt)).safeTransfer(winner, amount);
        emit WinnerPaid(winner, amount);
    }

    function burnMatt(uint256 amount)
        external
        onlyBurnFlip
        whenNotPaused
        nonReentrant
    {
        _requireBalance(amount);
        totalBurned += amount;
        matt.burn(amount);
        emit MattBurned(amount);
    }

    function mattBalance() external view returns (uint256) {
        return matt.balanceOf(address(this));
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        if (burnFlip == address(0)) revert BurnFlipNotConfigured();
        _unpause();
    }

    function rescueAccidentalToken(address token, uint256 amount)
        external
        onlyOwner
        whenPaused
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(matt)) revert CannotRescueMatt();
        address recipient = owner();
        IERC20(token).safeTransfer(recipient, amount);
        emit AccidentalTokenRescued(token, recipient, amount);
    }

    function _deposit(address depositor, uint256 amount) private {
        uint256 beforeBalance = matt.balanceOf(address(this));
        IERC20(address(matt)).safeTransferFrom(depositor, address(this), amount);
        uint256 received = matt.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InsufficientMatt(received, amount);
        emit MattDeposited(depositor, amount);
    }

    function _requireBalance(uint256 amount) private view {
        uint256 balance = matt.balanceOf(address(this));
        if (balance < amount) revert InsufficientMatt(balance, amount);
    }
}
