// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRoninVRFCoordinator {
    function requestRandomSeed(
        uint256 callbackGasLimit,
        uint256 gasPrice,
        address consumer,
        address refundAddress
    ) external payable returns (bytes32 requestHash);

    function estimateRequestRandomFee(uint256 callbackGasLimit, uint256 gasPrice) external view returns (uint256);
}
