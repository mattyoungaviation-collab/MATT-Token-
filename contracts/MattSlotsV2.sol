// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MattSlotsV1} from "./MattSlotsV1.sol";

/// @title MATT Slots V2
/// @notice V1 slot math and vault accounting with a subscription-funded VRF adapter.
contract MattSlotsV2 is MattSlotsV1 {
    constructor(address mattToken,address rewardVaultAddress,address coordinatorAdapterAddress,address initialOwner,uint256[5] memory initialReels,uint32[30] memory initialLinePaysBps,uint32[3] memory initialScatterPaysBps,uint8[3] memory initialBonusAwards,uint16 initialDeclaredRtpBps,uint256 initialSpinId,uint256 initialSessionId)
        MattSlotsV1(mattToken,rewardVaultAddress,coordinatorAdapterAddress,initialOwner,initialReels,initialLinePaysBps,initialScatterPaysBps,initialBonusAwards,initialDeclaredRtpBps)
    {
        if (initialSpinId == 0 || initialSessionId == 0) revert InvalidAmount();
        nextSpinId = initialSpinId; nextSessionId = initialSessionId;
    }
}