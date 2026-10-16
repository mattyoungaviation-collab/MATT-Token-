// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IKatanaV3SwapRouter, IWrappedRon} from "./interfaces/IKatanaV3SwapRouter.sol";

/// @notice Narrow exact-input adapter with an immutable MATT/WRON route and no arbitrary calldata.
/// @dev Production use is blocked until the deployed Ronin router/pool ABI and fee are verified on-chain.
contract ProjectDynoKatanaV3Adapter {
    using SafeERC20 for IERC20;
    IERC20 private immutable _matt;
    IERC20 public immutable wron;
    IKatanaV3SwapRouter public immutable router;
    uint24 public immutable fee;
    bytes32 public immutable routeHash;

    error InvalidConfiguration();
    error InvalidOutput();
    error NativeTransferFailed();

    constructor(address matt_, address wron_, address router_, uint24 fee_) {
        if (matt_ == address(0) || wron_ == address(0) || router_ == address(0) || fee_ == 0) revert InvalidConfiguration();
        _matt = IERC20(matt_); wron = IERC20(wron_); router = IKatanaV3SwapRouter(router_); fee = fee_;
        routeHash = keccak256(abi.encode(matt_, wron_, router_, fee_));
    }

    function matt() external view returns (address) { return address(_matt); }

    function sellExactMatt(uint256 amountIn, uint256 minRonOut) external returns (uint256 ronOut) {
        if (amountIn == 0 || minRonOut == 0) revert InvalidConfiguration();
        uint256 beforeMatt = _matt.balanceOf(address(this));
        _matt.safeTransferFrom(msg.sender, address(this), amountIn);
        if (_matt.balanceOf(address(this)) - beforeMatt != amountIn) revert InvalidConfiguration();
        _matt.forceApprove(address(router), amountIn);
        uint256 beforeWron = wron.balanceOf(address(this));
        uint256 reported = router.exactInputSingle(IKatanaV3SwapRouter.ExactInputSingleParams({
            tokenIn: address(_matt), tokenOut: address(wron), fee: fee, recipient: address(this), deadline: block.timestamp,
            amountIn: amountIn, amountOutMinimum: minRonOut, sqrtPriceLimitX96: 0
        }));
        _matt.forceApprove(address(router), 0);
        ronOut = wron.balanceOf(address(this)) - beforeWron;
        if (ronOut < minRonOut || reported != ronOut) revert InvalidOutput();
        IWrappedRon(address(wron)).withdraw(ronOut);
        (bool ok,) = payable(msg.sender).call{value: ronOut}("");
        if (!ok) revert NativeTransferFailed();
    }

    function buyMatt(address recipient, uint256 minMattOut) external payable returns (uint256 mattOut) {
        if (recipient == address(0) || msg.value == 0 || minMattOut == 0) revert InvalidConfiguration();
        IWrappedRon(address(wron)).deposit{value: msg.value}();
        wron.forceApprove(address(router), msg.value);
        uint256 beforeBalance = _matt.balanceOf(recipient);
        uint256 reported = router.exactInputSingle(IKatanaV3SwapRouter.ExactInputSingleParams({
            tokenIn: address(wron), tokenOut: address(_matt), fee: fee, recipient: recipient, deadline: block.timestamp,
            amountIn: msg.value, amountOutMinimum: minMattOut, sqrtPriceLimitX96: 0
        }));
        wron.forceApprove(address(router), 0);
        mattOut = _matt.balanceOf(recipient) - beforeBalance;
        if (mattOut < minMattOut || reported != mattOut) revert InvalidOutput();
    }

    receive() external payable {
        if (msg.sender != address(wron)) revert InvalidConfiguration();
    }
}
