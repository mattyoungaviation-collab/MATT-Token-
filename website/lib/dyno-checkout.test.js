"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const ethers = require("ethers");
const source = fs.readFileSync(path.join(__dirname, "../public/dyno.js"), "utf8");
const wallet = "0x1111111111111111111111111111111111111111";
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ mock = false, remaining = 3, rejectPurchase = false, chainPrizes, purchasesEnabled } = {}) {
  const events = [], calls = [], routes = [], elements = new Map();
  const element = () => ({ textContent: "", innerHTML: "", disabled: false, style: {}, handlers: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, replaceChildren() {}, append() {},
    addEventListener(name, handler) { this.handlers[name] = handler; } });
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const quantities = [1, 2, 3].map(n => ({ ...element(), dataset: { quantity: String(n) } }));
  const document = { getElementById: byId, createElement: element, createTextNode: text => text,
    querySelector: () => element(), querySelectorAll: selector => selector === "[data-quantity]" ? quantities : [] };
  const localRound = require("../../config/project-dyno.local.json").round;
  const config = { mock, environment: "local", paymentModel: "RON_AND_HELD_MATT", chainId: 31337, matt: wallet, nftCollection: wallet, raffleProxy: wallet, round: mock ? localRound : null, purchasesEnabled };
  const roundConfig = { ...localRound, matt: wallet, nftCollection: wallet, nftTokenId: "1358", ronPrizes: chainPrizes || localRound.ronPrizes };
  let releaseApproval;
  const approval = new Promise(resolve => { releaseApproval = resolve; });
  const token = { allowance: async () => 0n, approve: async () => { events.push("approve"); return { wait: async () => { await approval; events.push("approval-confirmed"); return { status: 1 }; } }; } };
  const manager = { buyTickets: async (voucher, signature, options) => {
    events.push("purchase"); calls.push({ voucher, signature, options });
    if (rejectPurchase) throw new Error("User rejected the purchase");
    return { hash: "0x" + "ab".repeat(32), wait: async () => ({ status: 1, blockNumber: 123 }) };
  } };
  const signer = { getAddress: async () => wallet };
  const browser = { getNetwork: async () => ({ chainId: 31337n }), getSigner: async () => signer };
  const fetch = async (url, options = {}) => {
    routes.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    const route = String(url).split("?")[0]; let body = {};
    if (route.endsWith("/config")) body = config;
    else if (route.endsWith("/active-round")) body = { roundId: mock ? "1" : "2", status: "ACTIVE_ROUND" };
    else if (route.endsWith("/round")) body = { phase: "OPEN", eligibleCount: 500, freshness: "demo", config: mock ? undefined : roundConfig };
    else if (route.endsWith("/ledger")) body = { rows: [] };
    else if (route.endsWith("/link-status")) body = { wallet };
    else if (route.endsWith("/quota")) body = { remaining, capacityRemaining: 500, resetAt: 86400, blockedReason: null };
    else if (route.endsWith("/quote")) { events.push("quote"); body = { roundId: "2", paymentModel: "RON_AND_HELD_MATT", totalRon: localRound.ticketRon, totalMatt: localRound.ticketMatt }; }
    else if (route.endsWith("/voucher")) { events.push("voucher"); body = { voucher: { roundId: "2", quantity: 1, identityVersion: 4 }, signature: "test-signature" }; }
    return { ok: true, json: async () => body };
  };
  vm.runInNewContext(source, { document, fetch, location: {}, window: { ethereum: {}, ethers: { ...ethers,
    BrowserProvider: function () { return browser; }, Contract: function (_address, abi) { return abi[0].includes("allowance") ? token : manager; } } } });
  return { byId, quantities, events, calls, routes, releaseApproval };
}
test("checkout restores login/quota, blocks double submission and requests voucher only after separate approval confirms", async () => {
  const f = fixture(); await tick();
  assert.match(f.byId("quota").textContent, /3 of 3/); assert.equal(f.byId("purchase").disabled, false);
  f.byId("purchase").handlers.click(); await tick();
  assert.deepEqual(f.events, ["approve"]); assert.equal(f.byId("purchase").disabled, true);
  assert.ok(f.quantities.every(el => el.disabled));
  f.byId("purchase").handlers.click(); await tick(); assert.deepEqual(f.events, ["approve"]);
  f.releaseApproval(); await tick();
  assert.deepEqual(f.events, ["approve", "approval-confirmed", "quote", "voucher", "purchase"]);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.value, 35n * 10n ** 18n);
  assert.ok(f.routes.some(route => route.url.includes("/quote?roundId=2&quantity=1")));
  assert.ok(f.routes.some(route => route.url.endsWith("/voucher") && route.body.roundId === "2"));
  assert.match(f.byId("transaction-status").textContent, /Confirmed in block 123/);
  assert.equal(f.byId("purchase").disabled, false);
});
test("purchase rejection restores controls and never displays confirmation", async () => {
  const f = fixture({ rejectPurchase: true }); await tick(); f.byId("purchase").handlers.click(); await tick();
  f.releaseApproval(); await tick();
  assert.match(f.byId("transaction-status").textContent, /User rejected/);
  assert.doesNotMatch(f.byId("transaction-status").textContent, /Confirmed/);
  assert.equal(f.byId("purchase").disabled, false); assert.ok(f.quantities.every(el => !el.disabled));
});
test("zero allowance and local mock leave checkout disabled", async () => {
  const empty = fixture({ remaining: 0 }); await tick(); assert.equal(empty.byId("purchase").disabled, true);
  const demo = fixture({ mock: true }); await tick(); assert.equal(demo.byId("purchase").disabled, true);
  assert.match(demo.byId("quota").textContent, /Local demo/); assert.deepEqual(demo.events, []);
});
test("production checkout switch disables purchase even when the round is OPEN", async () => {
  const f = fixture({ purchasesEnabled: false }); await tick();
  assert.equal(f.byId("purchase").disabled, true);
  f.byId("purchase").handlers.click(); await tick();
  assert.deepEqual(f.events, []);
  assert.match(f.byId("transaction-status").textContent, /checkout is not enabled/i);
});
test("live prize cards use chain configuration rather than stale deployment defaults", async () => {
  const chainPrizes = ["100", "200", "300", "400", "500"].map(value => String(BigInt(value) * 10n ** 18n));
  const f = fixture({ chainPrizes }); await tick();
  assert.match(f.byId("prize-grid").innerHTML, /100 RON/);
  assert.doesNotMatch(f.byId("prize-grid").innerHTML, /\$5 DEFAULT/);
  assert.equal(f.byId("purchase").disabled, false);
});
