"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { startIndexer } = require("./runner");
test("same-instance indexer loop prevents overlapping passes and redacts outage details", async () => {
  let release, passes = 0, closed = false; const errors = [];
  const pending = new Promise(resolve => { release = resolve; });
  const runner = startIndexer({ syncOnce: async () => { passes++; await pending; return { to: 25 }; }, close: async () => { closed = true; } }, { intervalMs: 60000, log: message => errors.push(message) });
  await runner.tick(); assert.equal(passes, 1); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(runner.status.indexedBlock, "25");
  await runner.stop(); assert.equal(closed, true); assert.deepEqual(errors, []);
  const outage = startIndexer({ syncOnce: async () => { throw new Error("private-rpc-api-key"); }, close: async () => {} }, { intervalMs: 60000, log: message => errors.push(message) });
  await new Promise(resolve => setImmediate(resolve)); await outage.stop();
  assert.equal(outage.status.ok, false); assert.doesNotMatch(errors.join(""), /private-rpc-api-key/);
});

test("indexer replays backlog promptly, then returns to normal polling", async () => {
  let passes = 0;
  const runner = startIndexer({ syncOnce: async () => ({ to: ++passes, head: 2 }), close: async () => {} }, { intervalMs: 60000 });
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(passes, 2);
    assert.equal(runner.status.indexedBlock, "2");
  } finally { await runner.stop(); }
});
