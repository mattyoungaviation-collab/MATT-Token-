// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IProjectDynoBuybackVault {
    function startBuyback(
        uint256 roundId,
        address treasury,
        address matt,
        address adapter,
        address guard,
        uint16 slippageBps
    ) external payable;

    function isClosed() external view returns (bool);
}
