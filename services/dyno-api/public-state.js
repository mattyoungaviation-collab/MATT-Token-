"use strict";
const { getAddress } = require("ethers");
const PHASES = ["NONE", "DRAFT", "OPEN", "REVIEW", "FROZEN", "RANDOMNESS_PENDING", "RANDOMNESS_READY", "WINNERS_ASSIGNED", "SETTLED", "CANCELLED"];
const TICKET_STATES = ["NONE", "ELIGIBLE", "REFUND_CREDITED", "REFUND_PAID", "CANCELLED_CREDITED", "CANCELLED_PAID"];
const SLOT_STATES = ["PENDING", "SUCCESS", "FAILED", "MISSED"];
function id(value, label = "ROUND") {
  if (!/^[1-9][0-9]{0,77}$/.test(String(value)) || BigInt(value) >= 2n ** 256n) throw new Error(`INVALID_${label}`);
  return String(value);
}
function integer(value) {
  if (typeof value !== "bigint" || value < 0n) throw new Error("MALFORMED_CHAIN_DATA");
  return value.toString();
}
function enumerated(value, states) { const n = Number(value); if (!Number.isInteger(n) || !states[n]) throw new Error("MALFORMED_CHAIN_DATA"); return states[n]; }
async function atBlock({ provider, chainId, nowSeconds = Math.floor(Date.now() / 1000) }, read) {
  if (!provider || BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId)) throw new Error("CHAIN_UNAVAILABLE");
  const block = await provider.getBlock("latest");
  if (!block?.hash || !Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp) || block.timestamp > nowSeconds + 30 || nowSeconds - block.timestamp > 120) throw new Error("STALE_CHAIN_DATA");
  const result = await read({ blockTag: block.number }, block);
  if ((await provider.getBlock(block.number))?.hash !== block.hash) throw new Error("CHAIN_DATA_CHANGED");
  return { ...result, chainBlock: String(block.number), chainBlockHash: block.hash, chainTimestamp: block.timestamp, freshness: "chain-read-unfinalized", authority: "chain", advisory: true };
}
async function readActiveRound(options) {
  return atBlock(options, async at => {
    const active = await options.manager.activeRoundId(at);
    if (typeof active !== "bigint" || active < 0n) throw new Error("MALFORMED_CHAIN_DATA");
    return { roundId: active === 0n ? null : active.toString(), status: active === 0n ? "NO_ACTIVE_ROUND" : "ACTIVE_ROUND" };
  });
}
async function readRound(options) {
  const roundId = id(options.roundId);
  return atBlock(options, async at => {
    const r = await options.manager.getRoundStatus(roundId, at);
    const c = await options.manager.getRoundTerms(roundId, at);
    const nft = await options.manager.getNftPrize(roundId, at);
    const matt = {
      active: await options.manager.mattActive(roundId, at),
      refundable: await options.manager.mattRefundLiability(roundId, at),
      treasuryDue: await options.manager.treasuryMattLiability(roundId, at),
    };
    const phase = enumerated(r.phase, PHASES), count = Number(r.eligibleCount);
    if (phase === "NONE") throw new Error("ROUND_NOT_FOUND");
    if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error("MALFORMED_CHAIN_DATA");
    if (!Array.isArray(c.ronPrizes) || c.ronPrizes.length !== 5 || Number(c.capacity) !== 1000 || nft.tokenId !== c.nftTokenId) throw new Error("MALFORMED_CHAIN_DATA");
    const config = { matt: getAddress(c.matt), ticketRon: integer(c.ticketRon), ticketMatt: integer(c.ticketMatt), capacity: Number(c.capacity),
      ronPrizes: c.ronPrizes.map(integer), nextDynoReserve: integer(c.nextDynoReserve), nftTokenId: integer(c.nftTokenId),
      nftCollection: getAddress(nft.collection), nftDepositor: getAddress(nft.depositor), nftChainId: integer(nft.chainId),
      termsHash: c.termsHash, configHash: c.configHash };
    return { roundId, phase, eligibleCount: count, capacity: config.capacity, config, reviewEndsAt: integer(r.reviewEndsAt), frozenAt: integer(r.frozenAt), snapshotDigest: r.snapshotDigest,
      paymentModel: "RON_AND_HELD_MATT", directActive: integer(r.directActive), saleActive: integer(r.saleActive),
      mattActive: integer(matt.active), mattRefundLiability: integer(matt.refundable), treasuryMattLiability: integer(matt.treasuryDue),
      operationsBalance: integer(r.operationsBalance), refundLiability: integer(r.refundLiability),
      prizeLiability: integer(r.prizeLiability), treasuryLiability: integer(r.treasuryLiability),
      // Historical allocation totals need replayed settlement/payment events.
      // They are never manufactured from the current balance or the manifest.
      reserveTransferred: null, treasuryTransferred: null, historicalTotals: "event-projection-required" };
  });
}
async function readTicket(options) {
  const ticketId = id(options.ticketId, "TICKET");
  return atBlock(options, async at => {
    const t = await options.manager.getTicket(ticketId, at);
    if (t.roundId === 0n) throw new Error("TICKET_NOT_FOUND");
    return { ticketId, roundId: integer(t.roundId), originalWallet: getAddress(t.originalWallet), accountCommitment: t.accountCommitment,
      purchasedAt: integer(t.purchasedAt), dayIndex: integer(t.dayIndex), directRon: integer(t.directRon), saleRon: integer(t.saleRon),
      eligibleIndex: integer(t.eligibleIndex), status: enumerated(t.status, TICKET_STATES), refundAmount: integer(t.refundAmount),
      refundMatt: integer(await options.manager.ticketRefundMatt(ticketId, at)),
      winningIndexes: Array.from({ length: 6 }, (_, i) => i).filter(i => (Number(t.winningBitmap) & (1 << i)) !== 0),
      refundPaid: await options.manager.refundPaid(ticketId, at) };
  });
}
async function readWinners(options) {
  const roundId = id(options.roundId);
  return atBlock(options, async at => {
    const round = await options.manager.getRoundStatus(roundId, at);
    if (round.phase === 0n) throw new Error("ROUND_NOT_FOUND");
    const assigned = [7n, 8n].includes(round.phase);
    if (!assigned) return { roundId, assigned: false, winners: [] };
    const winners = [];
    for (let prizeIndex = 0; prizeIndex < 6; prizeIndex++) {
      const ticketId = await options.manager.getWinnerTicketId(roundId, prizeIndex, at);
      const ticket = await options.manager.getTicket(ticketId, at);
      if (ticketId === 0n || ticket.roundId.toString() !== roundId) throw new Error("MALFORMED_CHAIN_DATA");
      winners.push({ prizeIndex, ticketId: integer(ticketId), beneficiary: getAddress(ticket.originalWallet), kind: prizeIndex < 5 ? "RON" : "EXTERNAL_MANUAL_NFT",
        amount: prizeIndex < 5 && round.phase === 8n ? integer(await options.manager.prizeAmount(roundId, prizeIndex, at)) : null,
        entitlementFunded: round.phase === 8n, paid: prizeIndex < 5 ? await options.manager.prizePaid(roundId, prizeIndex, at) : null,
        // A Ronin report cannot establish Ethereum delivery.
        nftDeliveryVerification: prizeIndex === 5 ? "use-prize-delivery-endpoint" : null });
    }
    return { roundId, assigned: true, winners };
  });
}
async function readBuyback(options) {
  const roundId = id(options.roundId), offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 24);
  if (!Number.isInteger(offset) || offset < 0 || offset > 167 || !Number.isInteger(limit) || limit < 1 || limit > 24) throw new Error("INVALID_PAGINATION");
  return atBlock(options, async (at, block) => {
    if (!options.vault) throw new Error("CHAIN_UNAVAILABLE");
    const [vaultRound, s, returned] = await Promise.all([options.vault.roundId(at), options.vault.getSchedule(at), options.vault.returnedAmount(at)]);
    if (vaultRound.toString() !== roundId) return { roundId, available: false, reason: "NOT_CURRENT_VAULT_SCHEDULE", slots: [] };
    const slots = [];
    for (let slot = offset; slot < Math.min(168, offset + limit); slot++) {
      const storedStatus = enumerated(await options.vault.getSlotStatus(slot, at), SLOT_STATES);
      const startsAt = s.startsAt + BigInt(slot * 3600), endsAt = startsAt + 3600n;
      const status = storedStatus === "PENDING" && s.state !== 0n && BigInt(block.timestamp) >= endsAt ? "MISSED" : storedStatus;
      slots.push({ slot, status, storedStatus, expiredWithoutTerminalRecord: status === "MISSED" && storedStatus === "PENDING", startsAt: integer(startsAt), endsAt: integer(endsAt), ronSpent: status === "SUCCESS" ? integer(s.hourlySlice) : "0",
        mattDelivered: integer(await options.vault.slotMattOut(slot, at)), current: BigInt(block.timestamp) >= startsAt && BigInt(block.timestamp) < endsAt });
    }
    return { roundId, available: true, state: enumerated(s.state, ["NONE", "ACTIVE", "CLOSED"]), budget: integer(s.budget), slice: integer(s.hourlySlice), dust: integer(s.roundingDust),
      t0: integer(s.startsAt), end: integer(s.endsAt), spent: integer(s.spent), mattDelivered: integer(s.delivered), returnLiability: integer(s.unreturned), returned: integer(returned), slots,
      nextOffset: offset + slots.length < 168 ? offset + slots.length : null };
  });
}
module.exports = { readActiveRound, readRound, readTicket, readWinners, readBuyback, atBlock, id };
