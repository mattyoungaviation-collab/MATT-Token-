// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Concrete proxy artifact used for atomic Project DYNO proxy initialization.
contract ProjectDynoProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory initializationData)
        ERC1967Proxy(implementation, initializationData)
    {}
}
