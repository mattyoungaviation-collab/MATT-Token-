# RON and MATT treasury withdrawals

The Multisig Admin tab now has a withdrawal panel for the manager's existing treasury claims. This change does not upgrade the contract, change ticket terms, recategorize active payments as revenue, or alter public historical totals.

## What can be withdrawn

* **RON:** the round's unpaid `treasuryLiability`, after settlement or cancellation. Normal settlement already attempts to send the reserve and treasury remainder to the configured treasury. This claim is for an allocation that remains unpaid, including unused operating funds allocated on cancellation.
* **MATT:** the round's `treasuryMattLiability`, after settlement. MATT reserved for active tickets or refunds is excluded.

Both existing contract methods claim the **full recorded allocation**. They do not take a custom withdrawal amount or recipient. They execute from the round's configured treasury, which this workflow verifies by simulating the call from the expected Safe. An emergency administrator can prepare the draft but cannot impersonate the Safe or redirect its proceeds.

These controls do not release the requested 1,200 RON from an OPEN round. A read-only mainnet check at block 62,485,791 found 1,435 RON and 28,700,000 MATT held, with the same amounts accounted for and zero treasury allocation in either asset. That is a dated observation; the panel always reads fresh state.

## Flow

1. Connect and sign in using an active Safe-owner or emergency-admin wallet.
2. Open **Multisig Admin**, enter the round ID and select **Check available funds**.
3. If an allocation is available, select **Prepare RON withdrawal** or **Prepare MATT withdrawal**.
4. Review the asset, full observed allocation, contract, Safe and pinned simulation block.
5. Download the unsigned Safe Transaction Builder JSON. Recheck the current allocation and execute through the configured Safe with its required approvals.

Preparing or downloading a draft does not sign, propose, approve or broadcast a transaction. A later payment from the Safe for the Dyno purchase is a separate transaction for its owners to review.

## Checks

The server verifies the wallet session and current administrator authority. It reads all created rounds at the same recent Ronin block and includes active direct/sale receipts, operating funds, refunds, prizes and treasury allocations in native-RON accounting. It also includes active, refundable and treasury MATT across rounds using the same token. Both asset balances must cover all recorded amounts. Older cancelled rounds still count, including tickets not yet processed into individual refund claims.

The current scan is capped at 64 rounds to bound authenticated RPC work. Exceeding that limit fails closed; it does not omit historical claims. A larger deployment needs a separately reviewed bounded accounting/indexing strategy.

Draft preparation repeats the complete funding check. A changed allocation, unexpected input, wrong token, failed Safe simulation, stale block, reorg, unavailable RPC or funding shortfall prevents export. The dedicated endpoint accepts only a round, asset and the exact allocation/target/Safe already reviewed; it does not accept arbitrary calldata, amounts, recipients or value. Generic admin preparation no longer handles treasury claims.

The browser independently checks the returned chain, target, Safe, round, allocation, zero value and exact existing claim calldata. Exports contain one claim transaction, identify the Safe and Ronin chain, and expire locally after two minutes. Downloaded files cannot impose an onchain expiry; owners must still refresh the allocation and review the Safe transaction before signing. Existing contract authorization remains the final execution check.

## Validation

Run the changed-feature tests:

```sh
node --test services/dyno-api/treasury.test.js website/lib/dyno-treasury.test.js website/lib/dyno-admin.test.js
```

They cover authorization, active-ticket protection, historical cancellation/refund backing, funding shortfalls, changed allocations, restricted inputs, forced Safe execution, actual claim simulation, reorgs, bounded history, no wallet access, exact transaction exports, concurrency, stale responses and draft expiry.

The broader API/admin regression run was compared with an untouched snapshot of commit `4373a6e`. Both had the same eight existing failures: two deployment-planner tests (including absent generated contract artifacts), one manifest/approved-terms fixture test, and five legacy swap-protection tests. The withdrawal feature introduced no additional failures. These existing failures are not silently disabled or repaired by changing published terms.
