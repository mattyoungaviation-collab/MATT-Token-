// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IProjectDynoOperationsFunder {
    function fundOperations(uint256 roundId) external payable;
}

/// @notice Holds Ronin VRF refunds until they can be accounted for with full gas.
/// @dev The coordinator forwards only 10,000 gas to its refund address. Its
///      callback runs before the refund, so accounting in receive() is unsafe.
contract ProjectDynoVRFRefundReceiver {
    address public immutable manager;

    error Unauthorized();

    event RefundSwept(uint256 indexed roundId, uint256 amount);

    constructor(address manager_) {
        if (manager_ == address(0)) revert Unauthorized();
        manager = manager_;
    }

    receive() external payable {}

    function sweep(uint256 roundId) external {
        if (msg.sender != manager) revert Unauthorized();
        uint256 amount = address(this).balance;
        if (amount == 0) return;
        IProjectDynoOperationsFunder(manager).fundOperations{value: amount}(roundId);
        emit RefundSwept(roundId, amount);
    }
}
