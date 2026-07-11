// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Matt Token (MATT)
/// @notice Fixed-supply, burnable ERC-20 community token on Ronin.
/// @dev No owner, mint, tax, pause, blacklist, or transfer-restriction functions exist.
contract MattToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant INITIAL_SUPPLY = 10_000_000_000 ether;

    /// @param treasury Address that receives the entire fixed supply at deployment.
    constructor(address treasury) ERC20("Matt", "MATT") ERC20Permit("Matt") {
        require(treasury != address(0), "MATT: zero treasury");
        _mint(treasury, INITIAL_SUPPLY);
    }
}
