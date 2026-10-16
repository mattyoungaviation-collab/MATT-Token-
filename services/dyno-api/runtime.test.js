"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const { selectDynoRuntime, createDisabledDynoRouter, disabledDynoPage } = require("./runtime");

test("production is disabled by default even with an unreadable or mock manifest", () => {
  assert.deepEqual(selectDynoRuntime({ NODE_ENV: "production", DYNO_MANIFEST: "not-a-real-file" }), { enabled: false, readOnly: false, production: true, manifest: null });
  assert.equal(selectDynoRuntime({ NODE_ENV: "production", DYNO_LIVE_ENABLED: "false" }).enabled, false);
});
test("invalid enable switches and disabled-production indexing fail closed", () => {
  for (const key of ["DYNO_LIVE_ENABLED", "DYNO_INDEXER_ENABLED", "DYNO_PUBLIC_READ_ONLY_ENABLED"]) assert.throws(() => selectDynoRuntime({ NODE_ENV: "production", [key]: "TRUE" }), /must be true or false/);
  assert.throws(() => selectDynoRuntime({ NODE_ENV: "production", DYNO_INDEXER_ENABLED: "true" }), /cannot run/);
});
test("production read-only preview needs an explicit switch and never enables checkout", () => {
  const runtime = selectDynoRuntime({ NODE_ENV: "production", DYNO_LIVE_ENABLED: "false", DYNO_INDEXER_ENABLED: "false", DYNO_PUBLIC_READ_ONLY_ENABLED: "true" });
  assert.equal(runtime.enabled, false); assert.equal(runtime.readOnly, true);
  assert.equal(runtime.manifest.raffleProxy, "0x519aa3D0479501d4630dCFa7d9D8691577702776");
  assert.throws(() => selectDynoRuntime({ NODE_ENV: "production", DYNO_PUBLIC_READ_ONLY_ENABLED: "true", DYNO_INDEXER_ENABLED: "true" }), /cannot run/);
});
test("live production requires an explicit nonmock production manifest", () => {
  assert.throws(() => selectDynoRuntime({ NODE_ENV: "production", DYNO_LIVE_ENABLED: "true" }), /explicit production manifest/);
  assert.throws(() => selectDynoRuntime({ NODE_ENV: "production", DYNO_LIVE_ENABLED: "true", DYNO_MANIFEST: require.resolve("../../config/project-dyno.local.json") }), /cannot use local\/test manifests/);
});
test("local demo remains explicitly mocked and independently usable", () => {
  const runtime = selectDynoRuntime({ NODE_ENV: "development" });
  assert.equal(runtime.enabled, true); assert.equal(runtime.production, false); assert.equal(runtime.manifest.mock, true);
});
test("disabled production exposes only redacted readiness; every ticket/admin/claim route is unavailable", async t => {
  const app = express(), store = { kind: "sqlite", auth: { kind: "sqlite-encrypted" }, health: async () => true };
  app.use("/api/dyno", createDisabledDynoRouter(store));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(origin + "/api/dyno/config")).json();
  assert.equal(config.enabled, false); assert.equal(config.mock, false); assert.equal(config.raffleProxy, null);
  assert.equal((await (await fetch(origin + "/api/dyno/health")).json()).authentication, "sqlite-encrypted");
  for (const route of ["/auth/nonce", "/auth/verify", "/voucher", "/admin/prepare", "/claim", "/quota", "/quote", "/round", "/ledger"]) {
    const response = await fetch(origin + "/api/dyno" + route, { method: "POST" });
    assert.equal(response.status, 503, route); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error, "DYNO_NOT_LAUNCHED");
  }
  assert.ok(!/<(button|script|form)\b/.test(disabledDynoPage));
});
test("storage readiness failure is redacted and returns an unhealthy status", async t => {
  const app = express(); app.use(createDisabledDynoRouter({ kind: "sqlite", health: async () => { throw new Error("private-database-path-or-key"); } }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 503); const result = await response.text(); assert.ok(!result.includes("private-database-path-or-key"));
});
