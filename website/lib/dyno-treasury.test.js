"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ethers = require("ethers");
const source = fs.readFileSync(path.join(__dirname, "../public/dyno-treasury.js"), "utf8");
const manifest = require("../../config/project-dyno.ronin.example.json");
const claims = new ethers.Interface(["function claimTreasuryLiability(uint256 roundId)", "function claimTreasuryMatt(uint256 roundId)"]);
function element(tag = "") {
  return { tag, textContent: "", value: "", children: [], events: {}, attrs: {}, hidden: false, disabled: false,
    append(...nodes) { this.children.push(...nodes); }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === "href") delete this.href; },
    addEventListener(k, f) { this.events[k] = f; } };
}
function state(overrides = {}) {
  return { chainId: 2020, roundId: "1", phase: "SETTLED", target: manifest.raffleProxy, executor: manifest.multisig,
    token: ethers.getAddress(manifest.matt), tokenDecimals: 18, fullyBacked: true,
    claimableRon: ethers.parseEther("1200").toString(), claimableMatt: ethers.parseEther("1400000").toString(),
    ronBalance: ethers.parseEther("1436").toString(), ronReserved: ethers.parseEther("1436").toString(),
    mattBalance: ethers.parseEther("2100000").toString(), mattReserved: ethers.parseEther("2100000").toString(),
    safeThreshold: "2", roundsChecked: "1", chainBlock: "100", chainBlockHash: "0x" + "ab".repeat(32),
    chainTimestamp: Math.floor(Date.now() / 1000), authority: "chain", ...overrides };
}
function boot({ library = true } = {}) {
  const parent = element(), f = { state: state(), calls: [], blobs: [], revoked: [], timers: [], mutateDraft: d => d, response: null };
  const window = { ethers: library ? ethers : undefined };
  for (const key of ["ronin", "ethereum"]) Object.defineProperty(window, key, { get() { throw new Error("Wallet access is forbidden in draft preparation"); } });
  const context = { document: { getElementById: id => id === "tab-admin" ? parent : null, createElement: element }, window,
    URL: { createObjectURL: blob => { f.blobs.push(blob); return `blob:test/${f.blobs.length}`; }, revokeObjectURL: url => f.revoked.push(url) }, Blob,
    setTimeout: fn => { f.timers.push(fn); return f.timers.length; }, clearTimeout() {}, Date, Number, BigInt, JSON,
    fetch: async (url, options) => {
      f.calls.push({ url, options }); if (f.response) return f.response(url, options);
      if (url.startsWith("/api/dyno/admin/treasury?")) return { ok: true, json: async () => f.state };
      assert.equal(url, "/api/dyno/admin/treasury/prepare");
      const request = JSON.parse(options.body), method = request.asset === "RON" ? "claimTreasuryLiability" : "claimTreasuryMatt";
      const draft = f.mutateDraft({ ...f.state, asset: request.asset, method, value: "0", data: claims.encodeFunctionData(method, [request.roundId]),
        observedAllocation: request.expectedAllocation, submitted: false, simulated: true, executionMode: "multisig", executionFrom: f.state.executor,
        preparedAt: Math.floor(Date.now() / 1000), reviewBy: Math.floor(Date.now() / 1000) + 120 });
      return { ok: true, json: async () => draft };
    } };
  vm.runInNewContext(source, context);
  const all = node => [node, ...node.children.flatMap(all)];
  f.find = text => all(parent).find(n => n.textContent === text);
  f.refresh = f.find("CHECK AVAILABLE FUNDS"); f.ron = f.find("PREPARE RON WITHDRAWAL"); f.matt = f.find("PREPARE MATT WITHDRAWAL");
  f.download = f.find("DOWNLOAD SAFE TRANSACTION"); f.round = all(parent).find(n => n.attrs["aria-label"] === "Treasury round ID");
  f.copy = () => all(parent).map(n => n.textContent).join("\n");
  return f;
}

