"use strict";
const { getAddress } = require("ethers");
const { id } = require("./public-state");
// Four decimal places of percentage, rounded using integer arithmetic.
function percent(numerator, denominator) {
  if (denominator === 0n) return null;
  const scaled = (numerator * 1000000n + denominator / 2n) / denominator;
  return (scaled / 10000n).toString() + "." + (scaled % 10000n).toString().padStart(4, "0");
}
function odds(held, eligible, capacity) {
  const k = BigInt(held), n = BigInt(eligible), cap = BigInt(capacity);
  if (k < 0n || k > n || n > cap || cap !== 1000n) throw new Error("INVALID_COUNTS");
  return { perDrawPercent: percent(k, cap),
    anyPrizePercent: percent(cap ** 6n - (cap - k) ** 6n, cap ** 6n),
    currentSharePercent: percent(k, n), othersSharePercent: percent(n - k, n) };
}
async function projectPool({ store, chainId, roundId }) {
  roundId = id(roundId);
  const before = await store.checkpoint(chainId);
  if (!before?.hash) throw new Error("INDEX_UNAVAILABLE");
  const tickets = new Map(), removed = new Set();
  let created = false, capacity = null, cancelled = false, assigned = false;
  for (let offset = 0; offset <= 20000; offset += 250) {
    const rows = await store.ledger({ roundId, limit: 250, offset });
    if (!Array.isArray(rows) || rows.length > 250 || offset + rows.length > 20000) throw new Error("INDEX_TOO_LARGE");
    for (const row of rows) {
      const p = row.payload;
      if (String(p?.roundId) !== roundId) throw new Error("INDEX_INCOMPLETE");
      if (row.event_name === "RoundCreated") created = true;
      if (row.event_name === "RoundOpened") capacity = Number(p.capacity);
      if (row.event_name === "RoundCancelled") cancelled = true;
      if (row.event_name === "WinnerAssigned" || row.event_name === "RoundSettled") assigned = true;
      if (row.event_name === "TicketPurchased") {
        const ticketId = id(p.ticketId, "TICKET");
        if (tickets.has(ticketId)) throw new Error("DUPLICATE_TICKET");
        tickets.set(ticketId, getAddress(p.wallet).toLowerCase());
      }
      if (row.event_name === "TicketDisqualified" || row.event_name === "RefundCredited") removed.add(id(p.ticketId, "TICKET"));
    }
    if (rows.length < 250) break;
  }
  const after = await store.checkpoint(chainId);
  if (!after || before.hash !== after.hash || before.block_number !== after.block_number) throw new Error("INDEX_CHANGED");
  if (!created || capacity !== 1000) throw new Error("INDEX_INCOMPLETE");
  for (const ticket of removed) {
    if (!tickets.delete(ticket)) throw new Error("INDEX_INCOMPLETE");
  }
  if (cancelled) tickets.clear();
  if (tickets.size > capacity) throw new Error("INVALID_COUNTS");
  const wallets = new Map();
  for (const wallet of tickets.values()) wallets.set(wallet, (wallets.get(wallet) || 0) + 1);
  return { wallets, eligibleCount: tickets.size, capacity, cancelled, assigned, roundId,
    indexedBlock: String(before.block_number), indexedBlockHash: "0x" + before.hash };
}
module.exports = { odds, projectPool };
