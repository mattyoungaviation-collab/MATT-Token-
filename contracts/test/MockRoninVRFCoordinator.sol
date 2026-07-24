// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMockVRFConsumer {
    function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed) external;
}

contract MockRoninVRFCoordinator {
    uint256 public nonce;
    uint256 public fee = 0.01 ether;
    mapping(bytes32 requestHash => address consumer) public consumers;

    function setFee(uint256 newFee) external {
        fee = newFee;
    }

    function estimateRequestRandomFee(uint256, uint256) external view returns (uint256) {
        return fee;
    }

    function requestRandomSeed(uint256, uint256, address consumer, address refundAddress)
        external
        payable
        returns (bytes32 requestHash)
    {
        require(msg.value >= fee, "fee");
        requestHash = keccak256(abi.encode(block.chainid, msg.sender, consumer, ++nonce));
        consumers[requestHash] = consumer;
        uint256 refund = msg.value - fee;
        if (refund != 0) {
            (bool success,) = refundAddress.call{value: refund}("");
            require(success, "refund");
        }
    }

    function fulfill(bytes32 requestHash, uint256 randomSeed) external {
        IMockVRFConsumer(consumers[requestHash]).rawFulfillRandomSeed(requestHash, randomSeed);
    }
}