test("withdrawal controls start disabled and never access a wallet or fetch private data on load", () => {
  const f = boot(); assert.equal(f.calls.length, 0); assert.equal(f.ron.disabled, true); assert.equal(f.matt.disabled, true); assert.equal(f.download.hidden, true);
});
test("a missing transaction library fails closed with an actionable reload message", () => {
  const f = boot({ library: false });
  assert.equal(f.refresh.disabled, true); assert.equal(f.ron.disabled, true); assert.equal(f.matt.disabled, true);
  assert.equal(f.calls.length, 0); assert.match(f.copy(), /transaction library did not load/);
});
test("open ticket funds show zero available and cannot produce either withdrawal draft", async () => {
  const f = boot(); f.state = state({ phase: "OPEN", claimableRon: "0", claimableMatt: "0" });
  await f.refresh.events.click(); assert.equal(f.ron.disabled, true); assert.equal(f.matt.disabled, true);
  await f.ron.events.click(); await f.matt.events.click();
  assert.equal(f.calls.length, 1); assert.equal(f.blobs.length, 0); assert.match(f.copy(), /Incoming ticket payments are not withdrawable revenue/);
});
test("RON and MATT exports contain exactly one zero-value treasury claim for the checked Safe", async () => {
  for (const asset of ["RON", "MATT"]) {
    const f = boot(); await f.refresh.events.click(); await f[asset.toLowerCase()].events.click();
    assert.equal(f.download.hidden, false); assert.equal(f.blobs.length, 1);
    const batch = JSON.parse(await f.blobs[0].text()); assert.equal(batch.chainId, "2020"); assert.equal(batch.transactions.length, 1);
    assert.equal(batch.meta.createdFromSafeAddress, manifest.multisig);
    const tx = batch.transactions[0]; assert.equal(tx.to, manifest.raffleProxy); assert.equal(tx.value, "0");
    assert.equal(claims.parseTransaction(tx).name, asset === "RON" ? "claimTreasuryLiability" : "claimTreasuryMatt");
    assert.equal(claims.parseTransaction(tx).args[0], 1n); assert.match(f.copy(), /No transaction has been sent/);
  }
});
test("changed target, executor, calldata, chain, asset, allocation or value cannot become a downloadable transaction", async () => {
  const mutations = [d => ({ ...d, target: ethers.ZeroAddress }), d => ({ ...d, executor: ethers.ZeroAddress }),
    d => ({ ...d, data: "0x12345678" }), d => ({ ...d, chainId: 1 }), d => ({ ...d, asset: "MATT" }),
    d => ({ ...d, observedAllocation: "1" }), d => ({ ...d, value: "1" }), d => ({ ...d, executionMode: "emergency-wallet" })];
  for (const mutate of mutations) {
    const f = boot(); await f.refresh.events.click(); f.mutateDraft = mutate;
    await f.ron.events.click(); assert.equal(f.download.hidden, true); assert.equal(f.blobs.length, 0); assert.equal(f.ron.disabled, true);
  }
});
test("an inconsistent or stale funding response leaves all withdrawal controls disabled", async () => {
  for (const data of [state({ fullyBacked: false }), state({ ronBalance: "0" }), state({ chainTimestamp: Math.floor(Date.now() / 1000) - 121 })]) {
    const f = boot(); f.state = data; await f.refresh.events.click(); assert.equal(f.ron.disabled, true); assert.equal(f.matt.disabled, true);
  }
});
test("changing rounds during a pending draft cannot restore a stale download or double-submit", async () => {
  const f = boot(); await f.refresh.events.click(); let resolve;
  f.response = async () => new Promise(r => { resolve = r; });
  const pending = f.ron.events.click(); await f.ron.events.click(); assert.equal(f.calls.length, 2);
  f.round.value = "2"; f.round.events.input();
  resolve({ ok: true, json: async () => ({ ...f.state, asset: "RON" }) }); await pending;
  assert.equal(f.download.hidden, true); assert.equal(f.blobs.length, 0); assert.equal(f.ron.disabled, true);
});
test("drafts expire locally and a new check revokes old downloads", async () => {
  const f = boot(); await f.refresh.events.click(); await f.ron.events.click();
  f.timers.at(-1)(); assert.equal(f.download.hidden, true); assert.equal(f.ron.disabled, true); assert.equal(f.revoked.length, 1);
  await f.refresh.events.click(); await f.matt.events.click(); assert.equal(f.download.hidden, false);
  f.round.value = "2"; f.round.events.input(); assert.equal(f.download.hidden, true); assert.equal(f.revoked.length, 2);
});
test("an allocation change or login failure clears the draft and requires another funding check", async () => {
  for (const [status, error] of [[409, "TREASURY_CHANGED"], [401, "WALLET_LOGIN_REQUIRED"]]) {
    const f = boot(); await f.refresh.events.click();
    f.response = async () => ({ ok: false, status, json: async () => ({ error }) });
    await f.ron.events.click(); assert.equal(f.download.hidden, true); assert.equal(f.ron.disabled, true); assert.equal(f.blobs.length, 0);
  }
});
