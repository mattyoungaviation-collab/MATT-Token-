BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS dyno_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS auth_records (
  scope TEXT NOT NULL, key_digest TEXT NOT NULL, ciphertext BLOB NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(scope,key_digest)
) STRICT;
CREATE INDEX IF NOT EXISTS auth_expiry ON auth_records(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope TEXT NOT NULL, key_digest TEXT NOT NULL, window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL, PRIMARY KEY(scope,key_digest)
) STRICT;
CREATE TABLE IF NOT EXISTS identity_observations (
  commitment TEXT PRIMARY KEY, discord_digest TEXT UNIQUE NOT NULL,
  ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS identity_observation_audit (
  id INTEGER PRIMARY KEY, commitment TEXT NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS chain_checkpoints (
  chain_id TEXT PRIMARY KEY, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS chain_blocks (
  chain_id TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
  PRIMARY KEY(chain_id,block_number)
) STRICT;
CREATE TABLE IF NOT EXISTS chain_events (
  chain_id TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL, transaction_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
  address TEXT NOT NULL, event_name TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  round_id TEXT, finalized INTEGER NOT NULL CHECK(finalized=1),
  PRIMARY KEY(chain_id,transaction_hash,log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS events_block ON chain_events(chain_id,block_number);
CREATE INDEX IF NOT EXISTS events_round ON chain_events(round_id,block_number);
PRAGMA application_id = 1146703439;
PRAGMA user_version = 1;
COMMIT;
