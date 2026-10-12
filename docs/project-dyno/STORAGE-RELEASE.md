# Project DYNO storage-only release

This release adds encrypted disk-backed wallet/Discord authentication, database checks/online backups, and fail-closed production staging. It is not the full raffle launch. No DYNO contracts, keeper, trading, ticket checkout frontend or mainnet deployment scripts are included in this release. Supporting chain-read API/indexer modules are dormant until a later verified release.

Production defaults to `DYNO_LIVE_ENABLED=false`. `/dyno` shows **Not launched**, with no payment controls. `/api/dyno/health` and `/config` report readiness without mock or invented contract addresses; all other DYNO APIs return 503. The legacy off-chain `/api/dyno-raffle` entry service is not installed; its existing disk file is untouched. Other game routes and funds are not modified.

Required runtime settings:

```dotenv
NODE_ENV=production
DYNO_STORAGE=sqlite
RENDER_DISK_PATH=/var/data
DYNO_DATABASE_FILE=/var/data/project-dyno/dyno.sqlite
DYNO_INDEXER_ENABLED=false
DYNO_LIVE_ENABLED=false
```

`DYNO_STORAGE_KEY` must privately contain exactly 32 random bytes in canonical base64; `DYNO_IDENTITY_SECRET` must privately contain at least 32 bytes and remain stable. Neither is a wallet key. Preserve both separately from database backups; incorrect/changed keys refuse startup rather than resetting identities. Never print them, commit them or paste them into chat.

The selected Node 22.18+ (22.x) SQLite API is experimental. The production disk must already exist; only the private `project-dyno` subdirectory is initialized at runtime. The store uses authenticated encryption, keyed private identifiers, WAL/FULL synchronization, exact monetary strings for public events and durable single-use authentication state. PostgreSQL remains an optional legacy development/indexer path, not this selected production storage.

Run `npm run check:dyno:storage` in the mounted runtime to validate configuration without printing secrets or opening the database. `npm run backup:dyno:storage` creates an integrity-verified new database backup under its private `backups/` folder. Local backups on the same disk are not disaster recovery: move them to approved owner-controlled encrypted off-disk storage. A live restore needs maintenance approval, retained old files and invalidation of restored authentication records; never restore unrelated game files as part of a DYNO restore.

Discord still uses the configured client/server and public callback, requests `identify guilds.members.read`, binds OAuth state to an HttpOnly Secure browser cookie, verifies membership, and retains no OAuth access/refresh token. It verifies an account, not unique personhood. Existing sessions will need one fresh login when switching from memory to disk. User consent/sign-in must be completed by the user; the release does not authorize broader access or account changes.

Verification commands: `npm run test:dyno:storage` and `npm run test:dyno:runtime`. The runtime check uses isolated temporary disk/RPC fixtures and production-only dependencies. The deployed baseline included vulnerable HTTP transitives; this release patches only `proxy-addr` 2.0.7 → 2.0.8 and `qs` 6.15.3 → 6.16.0, plus the explicitly pinned new backend `pg` dependency. Other existing package versions/integrities are unchanged. Proxy subnet spoofing has a regression test. See the [proxy-addr maintainer advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) and [qs advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g). Existing low-severity ethers v5/elliptic findings remain; no broad automatic dependency fix is applied.

Live DEX/VRF, wallets, Discord consent and off-disk backup transfer require separate acceptance checks. No audit or production raffle readiness is claimed. Enabling live DYNO still requires an explicit verified production manifest, further implemented release work, funding and explicit launch authorization.
