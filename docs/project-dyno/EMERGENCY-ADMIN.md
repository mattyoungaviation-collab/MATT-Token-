# Project DYNO unilateral emergency administration

The owner approved full unilateral contract administration for `0x1DAb596D0121C250a24B00137E84170FA6874be6`. This replaces the original multisig-only requirement. The 2-of-3 multisig remains an administrator and treasury beneficiary, but the emergency wallet does not need its signatures to use administrative controls or upgrade either proxy. No live grant, deployment or transaction was executed.

## Powers and limits

Emergency authority covers round creation/opening, review flags/resolution/disqualification, freeze, pre-request cancellation, signer rotation, identity relinks/suspension, reviewer management, pauses, swap safeguards, manual prize attempts/delivery reporting, vault role management and both UUPS upgrades. Permissionless validated draw/settlement/buyback actions remain available to it like any caller. Operations fees and fixed beneficiaries remain unchanged by normal setters.

Routine functions cannot rewrite a frozen snapshot, reroll, choose a claim recipient, sweep backed obligations, revive skipped slots or redirect the vault budget. However, immediate upgrades can replace those protections. Losing this single key can threaten every asset held by the contracts, including unpaid claims. The role does not control assets already held in the independent multisig, unrelated games, other token contracts, or another wallet's NFT. The owner-approved treasury/reserve still goes to the existing multisig.

Keep the emergency key in a secure user-controlled wallet, not Render, the keeper, the identity service, source or chat. Only the separate limited-authority identity/keeper credentials belong in their respective service secret stores. The signer cannot become an administrator merely by issuing a voucher, and keeper authority is not treasury authority.

## Activation and rotation

The existing four-argument proxy initializer remains compatible and initializes the multisig first. Before opening, the multisig binds the real guard with `bindGovernanceManager(raffleProxy)` and activates `setEmergencyAdmin(address)`. The unsigned deployment planner includes these actions before draft-round creation. It does not broadcast them. Verify the guard's one-time binding, manager address, emergency getter, vault default-admin permission and code before activation.

The manager stores the address in one newly consumed storage-gap slot and emits old/new address and actor. Vault and guard read this setting dynamically. Either administrator can rotate it immediately; setting zero revokes derived emergency authority. No duplicate emergency default-role grant is required. An administrator can separately grant other vault roles, including persistent default-admin roles: inventory those grants during revocation, because independent explicit grants do not disappear when the emergency setting changes. Neither role grants nor revocation undo an already executed malicious upgrade.

Both administrators can rotate the emergency role. An emergency-key compromise can therefore race the multisig's revocation or install malicious code. There is no timelock, guardian quorum or automatic safe recovery guarantee.

## Verification

Two focused local contract checks cover authority, outsider rejection, live rotation/revocation across manager/vault/real guard, role management and emergency upgrades with an existing refund and active DCA state preserved. API checks require the authenticated wallet to match on-chain emergency authority, not just a manifest field, and simulate drafts from the correct direct-wallet address. Public/admin drafts disclose unilateral execution and remain unsigned.

Storage comparison uses the captured pre-change layout and OpenZeppelin validation metadata including enums and ERC-7201 namespaces. No unsafe custom-type bypass is permitted. Generated ABIs reflect the emergency setter/getter and guard binding. Passing these checks is not an independent audit or real-chain acceptance.

Latest verification: `npx hardhat test test/ProjectDyno.test.js test/ProjectDynoPriceGuard.test.js` passed 22 contract checks. The selected API/manifest/deployment/UI run passed 18 checks, none skipped. Current UUPS validation and pre-change manager/vault storage comparison passed. These are local results, not a full repository suite or real-chain integration. Standard vault revoke/renounce cannot remove a derived emergency role; use the manager setter to avoid a misleading revocation event.

After adding the final vault revoke/renounce safeguard, compilation and the two focused emergency contract checks passed again. The storage comparison passed again and final ABIs were regenerated. The earlier 22-contract run was before that last safeguard; it was not rerun in full. Browser rendering was not rechecked; public disclosure and draft behavior were checked by source/VM tests.
