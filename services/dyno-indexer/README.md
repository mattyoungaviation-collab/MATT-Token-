# Project DYNO indexer

Selected Render mode: set `DYNO_STORAGE=sqlite`, `RENDER_DISK_PATH=/var/data`, `DYNO_DATABASE_FILE=/var/data/project-dyno/dyno.sqlite`, private `DYNO_STORAGE_KEY` and the stable private `DYNO_IDENTITY_SECRET`. SQLite initializes its own schema at runtime. Run the indexer on the same service instance as the API; another Render service cannot access its disk.

The web service can run the continuous read-only loop with `DYNO_INDEXER_ENABLED=true` after approving the nonmock manifest, RPC, `DYNO_START_BLOCK` and finality policy. `/api/dyno/indexer-health` reports last sync status and checkpoint without exposing credentials. The loop prevents overlapping passes and redacts RPC failures. It has no treasury or transaction authority.

Standalone same-host command: configure `DYNO_RPC_URL`, `DYNO_CHAIN_ID`, `DYNO_RAFFLE_ADDRESS`, `DYNO_BUYBACK_ADDRESS`, `DYNO_START_BLOCK` and finality, then run `node services/dyno-indexer/indexer.js` repeatedly under a supervisor. As an unselected legacy alternative, PostgreSQL uses `migrations/001_project_dyno.sql`, `DYNO_STORAGE=postgres` and `DATABASE_URL`; its live adapter was not exercised for the disk change.

Each pass indexes only finalized blocks, deduplicates by `(chain_id, transaction_hash, log_index)`, stores block hashes including empty batch checkpoints, detects a checkpoint hash mismatch, rolls back orphaned rows to a matching anchor, and resumes. Missing RPC history refuses destructive rollback. ABI input names are explicitly decoded; all bigints are exact strings. The database is an index; contract reads and event replay remain authoritative. Private authentication is never rolled back with chain projections.
