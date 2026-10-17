"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");

function inside(root, filename) { const relative = path.relative(root, filename); return relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); }
function storageLocation(env = process.env, production = false) {
  const mount = env.RENDER_DISK_PATH || env.PERSISTENT_DISK_PATH || (fs.existsSync("/var/data") ? "/var/data" : "");
  const filename = env.DYNO_DATABASE_FILE || (mount ? path.join(mount, "project-dyno", "dyno.sqlite") : "");
  if (!filename || !path.isAbsolute(filename)) throw new Error("DYNO_DATABASE_FILE must be an absolute SQLite file path");
  const resolved = path.resolve(filename);
  if (production) {
    if (!mount || !path.isAbsolute(mount) || !fs.existsSync(mount)) throw new Error("Project DYNO persistent disk must be mounted before startup");
    const root = fs.realpathSync(mount);
    if (!inside(root, resolved)) throw new Error("DYNO_DATABASE_FILE must be inside the configured persistent disk");
    // Reject escaping symlinks, including an existing database-file symlink.
    let parent = resolved;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const real = fs.realpathSync(parent);
    if (real !== root && !inside(root, real)) throw new Error("Project DYNO database path escapes the persistent disk");
  }
  return resolved;
}
function encryptionKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("DYNO_STORAGE_KEY must be a base64-encoded 32-byte secret");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error("DYNO_STORAGE_KEY is invalid");
  return key;
}

