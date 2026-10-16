# Project DYNO implementation handoff

Project DYNO is integrated into the existing MATT Hardhat/Express site. The current local revision uses fixed 35 RON + 700,000 MATT tickets without selling ticket MATT. It implements chain-authoritative held-MATT accounting, Discord-backed identity vouchers, review/disqualification, dual-asset refunds, a frozen 1,000-ticket snapshot, Ronin VRF request binding, six draws with replacement, independent RON prize claims and direct-RON settlement. It allocates eligible MATT to the multisig after settlement. The legacy vault and Katana adapters remain in source history but are **not used or funded** by this payment model.

This no-sale revision supersedes older references below to per-ticket swaps and 168 hourly buybacks. Historical market simulations remain evidence for why that earlier path was abandoned, not current launch requirements. No live contract has been deployed for this revision; the existing production site remains disabled for purchases.

For the current go/no-go decision and launch sequence, start with [LAUNCH-GATES.md](LAUNCH-GATES.md). The local implementation and storage-only live page are not a live raffle.

Owner-selected settings and on-chain evidence are in [OWNER-INPUTS.md](OWNER-INPUTS.md). Follow [DISCORD-SETUP.md](DISCORD-SETUP.md) to configure the existing Discord application. [MANUAL-PRIZES.md](MANUAL-PRIZES.md) describes the owner's revised delivery model: the NFT stays with the owner on Ethereum and the multisig manually initiates the five reserved RON awards. The keeper handles draw/settlement actions without sending prizes or running buybacks.

## Local verification

```powershell
npm ci
npm run compile
npm run test:dyno
npm run validate:dyno:config
npm run deploy:dyno:local
docker compose -f docker-compose.dyno.yml up -d
Get-Content services/dyno-api/migrations/001_project_dyno.sql | docker compose -f docker-compose.dyno.yml exec -T postgres psql -U dyno -d dyno
npm start
```

Open `http://localhost:3000/dyno`. The checked-in manifest is visibly marked as a local mock and purchasing is disabled. `deploy:dyno:local` deploys mocks and proxies into an ephemeral Hardhat process and writes `deployment-exports/project-dyno-local.json`; it does not deploy Ronin.

## Packages

- `ProjectDynoRaffleManager`: money, tickets, identity bindings/quotas, review, refund, snapshot, VRF, winners, claims and settlement.
- `ProjectDynoBuybackVault`: retained legacy implementation, initialized but inactive and unfunded in the no-sale model.
- Katana V3 adapter/guard: retained historical code and fork probes; not deployed by the current unsigned planner or used by checkout.
- `services/dyno-api`: wallet challenge, Discord-derived commitment, chain-read quota/voucher readiness, ledger/export and owner-selected encrypted SQLite storage on `/var/data`; legacy PostgreSQL indexing remains available.
- `services/dyno-indexer`: finalized log ingestion, hashes, dedupe, rollback and resume.
- `services/dyno-keeper`: phase-derived automation; dry-run by default.
- `website/public/dyno.*`: public dual-asset accounting, ledger, claim and multisig workspaces. The unfunded schedule and swap controls are not shown.
- `scripts/dyno`: local deployment, manifest validation, ABI export, deterministic replay, reconciliation and multisig preparation.

## Verification status

Current checkpoint, 2026-10-12: the owner-approved **storage-only** backend is Live on matttoken.com as commit `d0ea21856322d77b8c6127dd1eaedf4723fc3269`. Exact release checks: 49 tests, none skipped, and a clean production-only combined-process smoke test (126 packages). Live encrypted-SQLite health, existing website routes, Not launched page, and blocked voucher/admin routes passed. Discord configuration is enabled, but live consent/membership and off-disk disaster recovery are not verified. The release excludes contracts/keeper and unrelated game work. It patches critical proxy-addr and moderate qs advisories; ten existing low dependency findings remain.

Subsequent **local-only** work adds canonical V3 pool/fee guard checks, ten guard tests, explicit provider-finalized indexing, and block-pinned round/ticket/winner/buyback APIs. Read-only Ronin inspection resolves the candidate MATT/WRON pool, but one-hour history reads fail; swaps remain blocked. See [MARKET-VERIFICATION.md](MARKET-VERIFICATION.md) and [CURRENT-HANDOFF.md](CURRENT-HANDOFF.md). Source tests are not an audit, mobile acceptance test or production integration clearance.

### Historical local checks before storage deployment

Storage-only release preparation on 2026-10-12: `npm run test:dyno` passed **8 contract tests and 55 service/frontend checks**, none skipped; the two production-dependency checks also passed. `npm run test:dyno:runtime` passed an isolated clean production-only install (128 packages), full combined-server startup, encrypted database readiness, existing website routes and disabled DYNO purchase/admin/indexer checks, without compiled artifacts or the local manifest. The first sandboxed attempt could not read the existing npm cache; the permitted cache-access retry passed. Dashboard reads confirmed the existing disk and saved public settings, but secret contents, actual SQLite mount/runtime, live OAuth and DEX/VRF were not tested. No production release was pushed or deployed. See [DEPLOYMENT.md](DEPLOYMENT.md) for the explicit storage-only boundary.

Disk-storage verification on 2026-10-12: `npm run test:dyno` passed **8 contract tests and 49 service/frontend checks**, none skipped. `website/lib/production-dependencies.test.js` also passed its two checks. New coverage includes real local HTTP authentication across database/app restarts (Discord HTTP mocked), replay/logout durability, expiry, wrong-key/missing-mount refusal, encrypted identity observations, exact ledger/dedupe/checkpoints, reorgs through empty blocks, RPC outage refusal, same-instance loop liveness, atomic batch rollback, and integrity-verified backup/reopen. Syntax checks and local manifest validation passed. Node 22.23.2's experimental SQLite warning is expected and retained. Actual Render disk access, live Discord login, live PostgreSQL/fork integrations and operator-led restore were not tested. Nothing was deployed for this change.

Checkout-readiness changes verified locally on 2026-10-12:

- `npm run test:dyno`: 8 contract tests and 33 service/page tests passed. This run began before the checkout DOM harness was added to the npm script.
- `node --test services/dyno-api/*.test.js services/dyno-indexer/*.test.js services/dyno-keeper/*.test.js website/lib/dyno-page.test.js website/lib/dyno-checkout.test.js website/lib/discord-auth.test.js`: 36 checks passed, none skipped. The npm script now includes that harness.
- Syntax checks for the router, purchase-state reader and frontend; local manifest validation; `git diff --check`: passed (Git reports existing Windows line-ending warnings).

Frontend flow checks use a DOM/wallet harness with mock transactions, not a real-wallet/mobile-browser or live Discord acceptance test. No real RPC integration, funded swap, or deployment was performed for this change. See `IDENTITY-PRIVACY.md` for the chain-read quota policy and remaining durable-storage requirements.

Local mocks are functional. No mainnet/Saigon contract deployment or real asset movement occurred. Read-only inspection confirmed the Ronin multisig threshold/owners, Ethereum ERC721 ownership, MATT's 18 decimals, and factory-matching candidate pool. Token transfer behavior, deployed router and pool-history suitability remain unverified. Official Ronin documentation lists chain IDs 2020/202601 and VRF coordinators `0x16a62a921e7fec5bf867ff5c805b662db757b778` (mainnet) and `0xa60c1e07fa030e4b49eb54950adb298ab94dd312` (Saigon). Run the validator with `--onchain` before deployment; current checks are necessary but not comprehensive integration clearance.
