"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createSqliteStore, storageLocation } = require("./sqlite-store");
const { createStore } = require("./store");
const { identityCommitment } = require("./identity");
const { prepareRestoredStorage } = require("../../scripts/dyno/prepare-restored-storage");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dyno-storage-test-"));
  const env = { DYNO_STORAGE: "sqlite", PERSISTENT_DISK_PATH: directory, DYNO_DATABASE_FILE: path.join(directory, "project-dyno", "dyno.sqlite"), DYNO_STORAGE_KEY: Buffer.alloc(32, 7).toString("base64"), DYNO_IDENTITY_SECRET: "test-identity-secret-".repeat(3) };
  const handles = [];
  const open = () => { const store = createSqliteStore({ env, production: true, chainId: 31337 }); handles.push(store); return store; };
  t.after(async () => {
    for (const store of handles) { try { await store.close(); } catch {} }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("dyno-storage-test-")) throw new Error("Unsafe test cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { env, directory, open };
}
const hash = byte => "0x" + byte.repeat(64);
const event = (overrides = {}) => ({ blockNumber: 10, blockHash: hash("1"), transactionHash: hash("2"), transactionIndex: 0, index: 0,
  address: "0x" + "3".repeat(40), name: "TicketPurchased", payload: { roundId: "1", ticketId: "90071992547409930000", saleRon: "12148876400000000000000" }, ...overrides });

test("wallet history filters before pagination and follows index rollback", async t => {
  const store = fixture(t).open(), wallet = "0x" + "a".repeat(40), other = "0x" + "b".repeat(40);
  const rows = [
    event({ index: 0, payload: { roundId: "1", ticketId: "1", wallet } }),
    event({ index: 1, payload: { roundId: "1", ticketId: "2", wallet: other } }),
    event({ index: 2, name: "RefundCredited", payload: { roundId: "1", ticketId: "1", wallet } }),
    event({ index: 3, payload: { roundId: "2", ticketId: "3", wallet } }),
  ];
  await store.applyBatch(31337, rows, { number: 10, hash: hash("1") });
  const query = { wallet: wallet.toUpperCase(), eventName: "TicketPurchased", limit: 1 };
  assert.equal((await store.ledger(query))[0].payload.ticketId, "3");
  assert.equal((await store.ledger({...query, offset: 1}))[0].payload.ticketId, "1");
  await store.rollback(31337, 9);
  assert.equal((await store.ledger(query)).length, 0);
});

test("encrypted wallet/Discord records survive close/reopen; expired and consumed nonces stay consumed", async t => {
  const f = fixture(t), first = f.open(), expiresAt = Date.now() + 300000;
  first.auth.put("discord-flow", "private-oauth-state", { wallet: "0xwallet", expiresAt }, expiresAt);
  first.auth.put("discord-session", "private-cookie-token", { discordUserId: "123456789012345678", username: "Private display name", wallet: "0xwallet", expiresAt }, expiresAt);
  await first.close(); const second = f.open();
  assert.equal(second.auth.get("discord-session", "private-cookie-token").username, "Private display name");
  assert.ok(second.auth.take("discord-flow", "private-oauth-state")); assert.equal(second.auth.take("discord-flow", "private-oauth-state"), null);
  assert.equal(second.auth.get("discord-session", "private-cookie-token", expiresAt), null);
  await second.close(); const third = f.open();
  assert.equal(third.auth.get("discord-flow", "private-oauth-state"), null); assert.equal(third.auth.get("discord-session", "private-cookie-token"), null);
  for (const name of fs.readdirSync(path.dirname(f.env.DYNO_DATABASE_FILE))) {
    const contents = fs.readFileSync(path.join(path.dirname(f.env.DYNO_DATABASE_FILE), name));
    for (const value of ["private-oauth-state", "private-cookie-token", "123456789012345678", "Private display name"]) assert.equal(contents.includes(Buffer.from(value)), false);
  }
});
test("two database connections cannot consume the same challenge twice", t => {
  const f = fixture(t), a = f.open(), b = f.open(), expiresAt = Date.now() + 10000;
  a.auth.put("wallet-challenge", "0xwallet", { nonce: "secret-nonce" }, expiresAt);
  assert.equal(b.auth.take("wallet-challenge", "0xwallet").nonce, "secret-nonce");
  assert.equal(a.auth.take("wallet-challenge", "0xwallet"), null);
});
test("authentication throttles persist across local connections without storing a raw IP", async t => {
  const f = fixture(t), a = f.open(), b = f.open(), now = 2_000_000;
  assert.equal(a.auth.consumeRateLimit("nonce-ip", "192.0.2.7", { limit: 2, windowMs: 300_000, now }), true);
  assert.equal(b.auth.consumeRateLimit("nonce-ip", "192.0.2.7", { limit: 2, windowMs: 300_000, now }), true);
  assert.equal(a.auth.consumeRateLimit("nonce-ip", "192.0.2.7", { limit: 2, windowMs: 300_000, now }), false);
  await a.close(); await b.close();
  const restarted = f.open();
  assert.equal(restarted.auth.consumeRateLimit("nonce-ip", "192.0.2.7", { limit: 2, windowMs: 300_000, now }), false);
  assert.equal(restarted.auth.consumeRateLimit("nonce-ip", "192.0.2.7", { limit: 2, windowMs: 300_000, now: now + 300_000 }), true);
  const bytes = fs.readFileSync(f.env.DYNO_DATABASE_FILE);
  assert.equal(bytes.includes(Buffer.from("192.0.2.7")), false);
});
test("wrong storage/identity keys and unsupported databases fail closed without silently resetting data", async t => {
  const f = fixture(t), store = f.open();
  store.auth.put("wallet-session", "cookie", { wallet: "original-wallet" }, Date.now() + 10000);
  await store.close();
  assert.throws(() => createSqliteStore({ env: { ...f.env, DYNO_STORAGE_KEY: Buffer.alloc(32, 8).toString("base64") }, production: true }), /key mismatch/);
  assert.throws(() => createSqliteStore({ env: { ...f.env, DYNO_IDENTITY_SECRET: "changed-identity-secret".repeat(3) }, production: true }), /key mismatch/);
  assert.equal(f.open().auth.get("wallet-session", "cookie").wallet, "original-wallet");
  const { DatabaseSync } = require("node:sqlite"), unrelated = path.join(f.directory, "unrelated.sqlite"), db = new DatabaseSync(unrelated);
  db.exec("CREATE TABLE unrelated(data TEXT)"); db.close();
  assert.throws(() => createSqliteStore({ env: { ...f.env, DYNO_DATABASE_FILE: unrelated }, production: true }), /Not a supported/);
});
test("missing key/mount and paths outside the disk cannot create a production database", t => {
  const f = fixture(t);
  assert.throws(() => createSqliteStore({ env: { ...f.env, DYNO_STORAGE_KEY: "" }, production: true }), /DYNO_STORAGE_KEY/);
  assert.equal(fs.existsSync(f.env.DYNO_DATABASE_FILE), false);
  assert.throws(() => storageLocation({ ...f.env, PERSISTENT_DISK_PATH: path.join(f.directory, "absent") }, true), /mounted/);
  assert.throws(() => storageLocation({ ...f.env, DYNO_DATABASE_FILE: path.join(os.tmpdir(), "outside.sqlite") }, true), /inside/);
  assert.throws(() => storageLocation({ DYNO_DATABASE_FILE: "relative.sqlite" }, true), /absolute/);
  assert.throws(() => createStore({ env: { DYNO_STORAGE: "memory" }, production: true }), /memory storage/);
});
test("identity observations keep an encrypted stable mapping/audit without becoming a ticket ledger", t => {
  const f = fixture(t), store = f.open(), discordUserId = "123456789012345678", commitment = identityCommitment(discordUserId, f.env.DYNO_IDENTITY_SECRET);
  const observation = { commitment, discordUserId, displayName: "Private identity", wallet: "0xfirst", identityVersion: 1, bindingConfirmed: false };
  store.auth.observeIdentity(observation, f.env.DYNO_IDENTITY_SECRET);
  store.auth.observeIdentity({ ...observation, wallet: "0xsecond", identityVersion: 2, bindingConfirmed: true }, f.env.DYNO_IDENTITY_SECRET);
  const privateRows = store.auth.listIdentityObservations({ limit: 1 });
  assert.equal(privateRows.length, 1); assert.equal(privateRows[0].discordUserId, discordUserId);
  assert.equal(privateRows[0].wallet, "0xsecond"); assert.equal(privateRows[0].bindingConfirmed, true);
  assert.equal("ciphertext" in privateRows[0], false);
  const history = store.auth.listIdentityObservationHistory({ commitment, limit: 10 });
  assert.deepEqual(history.map(row => row.wallet), ["0xsecond", "0xfirst"]);
  assert.equal(history[0].identityVersion, 2);
  assert.equal("ciphertext" in history[0], false);
  assert.throws(() => store.auth.listIdentityObservationHistory({ commitment: "not-a-commitment" }), /Invalid private identity history/);
  assert.throws(() => store.auth.observeIdentity({ ...observation, commitment: hash("f") }, f.env.DYNO_IDENTITY_SECRET), /without migration/);
  const { DatabaseSync } = require("node:sqlite"), reader = new DatabaseSync(f.env.DYNO_DATABASE_FILE, { readOnly: true });
  try {
    assert.equal(reader.prepare("SELECT count(*) n FROM identity_observations").get().n, 1);
    assert.equal(reader.prepare("SELECT count(*) n FROM identity_observation_audit").get().n, 2);
    assert.equal(reader.prepare("SELECT count(*) n FROM chain_events").get().n, 0);
  } finally { reader.close(); }
});
test("chain ledger deduplicates exact large amounts, checkpoints survive restart, and rollback preserves private sessions", async t => {
  const f = fixture(t), store = f.open();
  store.auth.put("wallet-session", "cookie", { wallet: "original" }, Date.now() + 10000);
  await store.applyBatch(31337, [event(), event()], { number: 10, hash: hash("1") });
  await store.applyBatch(31337, [], { number: 20, hash: hash("4") });
  const rows = await store.ledger({ roundId: "1" }); assert.equal(rows.length, 1); assert.equal(rows[0].payload.saleRon, "12148876400000000000000");
  await store.close(); const restarted = f.open();
  assert.deepEqual(await restarted.checkpoint(31337), { block_number: "20", hash: "4".repeat(64) });
  await restarted.rollback(31337, 10); assert.equal((await restarted.checkpoint(31337)).block_number, "10");
  assert.equal(restarted.auth.get("wallet-session", "cookie").wallet, "original");
  assert.equal((await restarted.ledger({ roundId: "2" })).length, 0);
});
test("failed event batch rolls back checkpoint and all rows atomically", async t => {
  const f = fixture(t), store = f.open();
  await assert.rejects(store.applyBatch(31337, [event(), event({ transactionHash: hash("5"), transactionIndex: undefined })], { number: 10, hash: hash("1") }));
  assert.equal(await store.checkpoint(31337), null); assert.equal((await store.ledger({})).length, 0);
});
test("online SQLite backup restores private sessions and checkpoint; backup never overwrites an existing file", async t => {
  const f = fixture(t), store = f.open(), destination = path.join(f.directory, "backups", "verified.sqlite");
  store.auth.put("discord-session", "cookie", { username: "Backed-up private name" }, Date.now() + 10000);
  await store.applyBatch(31337, [event()], { number: 10, hash: hash("1") });
  assert.deepEqual(await store.backup(destination), { verified: true });
  const restored = createSqliteStore({ env: { ...f.env, DYNO_DATABASE_FILE: destination }, production: true });
  try { assert.equal(restored.auth.get("discord-session", "cookie").username, "Backed-up private name"); assert.equal((await restored.checkpoint(31337)).block_number, "10"); }
  finally { await restored.close(); }
  await assert.rejects(store.backup(destination), /new absolute destination/);
});
test("offline restore preparation invalidates copied auth only, preserving original backup, identity and chain history", async t => {
  const f = fixture(t), store = f.open(), source = path.join(f.directory, "backups", "source.sqlite"), destination = path.join(f.directory, "backups", "prepared.sqlite");
  const discordUserId = "123456789012345678", commitment = identityCommitment(discordUserId, f.env.DYNO_IDENTITY_SECRET);
  store.auth.put("wallet-challenge", "wallet", { nonce: "old-challenge" }, Date.now() + 300000);
  store.auth.put("discord-session", "cookie", { discordUserId }, Date.now() + 300000);
  store.auth.observeIdentity({ commitment, discordUserId, wallet: "0xfirst", identityVersion: 1 }, f.env.DYNO_IDENTITY_SECRET);
  await store.applyBatch(31337, [event()], { number: 10, hash: hash("1") });
  await store.backup(source);
  const preview = prepareRestoredStorage(source, destination);
  assert.equal(preview.authRecordsToInvalidate, 2); assert.equal(fs.existsSync(destination), false);
  const result = prepareRestoredStorage(source, destination, { apply: true });
  assert.equal(result.authRecordsInvalidated, 2);
  assert.throws(() => prepareRestoredStorage(source, destination, { apply: true }), /Destination must be a new/);
  const copied = createSqliteStore({ env: { ...f.env, DYNO_DATABASE_FILE: destination }, production: true, chainId: 31337 });
  try {
    assert.equal(copied.auth.get("wallet-challenge", "wallet"), null);
    assert.equal(copied.auth.get("discord-session", "cookie"), null);
    assert.equal((await copied.checkpoint(31337)).block_number, "10");
    assert.equal((await copied.ledger({ roundId: "1" })).length, 1);
    assert.doesNotThrow(() => copied.auth.observeIdentity({ commitment, discordUserId, wallet: "0xfirst", identityVersion: 1 }, f.env.DYNO_IDENTITY_SECRET));
  } finally { await copied.close(); }
  const original = createSqliteStore({ env: { ...f.env, DYNO_DATABASE_FILE: source }, production: true });
  try { assert.equal(original.auth.get("wallet-challenge", "wallet").nonce, "old-challenge"); }
  finally { await original.close(); }
});
test("restore preparation refuses unrelated databases and never creates their destination", t => {
  const f = fixture(t), source = path.join(f.directory, "unrelated.sqlite"), destination = path.join(f.directory, "prepared.sqlite");
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(source);
  db.exec("CREATE TABLE unrelated(value TEXT)"); db.close();
  assert.throws(() => prepareRestoredStorage(source, destination, { apply: true }), /supported Project DYNO database/);
  assert.equal(fs.existsSync(destination), false);
});