function createSqliteStore({ env = process.env, production = false, chainId = null } = {}) {
  const key = encryptionKey(env.DYNO_STORAGE_KEY);
  const filename = storageLocation(env, production);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 18) throw new Error("Disk-backed Project DYNO requires the tested Node 22.18+ runtime (22.x)");
  const { DatabaseSync, backup } = require("node:sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  // Reserve newly created files privately before SQLite opens them.
  try { fs.closeSync(fs.openSync(filename, "wx", 0o600)); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const db = new DatabaseSync(filename, { timeout: 5000, allowExtension: false });
  const transaction = callback => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const fingerprint = secret => crypto.createHash("sha256").update(secret).digest("hex");
  function bindKey(name, value) {
    const existing = db.prepare("SELECT value FROM dyno_meta WHERE key=?").get(name);
    if (existing && existing.value !== value) throw new Error("Project DYNO storage/identity key mismatch; restore the existing key or perform a reviewed migration");
    db.prepare("INSERT INTO dyno_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(name, value);
  }
  function bindIdentityKey(secret) {
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error("DYNO_IDENTITY_SECRET must contain at least 32 bytes");
    bindKey("identity-key-v1", fingerprint(secret));
  }
  try {
    const appId = db.prepare("PRAGMA application_id").get().application_id;
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const tableCount = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    if ((appId !== 1146703439 && tableCount !== 0) || version > 1) throw new Error("Not a supported Project DYNO database; refusing to modify it");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    db.exec(fs.readFileSync(path.join(__dirname, "migrations/002_sqlite.sql"), "utf8"));
    transaction(() => {
      bindKey("storage-key-v1", fingerprint(key));
      if (production || env.DYNO_IDENTITY_SECRET) bindIdentityKey(env.DYNO_IDENTITY_SECRET);
    });
  } catch (error) { db.close(); throw error; }

  const digest = (scope, id) => crypto.createHmac("sha256", key).update(`${scope}\0${id}`).digest("hex");
  function seal(value, context) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }
  function open(value, context) {
    const data = Buffer.from(value), decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
  }
  const auth = {
    kind: "sqlite-encrypted",
    put(scope, id, value, expiresAt) {
      if (!Number.isSafeInteger(expiresAt)) throw new Error("Invalid authentication expiry");
      const hash = digest(scope, id);
      db.prepare("INSERT INTO auth_records VALUES(?,?,?,?) ON CONFLICT(scope,key_digest) DO UPDATE SET ciphertext=excluded.ciphertext,expires_at=excluded.expires_at").run(scope, hash, seal(value, `${scope}:${hash}`), expiresAt);
    },
    get(scope, id, now = Date.now()) {
      if (!id) return null;
      const hash = digest(scope, id), row = db.prepare("SELECT ciphertext,expires_at FROM auth_records WHERE scope=? AND key_digest=?").get(scope, hash);
      if (!row) return null;
      if (row.expires_at <= now) { this.delete(scope, id); return null; }
      return open(row.ciphertext, `${scope}:${hash}`);
    },
    take(scope, id, now = Date.now()) { return transaction(() => { const value = this.get(scope, id, now); this.delete(scope, id); return value; }); },
    delete(scope, id) { db.prepare("DELETE FROM auth_records WHERE scope=? AND key_digest=?").run(scope, digest(scope, id)); },
    prune(now = Date.now()) {
      db.prepare("DELETE FROM auth_records WHERE expires_at<=?").run(now);
      db.prepare("DELETE FROM auth_rate_limits WHERE window_start<?").run(now - 86_400_000);
    },
    consumeRateLimit(scope, id, { limit, windowMs, now = Date.now() }) {
      if (!scope || !id || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000 || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid authentication rate limit");
      const keyDigest = digest(`rate:${scope}`, id), windowStart = Math.floor(now / windowMs) * windowMs;
      return transaction(() => {
        db.prepare("INSERT INTO auth_rate_limits(scope,key_digest,window_start,request_count) VALUES(?,?,?,1) ON CONFLICT(scope,key_digest) DO UPDATE SET window_start=excluded.window_start,request_count=CASE WHEN auth_rate_limits.window_start=excluded.window_start THEN auth_rate_limits.request_count+1 ELSE 1 END")
          .run(scope, keyDigest, windowStart);
        return db.prepare("SELECT request_count FROM auth_rate_limits WHERE scope=? AND key_digest=?").get(scope, keyDigest).request_count <= limit;
      });
    },
    observeIdentity(observation, identitySecret) {
      transaction(() => {
        bindIdentityKey(identitySecret);
        const discordDigest = digest("discord-identity", observation.discordUserId), context = `identity:${observation.commitment}`;
        const previous = db.prepare("SELECT commitment,ciphertext FROM identity_observations WHERE discord_digest=?").get(discordDigest);
        if (previous && previous.commitment !== observation.commitment) throw new Error("Identity commitment changed without migration");
        const record = { ...observation, observedAt: Date.now(), bindingAuthority: "chain-only" };
        // Private observation history does not create/relink an on-chain binding.
        db.prepare("INSERT INTO identity_observations VALUES(?,?,?,?) ON CONFLICT(commitment) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at").run(observation.commitment, discordDigest, seal(record, context), record.observedAt);
        const oldRecord = previous ? open(previous.ciphertext, context) : null;
        if (!oldRecord || oldRecord.wallet !== record.wallet || oldRecord.identityVersion !== record.identityVersion) db.prepare("INSERT INTO identity_observation_audit(commitment,ciphertext,created_at) VALUES(?,?,?)").run(record.commitment, seal(record, `audit:${record.commitment}`), record.observedAt);
      });
    },
    listIdentityObservations({ limit = 50, offset = 0 } = {}) {
      const count = Number(limit), start = Number(offset);
      if (!Number.isSafeInteger(count) || count < 1 || count > 250 || !Number.isSafeInteger(start) || start < 0) throw new Error("Invalid private export pagination");
      return db.prepare("SELECT commitment,ciphertext FROM identity_observations ORDER BY updated_at DESC,commitment LIMIT ? OFFSET ?")
        .all(count, start)
        .map(row => {
          const record = open(row.ciphertext, `identity:${row.commitment}`);
          return {
            commitment: row.commitment,
            discordUserId: record.discordUserId,
            displayName: record.displayName,
            wallet: record.wallet,
            identityVersion: record.identityVersion,
            chainId: record.chainId,
            blockNumber: record.blockNumber,
            blockHash: record.blockHash,
            bindingConfirmed: record.bindingConfirmed,
            observedAt: record.observedAt,
          };
        });
    },
    listIdentityObservationHistory({ commitment, limit = 50, offset = 0 } = {}) {
      const count = Number(limit), start = Number(offset);
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(commitment)) || !Number.isSafeInteger(count) || count < 1 || count > 250 || !Number.isSafeInteger(start) || start < 0) throw new Error("Invalid private identity history request");
      return db.prepare("SELECT id,ciphertext,created_at FROM identity_observation_audit WHERE commitment=? ORDER BY id DESC LIMIT ? OFFSET ?")
        .all(commitment, count, start)
        .map(row => {
          const record = open(row.ciphertext, `audit:${commitment}`);
          return { auditId: row.id, commitment, discordUserId: record.discordUserId, displayName: record.displayName, wallet: record.wallet,
            identityVersion: record.identityVersion, chainId: record.chainId, blockNumber: record.blockNumber, blockHash: record.blockHash,
            bindingConfirmed: record.bindingConfirmed, observedAt: record.observedAt, auditCreatedAt: row.created_at };
        });
    },
  };
  const store = {
    kind: "sqlite", auth, filename,
    async health() { return db.prepare("PRAGMA quick_check").get().quick_check === "ok"; },
    async ledger({ roundId, wallet, eventName, limit = 50, offset = 0 } = {}) {
      const count = Number(limit), start = Number(offset);
      if (!Number.isInteger(count) || count < 1 || !Number.isInteger(start) || start < 0) throw new Error("Invalid ledger pagination");
      return db.prepare("SELECT CAST(block_number AS TEXT) block_number, substr(transaction_hash,3) tx_hash, log_index,event_name,payload FROM chain_events WHERE (? IS NULL OR round_id=?) AND (? IS NULL OR chain_id=?) AND (? IS NULL OR lower(json_extract(payload,'$.wallet'))=?) AND (? IS NULL OR event_name=?) ORDER BY block_number DESC, transaction_index DESC,log_index DESC LIMIT ? OFFSET ?")
        .all(roundId || null, roundId || null, chainId === null ? null : String(chainId), chainId === null ? null : String(chainId), wallet || null, wallet?.toLowerCase() || null, eventName || null, eventName || null, Math.min(count, 1000), start)
        .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    async checkpoint(id) { const row = db.prepare("SELECT CAST(block_number AS TEXT) block_number,substr(block_hash,3) hash FROM chain_checkpoints WHERE chain_id=?").get(String(id)); return row ? { ...row } : null; },
    async anchors(id, before) { return db.prepare("SELECT block_number,block_hash FROM chain_blocks WHERE chain_id=? AND block_number<? ORDER BY block_number DESC").all(String(id), before); },
    async rollback(id, ancestor) {
      transaction(() => {
        db.prepare("DELETE FROM chain_events WHERE chain_id=? AND block_number>?").run(String(id), ancestor);
        db.prepare("DELETE FROM chain_blocks WHERE chain_id=? AND block_number>?").run(String(id), ancestor);
        const block = db.prepare("SELECT block_hash FROM chain_blocks WHERE chain_id=? AND block_number=?").get(String(id), ancestor);
        if (block) db.prepare("UPDATE chain_checkpoints SET block_number=?,block_hash=? WHERE chain_id=?").run(ancestor, block.block_hash, String(id));
        else db.prepare("DELETE FROM chain_checkpoints WHERE chain_id=?").run(String(id));
      });
    },
    async applyBatch(id, events, block) {
      transaction(() => {
        const insert = db.prepare("INSERT INTO chain_events VALUES(?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(chain_id,transaction_hash,log_index) DO NOTHING");
        for (const event of events) {
          insert.run(String(id), event.blockNumber, event.blockHash.toLowerCase(), event.transactionHash.toLowerCase(), event.transactionIndex, event.index, event.address.toLowerCase(), event.name, JSON.stringify(event.payload), event.payload.roundId ? String(event.payload.roundId) : null);
          db.prepare("INSERT INTO chain_blocks VALUES(?,?,?) ON CONFLICT(chain_id,block_number) DO UPDATE SET block_hash=excluded.block_hash").run(String(id), event.blockNumber, event.blockHash.toLowerCase());
        }
        db.prepare("INSERT INTO chain_blocks VALUES(?,?,?) ON CONFLICT(chain_id,block_number) DO UPDATE SET block_hash=excluded.block_hash").run(String(id), block.number, block.hash.toLowerCase());
        db.prepare("INSERT INTO chain_checkpoints VALUES(?,?,?) ON CONFLICT(chain_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash").run(String(id), block.number, block.hash.toLowerCase());
      });
    },
    async backup(destination) {
      if (!path.isAbsolute(destination) || destination === filename || fs.existsSync(destination)) throw new Error("Backup requires a new absolute destination file");
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(destination, "wx", 0o600));
      await backup(db, destination);
      const copy = new DatabaseSync(destination, { readOnly: true });
      try { if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Backup integrity verification failed"); } finally { copy.close(); }
      return { verified: true };
    },
    async close() { db.close(); },
  };
  return store;
}
module.exports = { createSqliteStore, storageLocation, encryptionKey };
