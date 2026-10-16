# Operations, keeper and incident recovery

Use the owner-selected persistent disk `/var/data` with the private DYNO SQLite file; runtime startup initializes the schema. Run the indexer on the same Render instance (optional `DYNO_INDEXER_ENABLED=true`), not a separate service sharing the disk. Keepers use separate gas wallets and one limited role. One normally submits; both re-read chain state. Monitor disk usage/backups, RPC/finality lag, checkpoint age, VRF over 24 hours, stalled review, operations funds, keeper gas, guard failures, missed slots, failed transfers, upgrades and reconciliation. See `DEPLOYMENT.md` for encrypted database-level backups and restoration of the original keys.

Each keeper tick reads `eth_chainId` from its RPC and refuses a mismatch before reading state or submitting transactions. It pins round, schedule and slot reads to one block number; the contracts still enforce the actual state at transaction time if that block becomes stale. Live mode requires its private gas-wallet signer to be present in the runtime environment; do not put that key in a manifest or chat. A wrong-chain health code is safe to publish, while provider error text and credentials are redacted.

A pause stops calls, not time. Missing keeper: start backup and operate only the current window; never backfill. Delayed VRF: preserve the original request; no timeout seed. Failed delivery remains a claim and never rerolls. DEX/guard failure: authorized keeper may record the current slot failed after isolated effects revert. A reverted outer transaction records nothing.

The keeper compares the number of elapsed slots with the vault's terminal-slot count and marks expired slots only when one is still pending; it does not submit a no-op mark on every poll. This also catches older missed hours after an outage even if a public caller has already completed a later hour. At the seven-day boundary it calls `closeBuyback` once, which marks any remaining pending slots MISSED and returns the unused budget. This is an operational gas reduction, not a change to slot windows or catch-up policy.

The vault requires at least 5.3 million gas remaining before a slot attempt and forwards a fixed 5 million gas to its isolated swap call. An under-gassed transaction reverts before it can mark a slot FAILED. The caller pays only gas actually used, not the entire limit. After the planned liquidity addition, measure real vault-mediated buyback gas on a pinned fork; an unexpectedly complex route that exceeds the fixed call allowance can still fail a slot and must be reviewed before opening.

Cancellation is batched and idempotent; all active ticket credits remain backed. The manual NFT stays with its owner and requires no manager return. After randomness request, normal cancellation is impossible. Exceptional change requires a disclosed upgrade.

Keepers never send prizes. The multisig manually initiates the five RON payments in order from reserved manager funds; the NFT depositor sends the Ethereum NFT last and the multisig reports its receipt hash. Use `MANUAL-PRIZES.md`; reporting evidence does not itself verify cross-chain payment.

Reconcile with `scripts/dyno/reconcile.js`; a negative excess is an incident. Pause the affected subsystem while preserving callbacks/claims where safe, record evidence, prepare but do not blindly submit a multisig action, and publish the actual resolution.
# Current no-sale revision

The keeper still handles frozen-round randomness request, winner finalization and settlement. The current raffle never starts a vault schedule, so hourly DCA and close instructions below are historical for the superseded swap design. See [NO-SALE-REVISION.md](NO-SALE-REVISION.md).

