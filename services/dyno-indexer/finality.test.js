"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { DynoIndexer } = require("./indexer");
function fixture() {
  let saved = null, writes = 0, rollbacks = 0, finalized = { number: 10, hash: "0x10" };
  const store = { applyBatch: async (_chain, _events, block) => { writes++; saved = { block_number: String(block.number), hash: block.hash.slice(2) }; },
    checkpoint: async () => saved, rollback: async () => { rollbacks++; }, anchors: async () => [] };
  const provider = { send: async () => "0x7e4", getBlockNumber: async () => 1000, getLogs: async () => [],
    getBlock: async n => n === "finalized" ? finalized : { number: n, hash: "0x" + n.toString(16) } };
  const options = { chainId: 2020, startBlock: 1, managerAddress: "0x" + "1".repeat(40), vaultAddress: "0x" + "2".repeat(40), managerAbi: [], vaultAbi: [], env: { NODE_ENV: "production" }, provider, store };
  // Number 10 hashes to 0xa in the controlled canonical provider.
  finalized = { number: 10, hash: "0xa" };
  return { options, store, provider, setFinalized(v) { finalized = v; }, setCheckpoint(v) { saved = v; }, mutations: () => ({ writes, rollbacks }) };
}
test("production defaults to provider finalized head, not latest minus twelve", async () => {
  const f = fixture(), indexer = new DynoIndexer(f.options);
  assert.equal(indexer.finalityMode, "rpc-finalized");
  assert.deepEqual(await indexer.syncOnce(), { from: 1, to: 10, logs: 0, head: 10 });
  assert.deepEqual(f.mutations(), { writes: 1, rollbacks: 0 });
});
test("missing, malformed or noncanonical finalized anchors fail without erasing data", async () => {
  for (const value of [null, { hash: "0xa", number: "10" }, { hash: "0xb", number: 10 }]) {
    const f = fixture(); f.setFinalized(value);
    await assert.rejects(new DynoIndexer(f.options).syncOnce(), /Finalized block/);
    assert.deepEqual(f.mutations(), { writes: 0, rollbacks: 0 });
  }
});
test("lagging finalized provider cannot roll back an advanced checkpoint", async () => {
  const f = fixture(); f.setCheckpoint({ block_number: "20", hash: "14" });
  await assert.rejects(new DynoIndexer(f.options).syncOnce(), /behind checkpoint/);
  assert.deepEqual(f.mutations(), { writes: 0, rollbacks: 0 });
});
test("production rejects confirmation fallback and invalid policy", () => {
  const f = fixture();
  for (const finalityMode of ["confirmations", "latest", ""]) assert.throws(() => new DynoIndexer({ ...f.options, finalityMode }), /finalized block policy/);
});
test("finalized anchor change during a batch prevents commit", async () => {
  const f = fixture(); f.provider.getLogs = async () => { f.provider.getBlock = async n => ({ number: n, hash: n === 10 ? "0xb" : "0x" + n.toString(16) }); return []; };
  await assert.rejects(new DynoIndexer(f.options).syncOnce(5), /anchor changed/);
  assert.deepEqual(f.mutations(), { writes: 0, rollbacks: 0 });
});
