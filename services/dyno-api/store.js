"use strict";

const { Pool } = require("pg");
const { createMemoryAuthStore } = require("./auth-store");

function createStore({ connectionString = process.env.DATABASE_URL, production = process.env.NODE_ENV === "production", env = process.env, chainId = null } = {}) {
  const storage = env.DYNO_STORAGE || (env.DYNO_DATABASE_FILE ? "sqlite" : connectionString ? "postgres" : "memory");
  if (storage === "sqlite") return require("./sqlite-store").createSqliteStore({ env, production, chainId });
  if (!["memory", "postgres"].includes(storage)) throw new Error("DYNO_STORAGE must be sqlite, postgres, or memory");
  if (storage === "memory") { if (production) throw new Error("Project DYNO cannot use memory storage in production"); return createMemoryStore(); }
  if (!connectionString) {
    if (production) throw new Error("DATABASE_URL is required for Project DYNO in production");
    return createMemoryStore();
  }
  const pool = new Pool({ connectionString, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" } });
  return {
    kind: "postgres",
    async health() { const result = await pool.query("SELECT 1 AS ok"); return result.rows[0].ok === 1; },
    async ledger({ roundId, limit = 50, offset = 0 }) {
      const result = await pool.query(
        `SELECT block_number::text, encode(transaction_hash,'hex') tx_hash, log_index, event_name, payload
           FROM project_dyno.chain_events
          WHERE ($1::numeric IS NULL OR (payload->>'roundId')::numeric = $1)
          ORDER BY block_number DESC, log_index DESC LIMIT $2 OFFSET $3`,
        [roundId || null, Math.min(Number(limit), 250), Number(offset)]
      );
      return result.rows;
    },
    async checkpoint(chainId) {
      const result = await pool.query("SELECT block_number::text, encode(block_hash,'hex') hash FROM project_dyno.chain_checkpoints WHERE chain_id=$1", [chainId]);
      return result.rows[0] || null;
    },
    async anchors(chainId, before) {
      const result = await pool.query("SELECT DISTINCT block_number, '0x' || encode(block_hash,'hex') block_hash FROM project_dyno.chain_events WHERE chain_id=$1 AND block_number<$2 ORDER BY block_number DESC", [chainId, before]);
      return result.rows.map(row => ({ ...row, block_number: Number(row.block_number) }));
    },
    async rollback(chainId, ancestor) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM project_dyno.chain_events WHERE chain_id=$1 AND block_number>$2", [chainId, ancestor]);
        const anchor = await client.query("SELECT block_hash FROM project_dyno.chain_events WHERE chain_id=$1 AND block_number=$2 LIMIT 1", [chainId, ancestor]);
        if (anchor.rows[0]) await client.query("UPDATE project_dyno.chain_checkpoints SET block_number=$2,block_hash=$3,updated_at=now() WHERE chain_id=$1", [chainId, ancestor, anchor.rows[0].block_hash]);
        else await client.query("DELETE FROM project_dyno.chain_checkpoints WHERE chain_id=$1", [chainId]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    async applyBatch(chainId, events, block) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const event of events) await client.query(
          `INSERT INTO project_dyno.chain_events(chain_id,block_number,block_hash,transaction_hash,transaction_index,log_index,address,event_name,payload,finalized)
           VALUES($1,$2,decode($3,'hex'),decode($4,'hex'),$5,$6,decode($7,'hex'),$8,$9,true) ON CONFLICT(chain_id,transaction_hash,log_index) DO NOTHING`,
          [chainId, event.blockNumber, event.blockHash.slice(2), event.transactionHash.slice(2), event.transactionIndex, event.index, event.address.slice(2), event.name, event.payload]
        );
        await client.query(`INSERT INTO project_dyno.chain_checkpoints(chain_id,block_number,block_hash,updated_at) VALUES($1,$2,decode($3,'hex'),now())
          ON CONFLICT(chain_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,updated_at=now()`, [chainId, block.number, block.hash.slice(2)]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}

function createMemoryStore() {
  const events = [];
  return {
    kind: "memory-demo",
    auth: createMemoryAuthStore(),
    async health() { return true; },
    async ledger({ roundId, limit = 50, offset = 0 }) { return events.filter(row => !roundId || String(row.payload.roundId) === String(roundId)).slice(offset, offset + limit); },
    _events: events,
    async close() {},
  };
}

module.exports = { createStore, createMemoryStore };
