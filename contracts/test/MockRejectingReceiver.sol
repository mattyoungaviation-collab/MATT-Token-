// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockRejectingReceiver {
    receive() external payable { revert("NO_RON"); }
}
