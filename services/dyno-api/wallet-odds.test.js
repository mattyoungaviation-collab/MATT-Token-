"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { odds, projectPool } = require("./wallet-odds");
const { createMemoryStore } = require("./store");
test("draw percentages use the final pool, not the much smaller current pool", () => {
  const result = odds(3, 6, 1000);
  assert.equal(result.currentSharePercent, "50.0000");
  assert.equal(result.othersSharePercent, "50.0000");
  assert.equal(result.perDrawPercent, "0.3000");
  assert.equal(result.anyPrizePercent, "1.7866");
  assert.equal(odds(0, 0, 1000).currentSharePercent, null);
  assert.equal(odds(0, 0, 1000).anyPrizePercent, "0.0000");
  assert.equal(odds(1000, 1000, 1000).anyPrizePercent, "100.0000");
  assert.throws(() => odds(4, 3, 1000));
  assert.throws(() => odds(3, 6, 999));
});
function fixture() {
  const store = createMemoryStore(), wallet = "0x" + "1".repeat(40), other = "0x" + "2".repeat(40);
  store.checkpoint = async () => ({block_number: "123", hash: "ab".repeat(32)});
  const add = (event_name, payload = {}) => store._events.push({event_name, payload: {roundId: "1", ...payload}});
  add("RoundCreated"); add("RoundOpened", {capacity: 1000});
  add("TicketPurchased", {ticketId: "1", wallet}); add("TicketPurchased", {ticketId: "2", wallet});
  add("TicketPurchased", {ticketId: "3", wallet: other});
  return {store, wallet, other, add};
}
test("eligible wallet counts exclude disqualification/refunds, preserve repeat wins and isolate rounds", async () => {
  const f = fixture();
  f.add("TicketDisqualified", {ticketId: "1"}); f.add("RefundCredited", {ticketId: "1"});
  f.add("TicketPurchased", {ticketId: "4", wallet: f.other});
  f.add("WinnerAssigned", {ticketId: "2", prizeIndex: 0}); f.add("WinnerAssigned", {ticketId: "2", prizeIndex: 1});
  f.store._events.push({event_name: "TicketPurchased", payload: {roundId: "2", ticketId: "5", wallet: f.wallet}});
  const pool = await projectPool({store: f.store, chainId: 2020, roundId: "1"});
  assert.equal(pool.eligibleCount, 3); assert.equal(pool.wallets.get(f.wallet), 1); assert.equal(pool.wallets.get(f.other), 2); assert.equal(pool.assigned, true);
  f.add("RoundCancelled");
  assert.equal((await projectPool({store: f.store, chainId: 2020, roundId: "1"})).eligibleCount, 0);
});
test("checkpoint changes and incomplete history suppress odds rather than invent counts", async () => {
  const f = fixture(); let calls = 0;
  f.store.checkpoint = async () => ({block_number: String(++calls), hash: "abc"});
  await assert.rejects(projectPool({store: f.store, chainId: 2020, roundId: "1"}), /INDEX_CHANGED/);
  const g = fixture(); g.add("TicketDisqualified", {ticketId: "99"});
  await assert.rejects(projectPool({store: g.store, chainId: 2020, roundId: "1"}), /INDEX_INCOMPLETE/);
});
test("pool counts span every history page, not just the 25 displayed tickets", async () => {
  const f = fixture();
  for (let i = 4; i <= 300; i++) f.add("TicketPurchased", {ticketId: String(i), wallet: f.wallet});
  const pool = await projectPool({store: f.store, chainId: 2020, roundId: "1"});
  assert.equal(pool.eligibleCount, 300); assert.equal(pool.wallets.get(f.wallet), 299);
});
