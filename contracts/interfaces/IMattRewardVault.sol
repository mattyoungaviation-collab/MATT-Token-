// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMattRewardVault {
    function payWinner(address winner, uint256 amount) external;
    function burnMatt(uint256 amount) external;
    function paused() external view returns (bool);
}
