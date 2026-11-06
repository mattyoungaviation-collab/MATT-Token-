"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PUBLIC_RONIN_RPCS, ReadFailoverProvider, createDynoReadProvider, rpcUrls, timeoutMs } = require("./read-provider");

test("Ronin read URLs prioritize the dedicated override and verified public providers", () => {
  const manifest = { chainId: 2020, rpcUrlEnv: "RONIN_RPC_URL" };
  assert.deepEqual(rpcUrls({ DYNO_API_RPC_URL: "https://api.example/primary", DYNO_RPC_URL: "https://api.example/dyno", RONIN_RPC_URL: "https://api.example/primary" }, manifest), [
    "https://api.example/primary",
    ...PUBLIC_RONIN_RPCS,
    "https://api.example/dyno",
  ]);
  assert.deepEqual(rpcUrls({ RONIN_RPC_URL: "https://api.example/primary", DYNO_PUBLIC_RPC_FALLBACK_DISABLED: "true" }, manifest), ["https://api.example/primary"]);
});

test("read provider moves to the next backend after an RPC error", async () => {
  const failed = { _perform: async () => { throw new Error("rate limited"); }, send: async () => { throw new Error("rate limited"); } };
  const healthy = { _perform: async request => `performed:${request.method}`, send: async method => `sent:${method}` };
  const provider = new ReadFailoverProvider([failed, healthy], 2020, { requestTimeoutMs: 250 });
  assert.equal(await provider._perform({ method: "getBlockNumber" }), "performed:getBlockNumber");
  assert.equal(await provider.send("eth_chainId", []), "sent:eth_chainId");
});

test("read provider moves to the next backend after a stalled RPC", async () => {
  const stalled = { _perform: async () => new Promise(() => {}), send: async () => new Promise(() => {}) };
  const healthy = { _perform: async () => 123, send: async () => "0x7e4" };
  const provider = new ReadFailoverProvider([stalled, healthy], 2020, { requestTimeoutMs: 10 });
  assert.equal(await provider._perform({ method: "getBlockNumber" }), 123);
  assert.equal(await provider.send("eth_chainId", []), "0x7e4");
});

test("DYNO backends disable JSON-RPC batching for parallel quota reads", () => {
  const created = [];
  const providerFactory = (url, chainId, options) => {
    created.push({ url, chainId, options });
    return { destroy() {} };
  };
  createDynoReadProvider({
    env: { DYNO_API_RPC_URL: "https://api.example/dedicated", DYNO_PUBLIC_RPC_FALLBACK_DISABLED: "true" },
    manifest: { chainId: 2020, rpcUrlEnv: "RONIN_RPC_URL" },
    providerFactory,
  });
  assert.deepEqual(created, [{
    url: "https://api.example/dedicated",
    chainId: 2020,
    options: { staticNetwork: true, batchMaxCount: 1 },
  }]);
});

test("failover timeout is bounded", () => {
  assert.equal(timeoutMs({}), 1500);
  assert.equal(timeoutMs({ DYNO_RPC_FAILOVER_TIMEOUT_MS: "500" }), 500);
  assert.throws(() => timeoutMs({ DYNO_RPC_FAILOVER_TIMEOUT_MS: "100" }), /250 to 10000/);
});
