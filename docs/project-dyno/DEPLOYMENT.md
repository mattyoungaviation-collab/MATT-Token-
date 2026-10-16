# Deployment and upgrade runbook

1. Resolve every null in `project-dyno.ronin.example.json`. Verify chain, code, MATT decimals/behavior, NFT ownership/standard on Ethereum, WRON, pool tokens/factory/fee/observations/liquidity, router ABI, multisig owners/threshold, VRF fee/gas, signer and keepers. Confirm the manual-delivery disclosure and configure Ethereum receipt verification.
2. Run local tests, storage validation, fork sale/buy simulations and Saigon VRF integration. Record skipped checks.
3. Run `node scripts/dyno/validate-manifest.js <manifest> --onchain`; it must pass. Production cannot use mocks, zero liquidity or missing secrets.
4. Deploy implementations and proxies with atomic initialization. Verify source/slots. Grant only reviewer/keeper roles; they receive no treasury authority.
5. Deploy/verify adapter/guard, set measured liquidity, verify owner custody of #1358 on Ethereum, fund operations, compare all five prizes and the manual-delivery terms in the multisig decoder, then open. Do not deposit the Ethereum NFT into the Ronin manager. After assignments, follow `MANUAL-PRIZES.md` for manual payouts.

Contract scripts are local/dry-run. There is intentionally no mainnet deploy command. The owner approved the storage-only backend release described below. Mainnet contracts, live raffle activation and asset transfers still need explicit authorization.

## Owner-selected persistent disk storage

The owner identified the existing Render disk mount as `/var/data`. A directory is not itself a database: the implementation now uses a separate SQLite database at `/var/data/project-dyno/dyno.sqlite`. It does not reuse, replace, or migrate the other MATT game files. No separate paid PostgreSQL service is required for this selected configuration.

The owner saved these public settings for the approved release:

```dotenv
DYNO_STORAGE=sqlite
RENDER_DISK_PATH=/var/data
DYNO_DATABASE_FILE=/var/data/project-dyno/dyno.sqlite
DYNO_INDEXER_ENABLED=false
DYNO_LIVE_ENABLED=false
```

Dashboard verification on 2026-10-12 confirmed a 2 GB disk mounted at `/var/data`, both secret **names** present, and the four storage/indexer values above saved by the owner. Secret contents were never inspected. After owner approval, commit `d0ea21856322d77b8c6127dd1eaedf4723fc3269` deployed Live (superseding dependency hotfix `a35fed9`). Public health confirms `database=sqlite`, `authentication=sqlite-encrypted`, production, no mocks, purchases disabled, and successful database quick_check. Live OAuth consent/session acceptance, off-disk backup and recovery remain unverified.

### Storage-only release boundary

Production defaults to `DYNO_LIVE_ENABLED=false`. In this mode the combined server initializes encrypted persistent authentication, preserves other website routes, and serves a non-purchasable **Not launched** page at `/dyno`. `/api/dyno/health` reports storage readiness; `/config` publishes no invented contracts. Ticket authentication/vouchers, quotes, ledger/claim/admin preparation and indexing are unavailable. Shared Discord authentication remains available, with encrypted disk-backed sessions; no OAuth access token is retained. This is not a raffle launch or a completed chain integration.

The default does not read the local mock manifest. Enabling `DYNO_LIVE_ENABLED=true` requires an explicit, structurally valid production manifest, nonmock integrations and private RPC/signer configuration. These checks do not replace the required on-chain/fork verification, audit or launch authorization. Indexing cannot be enabled while live DYNO is disabled.

`npm run test:dyno:runtime` snapshots scoped backend/committed website sources into a temporary fixture, performs offline `npm ci --omit=dev`, starts the combined process tree against a local RPC stub and temporary mounted database, and verifies health, existing routes and disabled purchase/admin/indexer paths. It intentionally excludes `.env`, compiled artifacts and the local mock manifest. It uses generated ABI packages for transaction preparation, not dev-only compiled artifacts. The fixture is removed afterward; no Render deployment or real RPC is contacted.

