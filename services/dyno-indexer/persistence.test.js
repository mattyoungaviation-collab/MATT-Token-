"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Interface } = require("ethers");
const { createSqliteStore } = require("../dyno-api/sqlite-store");
const { DynoIndexer } = require("./indexer");
const address = "0x" + "1".repeat(40), vault = "0x" + "2".repeat(40);
const abi = ["event TicketPurchased(uint256 indexed roundId,uint256 indexed ticketId,address indexed wallet,bytes32 accountCommitment,uint64 dayIndex,uint256 directRon,uint256 saleRon)"];
const iface = new Interface(abi), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dyno-index-test-"));
  const env = { DYNO_DATABASE_FILE: path.join(directory, "dyno.sqlite"), DYNO_STORAGE_KEY: Buffer.alloc(32, 9).toString("base64") };
  const stores = [], blocks = new Map(Array.from({ length: 31 }, (_, number) => [number, { number, hash: hash(number + 1) }]));
  let logs = [], reportedChain = "0x7a69";
  const provider = { send: async () => reportedChain, getBlockNumber: async () => 30, getBlock: async number => blocks.get(number),
    getLogs: async ({ fromBlock, toBlock }) => logs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock) };
  const open = () => { const store = createSqliteStore({ env }); stores.push(store); return store; };
  const makeIndexer = store => new DynoIndexer({ provider, store, chainId: 31337, managerAddress: address, vaultAddress: vault, startBlock: 1, finalityBlocks: 2, managerAbi: abi, vaultAbi: [] });
  const makeLog = (number, id) => ({ ...iface.encodeEventLog(iface.getEvent("TicketPurchased"), [1n, BigInt(id), address, hash(100), 20000, 35n * 10n ** 18n, 90071992547409930000n]),
    address, blockNumber: number, blockHash: blocks.get(number).hash, transactionHash: hash(1000 + id), transactionIndex: 0, index: 0 });
  t.after(async () => {
    for (const store of stores) { try { await store.close(); } catch {} }
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("dyno-index-test-")) throw new Error("Unsafe test cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { open, makeIndexer, makeLog, blocks, provider, setLogs(value) { logs = value; }, setChain(value) { reportedChain = value; } };
}
test("indexer decodes named event fields, deduplicates and resumes durable hashed checkpoints after restart", async t => {
  const f = fixture(t), store = f.open(), indexer = f.makeIndexer(store), log = f.makeLog(10, 1); f.setLogs([log, log]);
  const result = await indexer.syncOnce(10); assert.deepEqual(result, { from: 1, to: 10, logs: 2 });
  assert.deepEqual(indexer.parse(log).payload, { roundId: "1", ticketId: "1", wallet: address, accountCommitment: hash(100), dayIndex: "20000", directRon: "35000000000000000000", saleRon: "90071992547409930000" });
  assert.equal((await store.ledger({ roundId: "1" })).length, 1);
  await store.close(); const restarted = f.open(), resumed = f.makeIndexer(restarted);
  assert.equal((await resumed.syncOnce(10)).from, 11); assert.equal((await restarted.checkpoint(31337)).block_number, "20");
});
test("reorg across empty blocks rolls back derived events only and replays from the last matching anchor", async t => {
  const f = fixture(t), store = f.open(), indexer = f.makeIndexer(store); f.setLogs([f.makeLog(10, 1), f.makeLog(15, 2)]);
  store.auth.put("wallet-session", "private-cookie", { wallet: address }, Date.now() + 10000);
  await indexer.syncOnce(10); await indexer.syncOnce(10);
  for (let n = 11; n <= 30; n++) f.blocks.set(n, { number: n, hash: hash(n + 5000) });
  f.setLogs([f.makeLog(10, 1), f.makeLog(18, 3)]);
  assert.equal((await indexer.syncOnce(10)).from, 11);
  const rows = await store.ledger({}); assert.deepEqual(rows.map(row => row.payload.ticketId), ["3", "1"]);
  assert.equal(store.auth.get("wallet-session", "private-cookie").wallet, address);
});
test("RPC outage or wrong chain cannot erase indexed history; reorged log batches are refused", async t => {
  const f = fixture(t), store = f.open(), indexer = f.makeIndexer(store); f.setLogs([f.makeLog(10, 1)]); await indexer.syncOnce(10);
  const saved = f.blocks.get(10); f.blocks.delete(10);
  await assert.rejects(indexer.syncOnce(10), /refusing destructive/);
  assert.equal((await store.ledger({})).length, 1); assert.equal((await store.checkpoint(31337)).block_number, "10");
  f.blocks.set(10, saved); f.setChain("0x1"); await assert.rejects(indexer.syncOnce(10), /chain mismatch/);
  f.setChain("0x7a69"); const invalid = { ...f.makeLog(15, 2), blockHash: hash(90000) }; f.setLogs([invalid]);
  await assert.rejects(indexer.syncOnce(10), /no longer canonical/);
  assert.equal((await store.checkpoint(31337)).block_number, "10");
});
