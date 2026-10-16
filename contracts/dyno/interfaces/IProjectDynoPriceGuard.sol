// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IProjectDynoPriceGuard {
    function saleMinOut(uint256 mattIn, uint16 slippageBps) external view returns (uint256 ronOut);
    function buybackMinOut(uint256 ronIn, uint16 slippageBps) external view returns (uint256 mattOut);
    function validate() external view;
}
