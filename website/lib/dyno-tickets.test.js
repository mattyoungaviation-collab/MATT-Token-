"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), ethers = require("ethers");
const { purchasedTickets } = require("../public/dyno-tickets");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const manager = "0x1111111111111111111111111111111111111111", wallet = "0x2222222222222222222222222222222222222222";
const iface = new ethers.Interface(require("../../packages/abis/ProjectDynoRaffleManager.json").abi);
function receipt(quantity) {
  return { status: 1, hash: "0x" + "ab".repeat(32), blockNumber: 123, logs: Array.from({length: quantity}, (_, i) => ({
    address: manager, ...iface.encodeEventLog(iface.getEvent("TicketPurchased"), [1, i + 10, wallet, ethers.ZeroHash, 20000, 35n * 10n ** 18n, 0])
  })) };
}
test("confirmation extracts exact ticket IDs for 1, 2 and 3-ticket receipts", () => {
  for (const quantity of [1, 2, 3]) {
    const rows = purchasedTickets(ethers, receipt(quantity), { manager, wallet, roundId: "1", quantity });
    assert.equal(rows.length, quantity); assert.equal(rows[0].ticketId, "10"); assert.equal(rows[0].roundId, "1");
  }
});
test("pending, reverted, wrong-contract, wrong-wallet, wrong-round and incomplete logs never confirm", () => {
  const expected = { manager, wallet, roundId: "1", quantity: 1 };
  for (const status of [undefined, 0]) assert.throws(() => purchasedTickets(ethers, {...receipt(1), status}, expected));
  for (const changed of [{manager: wallet}, {wallet: manager}, {roundId: "2"}, {quantity: 2}])
    assert.throws(() => purchasedTickets(ethers, receipt(1), {...expected, ...changed}));
  const duplicated = receipt(1); duplicated.logs.push(duplicated.logs[0]);
  assert.throws(() => purchasedTickets(ethers, duplicated, {...expected, quantity: 2}));
});

test("wallet UI shows receipt tickets immediately, opens only confirmed modal, and ignores stale wallet responses", async () => {
  const elements = new Map(), requests = [];
  function element() { return {textContent: "", children: [], handlers: {}, open: false,
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, fn) { this.handlers[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; }}; }
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = { getElementById: byId, createElement: element };
  const window = { ethers };
  const fetch = url => new Promise(resolve => requests.push({ url, resolve }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/dyno-tickets.js"), "utf8"), { document, window, fetch });
  window.DynoTickets.setWallet(wallet);
  const expected = { manager, wallet, roundId: "1", quantity: 2 };
  assert.throws(() => window.DynoTickets.confirmed({...receipt(2), status: 0}, expected));
  assert.equal(byId("purchase-confirmation").open, false);
  window.DynoTickets.confirmed(receipt(2), expected);
  assert.equal(byId("purchase-confirmation").open, true);
  assert.equal(byId("confirmation-tickets").textContent, "#10 · #11");
  assert.equal(byId("my-ticket-list").children.length, 2);
  byId("confirmation-close").handlers.click(); assert.equal(byId("purchase-confirmation").open, false);
  window.DynoTickets.setWallet(manager);
  assert.equal(byId("my-ticket-list").children.length, 0);
  requests[0].resolve({ok: true, json: async () => ({wallet, indexedBlockHash: "hash", indexedBlock: "123", rows: []})});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(byId("my-tickets-wallet").textContent, manager);
  assert.equal(byId("my-ticket-list").children.length, 0);
});
