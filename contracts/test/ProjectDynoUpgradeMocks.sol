// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ProjectDynoRaffleManager} from "../dyno/ProjectDynoRaffleManager.sol";
import {ProjectDynoBuybackVault} from "../dyno/ProjectDynoBuybackVault.sol";

/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract ProjectDynoRaffleManagerV2Mock is ProjectDynoRaffleManager {
    function implementationVersion() external pure returns (uint256) { return 2; }
}

/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract ProjectDynoBuybackVaultV2Mock is ProjectDynoBuybackVault {
    function implementationVersion() external pure returns (uint256) { return 2; }
}
