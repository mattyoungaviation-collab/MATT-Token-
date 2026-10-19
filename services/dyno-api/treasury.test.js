"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Interface, parseEther, getAddress } = require("ethers");
const { createDynoRouter } = require("./router");
const { createMemoryStore } = require("./store");
const { CLAIMS } = require("./treasury");
const manifest = require("../../config/project-dyno.ronin.example.json");
const ERC20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
const SAFE = new Interface(["function getThreshold() view returns(uint256)"]);
const address = digit => `0x${digit.repeat(40)}`;
const R = parseEther;

function row(overrides = {}) {
  return { phase: 8n, directActive: 0n, saleActive: 0n, operationsBalance: R("1"), refundLiability: R("35"),
    prizeLiability: R("200"), treasuryLiability: R("1200"), matt: manifest.matt,
    mattActive: 0n, mattRefundLiability: R("700000"), treasuryMattLiability: R("1400000"), ...overrides };
}
async function fixture(t) {
  const f = { rows: [row()], ronAdjustment: 0n, mattAdjustment: 0n, calls: [], reads: [], authorized: true,
    simulateFails: false, reorg: false, threshold: 2n, nextRoundId: null };
  const block = { number: 100, hash: "0x" + "ab".repeat(32), timestamp: Math.floor(Date.now() / 1000) };
  const pin = at => { assert.equal(at.blockTag, 100); f.reads.push(at.blockTag); };
  const balances = () => ({
    ron: f.rows.reduce((n, r) => n + r.directActive + r.saleActive + r.operationsBalance + r.refundLiability + r.prizeLiability + r.treasuryLiability, 0n) + f.ronAdjustment,
    matt: f.rows.filter(r => getAddress(r.matt) === getAddress(manifest.matt)).reduce((n, r) => n + r.mattActive + r.mattRefundLiability + r.treasuryMattLiability, 0n) + f.mattAdjustment,
  });
  const manager = {
    multisig: async at => { pin(at); return manifest.multisig; },
    emergencyAdmin: async at => { pin(at); return f.authorized ? manifest.emergencyAdmin : address("8"); },
    nextRoundId: async at => { pin(at); return f.nextRoundId || BigInt(f.rows.length + 1); },
    getRoundStatus: async (id, at) => { pin(at); return f.rows[Number(id) - 1]; },
    getRoundTerms: async (id, at) => { pin(at); return { matt: f.rows[Number(id) - 1].matt }; },
    mattActive: async (id, at) => { pin(at); return f.rows[Number(id) - 1].mattActive; },
    mattRefundLiability: async (id, at) => { pin(at); return f.rows[Number(id) - 1].mattRefundLiability; },
    treasuryMattLiability: async (id, at) => { pin(at); return f.rows[Number(id) - 1].treasuryMattLiability; },
  };
  const provider = {
    getBlock: async tag => tag === "latest" || !f.reorg ? block : { ...block, hash: "0x" + "cd".repeat(32) },
    getBalance: async (target, tag) => { assert.equal(target, getAddress(manifest.raffleProxy)); assert.equal(tag, 100); return balances().ron; },
    getCode: async (target, tag) => { assert.equal(target, getAddress(manifest.multisig)); assert.equal(tag, 100); return "0x6080"; },
    call: async tx => {
      assert.equal(tx.blockTag, 100);
      if (getAddress(tx.to) === getAddress(manifest.multisig)) return SAFE.encodeFunctionResult("getThreshold", [f.threshold]);
      assert.equal(getAddress(tx.to), getAddress(manifest.matt));
      const decoded = ERC20.parseTransaction(tx);
      return ERC20.encodeFunctionResult(decoded.name, [decoded.name === "decimals" ? 18 : balances().matt]);
    },
    send: async (method, args) => {
      f.calls.push({ method, args });
      if (method === "eth_chainId") return "0x7e4";
      assert.equal(method, "eth_call");
      if (f.simulateFails) throw new Error("reverted");
      return "0x";
    },
  };
  const store = createMemoryStore(); store.auth.kind = "sqlite-encrypted";
  store.auth.put("wallet-session", "admin", { wallet: manifest.emergencyAdmin, expiresAt: Date.now() + 600000 }, Date.now() + 600000);
  store.auth.put("wallet-session", "outsider", { wallet: address("7"), expiresAt: Date.now() + 600000 }, Date.now() + 600000);
  const safe = { isOwner: async () => false };
  const app = express(); app.use("/api/dyno", createDynoRouter({ manifest, store, chainProvider: provider, raffleManager: manager, multisigContract: safe }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/dyno`;
  f.get = (roundId = "1", cookie = "admin") => fetch(`${base}/admin/treasury?roundId=${roundId}`, { headers: cookie ? { cookie: `dyno_wallet=${cookie}` } : {} });
  f.post = (body, options = {}) => fetch(`${base}/admin/treasury/prepare`, { method: "POST", headers: { "content-type": "application/json", cookie: "dyno_wallet=admin", origin: "https://www.matttoken.com", ...options.headers }, body: JSON.stringify(body) });
  f.generic = body => fetch(`${base}/admin/prepare`, { method: "POST", headers: { "content-type": "application/json", cookie: "dyno_wallet=admin" }, body: JSON.stringify(body) });
  f.request = (s, asset) => ({ roundId: s.roundId, asset, expectedAllocation: asset === "RON" ? s.claimableRon : s.claimableMatt, expectedTarget: s.target, expectedExecutor: s.executor });
  return f;
}

test("treasury data requires wallet login and current administrator authority", async t => {
  const f = await fixture(t);
  assert.equal((await f.get("1", null)).status, 401);
  assert.equal((await f.get("1", "outsider")).status, 403);
  assert.equal(f.reads.length, 2); // admin control checks only; no balance scan for outsider
});
test("all open ticket RON and MATT stay unavailable even with a large contract balance", async t => {
  const f = await fixture(t);
  f.rows = [row({ phase: 2n, directActive: R("1435"), operationsBalance: 0n, refundLiability: 0n, prizeLiability: 0n, treasuryLiability: 0n,
    mattActive: R("28700000"), mattRefundLiability: 0n, treasuryMattLiability: 0n })];
  const response = await f.get(); assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.ronBalance, R("1435").toString()); assert.equal(state.claimableRon, "0"); assert.equal(state.claimableMatt, "0");
  for (const asset of ["RON", "MATT"]) assert.equal((await f.post(f.request(state, asset))).status, 409);
  assert.equal(f.calls.some(c => c.method === "eth_call"), false);
});
test("allocated RON and MATT drafts execute from the Safe, even for an emergency-admin preparer", async t => {
  const f = await fixture(t), state = await (await f.get()).json();
  assert.equal(state.safeThreshold, "2"); assert.equal(state.fullyBacked, true);
  for (const [asset, method] of [["RON", "claimTreasuryLiability"], ["MATT", "claimTreasuryMatt"]]) {
    const response = await f.post(f.request(state, asset)); assert.equal(response.status, 200);
    const draft = await response.json();
    assert.equal(draft.executionFrom, manifest.multisig); assert.equal(draft.executionMode, "multisig");
    assert.equal(draft.submitted, false); assert.equal(draft.simulated, true); assert.equal(draft.value, "0");
    assert.equal(CLAIMS.parseTransaction({ data: draft.data }).name, method);
    const call = f.calls.filter(c => c.method === "eth_call").at(-1);
    assert.equal(call.args[0].from, manifest.multisig); assert.equal(call.args[0].to, manifest.raffleProxy); assert.equal(call.args[1], "0x64");
  }
});
test("older-round refund and unprocessed cancellation balances are protected across rounds", async t => {
  const f = await fixture(t);
  f.rows = [row({ phase: 9n, directActive: R("70"), operationsBalance: 0n, prizeLiability: 0n, treasuryLiability: 0n,
    mattActive: R("1400000"), mattRefundLiability: R("700000"), treasuryMattLiability: 0n }), row()];
  let state = await (await f.get("2")).json(); assert.equal(state.roundsChecked, "2"); assert.equal(state.fullyBacked, true);
  assert.equal(state.ronReserved, R("1541").toString());
  f.ronAdjustment = -R("70"); // enough for current round alone, but not for the old cancelled tickets
  state = await (await f.get("2")).json(); assert.equal(state.fullyBacked, false); assert.equal(state.claimableRon, "0");
  assert.equal((await f.post(f.request(state, "RON"))).status, 409);
});
test("a MATT backing shortfall disables both claims rather than paying from reserved funds", async t => {
  const f = await fixture(t); f.mattAdjustment = -1n;
  const state = await (await f.get()).json(); assert.equal(state.fullyBacked, false);
  assert.equal(state.claimableMatt, "0"); assert.equal(state.claimableRon, "0");
});
test("changed allocation, arbitrary receiver/value/calldata, and cross-origin requests cannot produce a draft", async t => {
  const f = await fixture(t), state = await (await f.get()).json(), request = f.request(state, "RON");
  f.rows[0].treasuryLiability -= R("1");
  assert.equal((await f.post(request)).status, 409);
  for (const extra of [{ receiver: address("9") }, { value: "1" }, { data: "0x1234" }, { amount: R("1200").toString() }])
    assert.equal((await f.post({ ...f.request(await (await f.get()).json(), "RON"), ...extra })).status, 400);
  assert.equal((await f.post(request, { headers: { origin: "https://evil.example" } })).status, 403);
});
test("the treasury has to pass the actual claim simulation; a mismatched beneficiary fails closed", async t => {
  const f = await fixture(t), state = await (await f.get()).json(); f.simulateFails = true;
  const response = await f.post(f.request(state, "MATT")); assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "TREASURY_SIMULATION_FAILED");
});
test("reorged funding observations and excessive historical scans never return a draft", async t => {
  const f = await fixture(t); f.reorg = true;
  assert.equal((await f.get()).status, 503);
  f.reorg = false; f.nextRoundId = 66n;
  assert.equal((await f.get()).status, 503);
});
test("generic admin preparation cannot bypass the dedicated treasury checks", async t => {
  const f = await fixture(t);
  for (const method of ["claimTreasuryMatt", "claimTreasuryLiability"])
    assert.equal((await f.generic({ contract: "manager", method, args: ["1"], value: "0" })).status, 400);
});
