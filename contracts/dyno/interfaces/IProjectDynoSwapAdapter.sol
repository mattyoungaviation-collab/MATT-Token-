// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IProjectDynoSwapAdapter {
    /// @notice Sells an exact amount of MATT and sends native RON to msg.sender.
    function sellExactMatt(uint256 amountIn, uint256 minRonOut) external returns (uint256 ronOut);

    /// @notice Buys MATT with exact native RON and sends MATT to recipient.
    function buyMatt(address recipient, uint256 minMattOut) external payable returns (uint256 mattOut);

    function matt() external view returns (address);
    function routeHash() external view returns (bytes32);
}
