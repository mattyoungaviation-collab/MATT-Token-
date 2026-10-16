"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const { createReadOnlyDynoRouter } = require("./read-only-router");
const manifest = require("../../config/project-dyno.ronin.example.json");

test("read-only preview exposes public config and rejects every purchase/admin request", async t => {
  const app = express();
  const block = { number: 42, hash: "0x" + "1".repeat(64), timestamp: Math.floor(Date.now() / 1000) };
  const provider = { send: async () => "0x7e4", getBlock: async () => block };
  const manager = { activeRoundId: async () => 1n };
  app.use("/api/dyno", createReadOnlyDynoRouter({ manifest, chainProvider: provider, raffleManager: manager }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}/api/dyno`;
  const config = await (await fetch(origin + "/config")).json();
  assert.equal(config.readOnly, true); assert.equal(config.purchasesEnabled, false);
  assert.equal(config.raffleProxy, manifest.raffleProxy);
  const active = await (await fetch(origin + "/active-round")).json();
  assert.equal(active.roundId, "1"); assert.equal(active.chainBlockHash, block.hash);
  for (const route of ["/voucher", "/quote", "/auth/nonce", "/admin/prepare", "/claim", "/ledger.csv"]) {
    const response = await fetch(origin + route, { method: "POST" });
    assert.equal(response.status, 503, route);
    assert.deepEqual(await response.json(), { error: "DYNO_READ_ONLY", purchasesEnabled: false });
  }
});
