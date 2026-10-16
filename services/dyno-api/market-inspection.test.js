"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Interface } = require("ethers");
const { inspectMarket, exact, MATT, POOL_CANDIDATE } = require("../../scripts/dyno/inspect-market");
test("read-only inspection pins all code/calls to one hashed block; token decimals alone never certify readiness", async () => {
  const calls = [], hash = "0x" + "ab".repeat(32);
  const signatures = ["function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)"];
  const iface = new Interface(signatures);
  const values = { name: ["Mock MATT"], symbol: ["MATT"], decimals: [18], totalSupply: [900719925474099312345n] };
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return "0x7e4";
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash, timestamp: "0x20" };
    if (method === "eth_getCode") return params[0] === MATT ? "0x6000" : "0x";
    if (method === "eth_call") { const fragment = iface.getFunction(params[0].data.slice(0, 10)); return iface.encodeFunctionResult(fragment, values[fragment.name]); }
    throw new Error("Unexpected RPC");
  };
  const result = await inspectMarket({ rpc });
  assert.equal(result.productionReady, false); assert.equal(result.poolCandidate.address, POOL_CANDIDATE);
  assert.equal(result.matt.decimals.values[0], "18"); assert.equal(result.matt.totalSupply.values[0], "900719925474099312345");
  for (const call of calls.filter(c => ["eth_call", "eth_getCode"].includes(c.method))) assert.equal(call.params[1], "0x10");
  assert.ok(calls.every(c => ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(c.method)));
  assert.deepEqual(exact([1n, [2n]]), ["1", ["2"]]);
});
test("wrong chain is refused before probing candidate contracts", async () => {
  let calls = 0; await assert.rejects(inspectMarket({ rpc: async () => { calls++; return "0x1"; } }), /CHAIN_MISMATCH/); assert.equal(calls, 1);
});
