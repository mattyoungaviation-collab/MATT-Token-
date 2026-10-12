BEGIN;
CREATE SCHEMA IF NOT EXISTS project_dyno;

CREATE TABLE IF NOT EXISTS project_dyno.chain_checkpoints (
  chain_id bigint PRIMARY KEY,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_dyno.chain_events (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL,
  transaction_hash bytea NOT NULL,
  transaction_index integer NOT NULL,
  log_index integer NOT NULL,
  address bytea NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  finalized boolean NOT NULL DEFAULT false,
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS dyno_events_block ON project_dyno.chain_events(chain_id, block_number);
CREATE TABLE IF NOT EXISTS project_dyno.discord_identities (
  discord_user_id text PRIMARY KEY,
  display_name text NOT NULL,
  account_commitment bytea UNIQUE NOT NULL,
  identity_version integer NOT NULL DEFAULT 1,
  suspended boolean NOT NULL DEFAULT false,
  oauth_token_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_dyno.wallet_links (
  discord_user_id text NOT NULL REFERENCES project_dyno.discord_identities(discord_user_id),
  wallet bytea NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  approved_tx_hash bytea,
  PRIMARY KEY (discord_user_id, wallet, linked_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS dyno_active_wallet_link ON project_dyno.wallet_links(wallet) WHERE unlinked_at IS NULL;
CREATE TABLE IF NOT EXISTS project_dyno.review_evidence (
  evidence_hash bytea PRIMARY KEY,
  round_id numeric(78,0) NOT NULL,
  ticket_id numeric(78,0) NOT NULL,
  reason_code text NOT NULL,
  encrypted_reference bytea NOT NULL,
  created_by bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_dyno.identity_audit (
  id bigserial PRIMARY KEY,
  discord_user_id text NOT NULL,
  action text NOT NULL,
  actor_wallet bytea,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
