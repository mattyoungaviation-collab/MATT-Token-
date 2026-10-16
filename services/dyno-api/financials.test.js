"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { projectFinancials } = require("./financials");
function fixture(events) {
  let hash = "ab".repeat(32);
  const store = {
    checkpoint: async () => ({ block_number: "100", hash }),
    ledger: async ({ roundId, limit, offset }) => events.filter(row => row.payload.roundId === roundId).slice(offset, offset + limit),
  };
  return { store, changeCheckpoint: () => { hash = "cd".repeat(32); } };
}
function event(name, payload) { return { event_name: name, payload: { roundId: "1", ...payload } }; }
test("financial projection keeps RON and MATT liabilities distinct", async () => {
  const matt = "700000000000000000000000", f = fixture([
    event("RoundCreated", {}),
    event("TicketPurchased", { directRon: "35000000000000000000", saleRon: "0" }),
    event("RefundCredited", { amount: "35" }), event("RefundPaid", { amount: "35" }),
    event("MattRefundCredited", { amount: matt }), event("MattRefundPaid", { amount: matt }),
    event("NextDynoReserved", { amount: "10000000000000000000000", transferred: false }),
    event("TreasuryTransferred", { amount: "12851123600000000000000", transferred: true }),
    event("TreasuryLiabilityClaimed", { amount: "10000000000000000000000" }),
    event("TreasuryMattAllocated", { amount: matt }), event("TreasuryMattClaimed", { amount: matt }),
    event("RoundSettled", { buybackBudget: "0" }),
    event("PrizePaid", { amount: "70224700000000000000", nft: false }),
  ]);
  const result = await projectFinancials({ store: f.store, chainId: 2020, roundId: "1", finalityPolicy: "rpc-finalized" });
  assert.equal(result.totals.ticketSaleRon, "0");
  assert.equal(result.totals.reserveSentAtSettlementRon, "0");
  assert.equal(result.totals.laterTreasuryClaimsRon, "10000000000000000000000");
  assert.equal(result.totals.mattRefundPaid, matt);
  assert.equal(result.totals.treasuryMattClaimed, matt);
  assert.equal(result.freshness, "indexed-finalized-checkpoint");
  assert.equal(result.settled, true);
});
test("financial projection refuses a changing checkpoint or inconsistent refunds", async () => {
  const f = fixture([event("RoundCreated", {}), event("RefundPaid", { amount: "1" })]);
  await assert.rejects(projectFinancials({ store: f.store, chainId: 2020, roundId: "1", finalityPolicy: "confirmations" }), /ACCOUNTING_MISMATCH/);
  const g = fixture([event("RoundCreated", {}), event("TicketPurchased", { directRon: "35", saleRon: "0" })]);
  const read = g.store.ledger;
  g.store.ledger = async args => { g.changeCheckpoint(); return read(args); };
  await assert.rejects(projectFinancials({ store: g.store, chainId: 2020, roundId: "1", finalityPolicy: "confirmations" }), /INDEX_CHANGED/);
  const missingCreation = fixture([event("TicketPurchased", { directRon: "35", saleRon: "0" })]);
  await assert.rejects(projectFinancials({ store: missingCreation.store, chainId: 2020, roundId: "1", finalityPolicy: "confirmations" }), /INDEX_INCOMPLETE/);
});
