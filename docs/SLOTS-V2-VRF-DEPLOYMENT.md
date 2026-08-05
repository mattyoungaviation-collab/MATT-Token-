# MATT Slots V2 - Native-RON Sponsored VRF Deployment

Slots V2 preserves the V1 math and vault accounting. `MattSlotsVRFV25Adapter` requests one word from Ronin `VRFCoordinatorV2_5` and charges an admin-owned native-RON subscription. Players send zero VRF value but still pay ordinary transaction gas.

- Coordinator: `0xa18FD3db9B869AD2A8c55267e0D54dbf6ECEbEda`
- Proving key: `0x1aefc70f3533a251306d6b85a6b336ba0ae2e384226274b236f42c3d5366dbbd`

## Safety gates

- Keep V1 paused.
- Have users refund unused V1 credits before publishing the V2 frontend. V1 refunds remain available, but V2 will not display V1 inventory.
- Never switch the vault controller while `totalReserved` is nonzero.
- Deploy V2 paused, verify both new contracts, inspect all links, then activate.
- Never paste the deployer key into chat, files, or command arguments.

## 1. Compile and test

```powershell
npx hardhat compile
npx hardhat test test/MattSlotsV1.test.js test/MattSlotsRewardVault.test.js test/MattSlotsTreasuryConverter.test.js
```

Add adapter-specific tests before activation. Compilation is not an audit.

## 2. Create and fund a native-RON subscription

```powershell
$env:SLOTS_VRF_FUND_RON="20"
$env:CONFIRM_CREATE_SLOTS_VRF_SUBSCRIPTION="YES"
npx hardhat run scripts/create-slots-vrf-subscription.js --network ronin
Remove-Item Env:CONFIRM_CREATE_SLOTS_VRF_SUBSCRIPTION
```

Output: `deployment-exports/slots-vrf-subscription-ronin.json`

## 3. Deploy adapter and V2 paused

```powershell
$env:SLOTS_VRF_KEY_HASH="0x1aefc70f3533a251306d6b85a6b336ba0ae2e384226274b236f42c3d5366dbbd"
$env:SLOTS_VRF_CONFIRMATIONS="3"
$env:SLOTS_VRF_CALLBACK_GAS_LIMIT="1400000"
$env:CONFIRM_SLOTS_V2_MAINNET="YES"
npx hardhat run scripts/deploy-slots-v2.js --network ronin
Remove-Item Env:CONFIRM_SLOTS_V2_MAINNET
```

This registers the adapter as the subscription consumer but does not switch the vault controller. Output: `deployment-exports/slots-v2-ronin.json`.

## 4. Inspect and verify sources

```powershell
npx hardhat run scripts/inspect-slots-v2.js --network ronin
npx hardhat run scripts/export-slots-v2-verification.js
```

Verify both contracts on Ronin Explorer with the generated standard-input files. Constructor arguments and encoded arguments are in `slots-v2-ronin.json`.

Do not continue unless V1 and V2 are paused, vault `totalReserved` is zero, the vault is solvent, adapter consumer equals V2, adapter is registered on the subscription, the subscription is funded, and both sources are verified.

## 5. Activate and switch the vault controller

```powershell
$env:SLOTS_VRF_MIN_RESERVE_RON="10"
$env:CONFIRM_ACTIVATE_SLOTS_V2="YES"
npx hardhat run scripts/activate-slots-v2.js --network ronin
Remove-Item Env:CONFIRM_ACTIVATE_SLOTS_V2
npx hardhat run scripts/inspect-slots-v2.js --network ronin
```

## 6. Test once, then publish V2

Run one owner-wallet minimum-value spin and confirm `RandomWordsRequested`, `RandomWordsFulfilled`, adapter delivery, and Slots settlement. Then:

```powershell
node scripts/update-slots-frontend.js deployment-exports/slots-v2-ronin.json
git add contracts/MattSlotsV2.sol contracts/MattSlotsVRFV25Adapter.sol scripts website/public docs package.json
git commit -m "Add subscription-sponsored Slots V2 VRF"
git push origin main
```

## 7. Top up the reserve

```powershell
$env:SLOTS_VRF_FUND_RON="10"
$env:CONFIRM_FUND_SLOTS_VRF="YES"
npx hardhat run scripts/fund-slots-vrf-subscription.js --network ronin
Remove-Item Env:CONFIRM_FUND_SLOTS_VRF
```

Pause V2 before the subscription reaches the operational minimum.

## Rollback

Pause V2 immediately. Do not point the vault back to V1 while V2 has an active reservation. V1 credits remain refundable from V1.