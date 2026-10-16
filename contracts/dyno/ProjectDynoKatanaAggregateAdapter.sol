// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWrappedRon} from "./interfaces/IKatanaV3SwapRouter.sol";

interface IKatanaAggregateRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Single-pool Katana AggregateRouter exact-input integration.
/// @dev No arbitrary commands, targets, path, sweep, Permit2 approval or allow-revert flag.
/// Deployment must still verify router code/governance and actual pool behavior on a fork.
contract ProjectDynoKatanaAggregateAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable matt;
    IERC20 public immutable wron;
    IKatanaAggregateRouter public immutable router;
    uint24 public immutable fee;
    bytes32 public immutable routeHash;
    error InvalidConfiguration();
    error InvalidReceipt();
    error IncompleteSpend();
    error InvalidOutput();
    error NativeTransferFailed();

    constructor(address matt_, address wron_, address router_, uint24 fee_) {
        if (matt_ == wron_ || matt_.code.length == 0 || wron_.code.length == 0 || router_.code.length == 0 || fee_ == 0 || fee_ >= 1_000_000) revert InvalidConfiguration();
        matt = IERC20(matt_); wron = IERC20(wron_);
        router = IKatanaAggregateRouter(router_); fee = fee_;
        routeHash = keccak256(abi.encode(matt_, wron_, router_, fee_, bytes1(0x00)));
    }

    function _swap(IERC20 input, IERC20 output, uint256 amount, uint256 minimum) private returns (uint256 received) {
        uint256 inputBefore = input.balanceOf(address(this));
        uint256 routerBefore = input.balanceOf(address(router));
        uint256 outputBefore = output.balanceOf(address(this));
        // Pre-fund the router inside this same atomic transaction. payerIsUser=false:
        // the router pays its pool directly, so no persistent router/Permit2 approval exists.
        input.safeTransfer(address(router), amount);
        if (input.balanceOf(address(this)) != inputBefore - amount || input.balanceOf(address(router)) != routerBefore + amount) revert InvalidReceipt();
        bytes[] memory commands = new bytes[](1);
        commands[0] = abi.encode(address(this), amount, minimum, abi.encodePacked(address(input), fee, address(output)), false);
        router.execute(hex"00", commands, block.timestamp);
        // Partial exact-input fills cannot silently leave ticket funds in the router.
        if (input.balanceOf(address(router)) != routerBefore) revert IncompleteSpend();
        received = output.balanceOf(address(this)) - outputBefore;
        if (received < minimum) revert InvalidOutput();
    }

    function sellExactMatt(uint256 amountIn, uint256 minRonOut) external nonReentrant returns (uint256 ronOut) {
        if (amountIn == 0 || minRonOut == 0) revert InvalidConfiguration();
        uint256 beforeMatt = matt.balanceOf(address(this));
        matt.safeTransferFrom(msg.sender, address(this), amountIn);
        if (matt.balanceOf(address(this)) != beforeMatt + amountIn) revert InvalidReceipt();
        ronOut = _swap(matt, wron, amountIn, minRonOut);
        uint256 beforeRon = address(this).balance;
        IWrappedRon(address(wron)).withdraw(ronOut);
        if (address(this).balance != beforeRon + ronOut) revert InvalidOutput();
        (bool ok,) = payable(msg.sender).call{value: ronOut}("");
        if (!ok) revert NativeTransferFailed();
    }

    function buyMatt(address recipient, uint256 minMattOut) external payable nonReentrant returns (uint256 mattOut) {
        if (recipient == address(0) || recipient == address(this) || msg.value == 0 || minMattOut == 0) revert InvalidConfiguration();
        uint256 beforeWron = wron.balanceOf(address(this));
        IWrappedRon(address(wron)).deposit{value: msg.value}();
        if (wron.balanceOf(address(this)) != beforeWron + msg.value) revert InvalidReceipt();
        mattOut = _swap(wron, matt, msg.value, minMattOut);
        uint256 beforeMatt = matt.balanceOf(recipient);
        matt.safeTransfer(recipient, mattOut);
        if (matt.balanceOf(recipient) != beforeMatt + mattOut) revert InvalidReceipt();
    }

    receive() external payable { if (msg.sender != address(wron)) revert InvalidConfiguration(); }
}
