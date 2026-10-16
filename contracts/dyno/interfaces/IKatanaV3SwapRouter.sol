// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IKatanaV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWrappedRon {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
