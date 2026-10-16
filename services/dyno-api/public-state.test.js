"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), express = require("express");
const { readActiveRound, readRound, readTicket, readWinners, readBuyback } = require("./public-state");
const { createDynoRouter } = require("./router"), { createMemoryStore } = require("./store");
const local = require("../../config/project-dyno.local.json");
const wallet = "0x" + "1".repeat(40), hash = "0x" + "2".repeat(64);
function fixture() {
  const calls = [], nowSeconds = 2000000, block = { number: 100, hash, timestamp: nowSeconds };
  const round = { phase: 8n, eligibleCount: 1000n, reviewEndsAt: 1000n, frozenAt: 2000n, snapshotDigest: hash, directActive: 0n, saleActive: 0n, operationsBalance: 25000000000000000000n,
    refundLiability: 900719925474099312345n, prizeLiability: 12148876400000000000000n, treasuryLiability: 0n };
  const roundConfig = { matt: wallet, nftTokenId: 1358n,
    ticketRon: 35000000000000000000n, ticketMatt: 700000000000000000000000n, capacity: 1000n,
    ronPrizes: [100n, 200n, 300n, 400n, 500n].map(value => value * 10n ** 18n), nextDynoReserve: 10000n * 10n ** 18n,
    termsHash: hash, configHash: hash };
  const ticket = { roundId: 1n, originalWallet: wallet, accountCommitment: hash, purchasedAt: 10000n, dayIndex: 1n, directRon: 35000000000000000000n,
    saleRon: 900719925474099312345n, eligibleIndex: 999n, status: 1n, refundAmount: 0n, winningBitmap: 63n };
  const schedule = { state: 1n, budget: 168001n, hourlySlice: 1000n, roundingDust: 1n, startsAt: 1996400n, endsAt: 2601200n, spent: 1000n, delivered: 123456789012345678901n, unreturned: 0n };
  const method = (name, get) => async (...args) => { calls.push({ name, at: args.at(-1) }); return get(...args); };
  const manager = { activeRoundId: method("activeRoundId", () => 2n), getRoundStatus: method("getRoundStatus", () => round), getRoundTerms: method("getRoundTerms", () => roundConfig),
    mattActive: method("mattActive", () => 700000000000000000000000n),
    mattRefundLiability: method("mattRefundLiability", () => 700000000000000000000000n),
    treasuryMattLiability: method("treasuryMattLiability", () => 0n),
    getNftPrize: method("getNftPrize", () => ({ chainId: 1n, collection: wallet, tokenId: 1358n, depositor: wallet, winner: wallet })),
    getTicket: method("getTicket", () => ticket), ticketRefundMatt: method("ticketRefundMatt", () => 700000000000000000000000n), refundPaid: method("refundPaid", () => false),
    getWinnerTicketId: method("winner", () => 10n), prizeAmount: method("amount", (_round, index) => BigInt(index + 1)), prizePaid: method("paid", () => false) };
  const vault = { roundId: method("vaultRound", () => 1n), getSchedule: method("schedule", () => schedule), returnedAmount: method("returned", () => 0n),
    getSlotStatus: method("status", slot => slot === 1 ? 1n : 0n), slotMattOut: method("mattOut", slot => slot === 1 ? 123456789012345678901n : 0n) };
  const provider = { send: async () => "0x7a69", getBlock: async () => block };
  return { options: { provider, manager, vault, chainId: 31337, nowSeconds, roundId: "1", ticketId: "10" }, calls, round, ticket, schedule, provider, block };
}
test("public round uses exact live buckets, never invents historical transfers or floating amounts", async () => {
  const f = fixture(), result = await readRound(f.options);
  assert.equal(result.prizeLiability, "12148876400000000000000"); assert.equal(result.refundLiability, "900719925474099312345");
  assert.deepEqual(result.config.ronPrizes, ["100000000000000000000", "200000000000000000000", "300000000000000000000", "400000000000000000000", "500000000000000000000"]);
  assert.equal(result.config.ticketRon, "35000000000000000000"); assert.equal(result.config.configHash, hash);
  assert.equal(result.paymentModel, "RON_AND_HELD_MATT"); assert.equal(result.mattRefundLiability, "700000000000000000000000");
  assert.equal(result.reserveTransferred, null); assert.equal(result.directReceipts, undefined);
  assert.equal(result.freshness, "chain-read-unfinalized"); assert.equal(result.chainBlockHash, hash);
  assert.ok(f.calls.every(call => call.at.blockTag === 100));
});
test("active round is chain-sourced and block-pinned, including no active round", async () => {
  const f = fixture(), active = await readActiveRound(f.options);
  assert.equal(active.roundId, "2"); assert.equal(active.chainBlockHash, hash);
  assert.ok(f.calls.every(call => call.at.blockTag === 100));
  f.options.manager.activeRoundId = async () => 0n;
  assert.equal((await readActiveRound(f.options)).roundId, null);
});
test("ticket returns original beneficiary, exact recorded refund inputs and repeat-winning indexes", async () => {
  const f = fixture(), result = await readTicket(f.options);
  assert.equal(result.originalWallet.toLowerCase(), wallet); assert.equal(result.saleRon, "900719925474099312345");
  assert.equal(result.refundMatt, "700000000000000000000000");
  assert.deepEqual(result.winningIndexes, [0, 1, 2, 3, 4, 5]); assert.equal(result.refundPaid, false);
});
test("six winner assignments allow repeat tickets; a manual NFT report is not proof of delivery", async () => {
  const f = fixture(), result = await readWinners(f.options);
  assert.equal(result.winners.length, 6); assert.ok(result.winners.every(w => w.ticketId === "10"));
  assert.equal(result.winners[5].paid, null); assert.equal(result.winners[5].nftDeliveryVerification, "use-prize-delivery-endpoint");
  f.round.phase = 7n; assert.equal((await readWinners(f.options)).winners[0].amount, null);
  f.round.phase = 5n; assert.deepEqual((await readWinners(f.options)).winners, []);
});
test("buyback is bounded, exact and marks expired pending windows without pretending a terminal record exists", async () => {
  const f = fixture(), result = await readBuyback({ ...f.options, limit: 3 });
  assert.equal(result.budget, "168001"); assert.equal(result.slice, "1000"); assert.equal(result.dust, "1");
  assert.equal(result.slots[0].status, "MISSED"); assert.equal(result.slots[0].storedStatus, "PENDING"); assert.equal(result.slots[0].expiredWithoutTerminalRecord, true);
  assert.equal(result.slots[1].current, true); assert.equal(result.slots[1].ronSpent, "1000");
  assert.equal(result.slots[1].mattDelivered, "123456789012345678901"); assert.equal(result.nextOffset, 3);
  assert.ok(f.calls.every(call => call.at.blockTag === 100));
  await assert.rejects(readBuyback({ ...f.options, limit: 168 }), /INVALID_PAGINATION/);
  const older = await readBuyback({ ...f.options, roundId: "2" }); assert.equal(older.available, false);
});
test("wrong chain, stale block, reorg, nonexistent/malformed IDs and bad chain fields fail closed", async () => {
  let f = fixture(); f.provider.send = async () => "0x1"; await assert.rejects(readRound(f.options), /CHAIN_UNAVAILABLE/);
  f = fixture(); f.block.timestamp -= 121; await assert.rejects(readRound(f.options), /STALE_CHAIN_DATA/);
  f = fixture(); let reads = 0; f.provider.getBlock = async () => ({ ...f.block, hash: ++reads === 1 ? hash : "changed" }); await assert.rejects(readRound(f.options), /CHAIN_DATA_CHANGED/);
  f = fixture(); f.round.phase = 0n; await assert.rejects(readRound(f.options), /NOT_FOUND/);
  f = fixture(); f.round.directActive = 12.4; await assert.rejects(readRound(f.options), /MALFORMED/);
  for (const roundId of ["0", "-1", "1.5", (2n ** 256n).toString()]) await assert.rejects(readRound({ ...fixture().options, roundId }), /INVALID_ROUND/);
});
test("HTTP round outage is 503/redacted, not a successful zero-receipts response", async t => {
  const f = fixture(), app = express();
  f.provider.getBlock = async () => { throw new Error("private-provider-credential"); };
  app.use(createDynoRouter({ manifest: { ...structuredClone(local), mock: false }, store: createMemoryStore(), chainProvider: f.provider, raffleManager: f.options.manager, buybackVault: f.options.vault }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/round`);
  assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "CHAIN_STATE_UNAVAILABLE" });
});
