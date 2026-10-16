// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockDynoWrappedRon is ERC20 {
    constructor() ERC20("Local WRON", "WRON") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external { _burn(msg.sender, amount); (bool ok,) = msg.sender.call{value: amount}(""); require(ok); }
}

contract MockDynoAggregateRouter {
    bool public fail;
    bool public partialFill;
    function configure(bool fail_, bool partial_) external { fail = fail_; partialFill = partial_; }
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(!fail && deadline >= block.timestamp && keccak256(commands) == keccak256(hex"00") && inputs.length == 1);
        (address recipient, uint256 amount, uint256 minimum, bytes memory path, bool payerIsUser) = abi.decode(inputs[0], (address,uint256,uint256,bytes,bool));
        require(!payerIsUser && path.length == 43);
        address tokenIn; address tokenOut; uint24 fee;
        assembly { tokenIn := shr(96,mload(add(path,32))) fee := shr(232,mload(add(path,52))) tokenOut := shr(96,mload(add(path,55))) }
        require(fee == 10000 && amount >= minimum);
        IERC20(tokenIn).transfer(address(0xdead), partialFill ? amount / 2 : amount);
        IERC20(tokenOut).transfer(recipient, amount);
    }
}