The approved storage-only deployment changed `/dyno` to **Not launched** and initialized durable encrypted authentication. Only scoped backend files were released; unrelated local game/slots work was excluded. `/health`, `/slots`, `/api/x/config`, `/dyno`, `/api/dyno/health`, and `/api/dyno/config` passed live read-only checks; vouchers and admin preparation return 503. Discord configuration reports enabled, but consent and membership still require a user-completed test. Establish owner-controlled off-disk backups before enabling live raffle routes.

Set `DYNO_STORAGE_KEY` privately to exactly 32 cryptographically random bytes encoded as base64, and set/back up the separate stable `DYNO_IDENTITY_SECRET`. Never paste either into chat. Neither is generated automatically. Keep the existing keys after every restart/redeploy: a mismatch refuses startup rather than resetting identities. The SQLite store checks that its production path is inside an existing mounted disk, rejects unrelated database files, uses WAL with FULL synchronous commits, and creates its own files privately. Its schema is initialized at **runtime**, not the Render build step. The selected SQLite path ignores the legacy `DATABASE_URL` when `DYNO_STORAGE=sqlite`.

Disk-backed mode requires Node 22.18+ (22.x); tests ran on Node 22.23.2 and the existing Render release was observed on Node 22.23.3. Node's built-in SQLite API is still experimental in this runtime; this is an integration/trust assumption, not an audit claim. See [pinned Node API reference](https://raw.githubusercontent.com/nodejs/node/v22.23.2/doc/api/sqlite.md).

Run `npm run check:dyno:storage` in the mounted runtime after setting secrets. It reports missing/invalid configuration without printing values and without opening the database. On Windows, use an absolute local file under an ignored private test directory, not the Linux path `/var/data`.

After verified contract addresses and finality/start-block policy are approved, enable `DYNO_INDEXER_ENABLED=true` to run the read-only indexer **inside the same web-service instance**. It shares the local database connection, skips overlapping passes, and exposes `/api/dyno/indexer-health`. A separate Render worker cannot mount this web service's disk. The keeper can live elsewhere: it reads chain state and does not need the private identity database. See [Render disk limits](https://render.com/docs/disks).

### Backup and recovery

`npm run backup:dyno:storage` creates a new SQLite online backup under the database's private `backups/` directory and verifies its integrity. It refuses to overwrite an existing destination. Back up copies off the disk into owner-controlled encrypted storage; local backup files on the same disk alone are not disaster recovery. Preserve encryption and identity keys separately. Do not expose backups through the public website or include them in Git.

Restore only during an approved maintenance window. Stop all database users, verify the chosen backup, and retain the old live file. Run `npm run prepare:dyno:restore -- --source <absolute-backup.sqlite> --destination <new-absolute-staged.sqlite>` to preview the count of authentication records; add `--apply` to create a distinct staged copy. The tool refuses to overwrite a destination, checks Project DYNO schema/integrity, and **deletes restored `auth_records` only in the new copy** so consumed login challenges or old sessions cannot revive. It preserves the source backup, encrypted identity observations/audit records and indexed chain history. Check the prepared copy with the original private keys, then manually replace the live database while every database user remains stopped. Reconcile public events against chain checkpoints before serving traffic. Account quotas, voucher nonces, money and entitlements remain on chain. Do not restore the entire Render disk as a substitute for a database-level restore; other game files must remain untouched. Live restore/operator approval and key-rotation migration tooling are still outstanding.

For upgrades: compile with pinned tools; run storage-layout compatibility using live-shaped pending refund/VRF/DCA state; verify bytecode/source; prepare `upgradeToAndCall`; disclose code/ABI/storage consequences. The multisig may execute immediately in any phase. Confirm `Upgraded` and implementation slot, reconcile, then resume. No timelock exists.
