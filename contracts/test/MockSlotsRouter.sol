// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintableSlotsToken {
    function mint(address to, uint256 amount) external;
}

interface ILossRecorder {
    function recordLoss(uint256 amount) external;
}

contract MockSlotsRouter {
    function swapExact(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    ) external returns (uint256) {
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "TRANSFER_IN");
        IMintableSlotsToken(tokenOut).mint(recipient, amountOut);
        return amountOut;
    }
}

contract MockSlotsLossConverter {
    uint256 public recorded;
    function recordLoss(uint256 amount) external { recorded += amount; }
}

contract MockSlotsSourceVault {
    function sendLoss(address token, address converter, uint256 amount) external {
        require(IERC20(token).transfer(converter, amount), "TRANSFER");
        ILossRecorder(converter).recordLoss(amount);
    }
}
