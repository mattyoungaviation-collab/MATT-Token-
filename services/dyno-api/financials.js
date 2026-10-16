"use strict";
const { id } = require("./public-state");

function amount(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || BigInt(value) >= 2n ** 256n) throw new Error("MALFORMED_INDEXED_EVENT");
  return BigInt(value);
}
async function projectFinancials({ store, chainId, roundId, finalityPolicy }) {
  roundId = id(roundId);
  if (!store?.ledger || !store?.checkpoint) throw new Error("INDEX_UNAVAILABLE");
  const before = await store.checkpoint(chainId);
  if (!before?.hash || before.block_number === undefined) throw new Error("INDEX_UNAVAILABLE");
  const totals = {
    ticketDirectRon: 0n, ticketSaleRon: 0n, refundCreditedRon: 0n, refundPaidRon: 0n,
    prizePaidRon: 0n, reserveAllocatedRon: 0n, reserveSentAtSettlementRon: 0n,
    treasuryAllocatedRon: 0n, treasurySentAtSettlementRon: 0n, laterTreasuryClaimsRon: 0n,
    buybackBudgetRon: 0n, buybackSpentRon: 0n, mattDelivered: 0n, buybackReturnedDueRon: 0n,
    buybackReturnClaimedRon: 0n, operationsFundedRon: 0n,
    mattRefundCredited: 0n, mattRefundPaid: 0n, treasuryMattAllocated: 0n, treasuryMattClaimed: 0n,
  };
  let eventsRead = 0, created = false, settled = false, closed = false, startedBudget = null, closedMatt = null;
  for (let offset = 0; offset <= 20_000; offset += 1000) {
    const rows = await store.ledger({ roundId, limit: 1000, offset });
    if (!Array.isArray(rows) || rows.length > 1000 || offset + rows.length > 20_000) throw new Error("INDEX_TOO_LARGE");
    eventsRead += rows.length;
    for (const row of rows) {
      const p = row.payload;
      if (!p || String(p.roundId) !== roundId) throw new Error("MALFORMED_INDEXED_EVENT");
      switch (row.event_name) {
        case "RoundCreated": if (created) throw new Error("MALFORMED_INDEXED_EVENT"); created = true; break;
        case "TicketPurchased":
          if (amount(p.saleRon) !== 0n) throw new Error("ACCOUNTING_MISMATCH");
          totals.ticketDirectRon += amount(p.directRon); break;
        case "RefundCredited": totals.refundCreditedRon += amount(p.amount); break;
        case "RefundPaid": totals.refundPaidRon += amount(p.amount); break;
        case "MattRefundCredited": totals.mattRefundCredited += amount(p.amount); break;
        case "MattRefundPaid": totals.mattRefundPaid += amount(p.amount); break;
        case "TreasuryMattAllocated": totals.treasuryMattAllocated += amount(p.amount); break;
        case "TreasuryMattClaimed": totals.treasuryMattClaimed += amount(p.amount); break;
        case "PrizePaid": if (p.nft === false) totals.prizePaidRon += amount(p.amount); break;
        case "NextDynoReserved":
          totals.reserveAllocatedRon += amount(p.amount);
          if (p.transferred === true) totals.reserveSentAtSettlementRon += amount(p.amount);
          break;
        case "TreasuryTransferred":
          totals.treasuryAllocatedRon += amount(p.amount);
          if (p.transferred === true) totals.treasurySentAtSettlementRon += amount(p.amount);
          break;
        case "TreasuryLiabilityClaimed": totals.laterTreasuryClaimsRon += amount(p.amount); break;
        case "RoundSettled":
          if (settled) throw new Error("MALFORMED_INDEXED_EVENT");
          settled = true; totals.buybackBudgetRon = amount(p.buybackBudget);
          if (totals.buybackBudgetRon !== 0n) throw new Error("ACCOUNTING_MISMATCH");
          break;
        case "BuybackStarted": if (startedBudget !== null) throw new Error("MALFORMED_INDEXED_EVENT"); startedBudget = amount(p.budget); break;
        case "BuybackSlotSucceeded": totals.buybackSpentRon += amount(p.ronSpent); totals.mattDelivered += amount(p.mattDelivered); break;
        case "BuybackClosed":
          if (closed) throw new Error("MALFORMED_INDEXED_EVENT");
          closed = true; totals.buybackReturnedDueRon = amount(p.returned); closedMatt = amount(p.mattDelivered); break;
        case "ReturnClaimed": totals.buybackReturnClaimedRon += amount(p.amount); break;
        case "OperationsFunded": totals.operationsFundedRon += amount(p.amount); break;
      }
    }
    if (rows.length < 1000) break;
  }
  const after = await store.checkpoint(chainId);
  if (!after || after.block_number !== before.block_number || after.hash !== before.hash) throw new Error("INDEX_CHANGED");
  if (!created) throw new Error("INDEX_INCOMPLETE");
  if (totals.refundPaidRon > totals.refundCreditedRon || totals.mattRefundPaid > totals.mattRefundCredited || totals.treasuryMattClaimed > totals.treasuryMattAllocated || totals.buybackSpentRon > totals.buybackBudgetRon ||
      totals.laterTreasuryClaimsRon > totals.reserveAllocatedRon - totals.reserveSentAtSettlementRon + totals.treasuryAllocatedRon - totals.treasurySentAtSettlementRon ||
      (startedBudget !== null && (!settled || startedBudget !== totals.buybackBudgetRon)) ||
      (closed && (totals.buybackSpentRon + totals.buybackReturnedDueRon !== totals.buybackBudgetRon || closedMatt !== totals.mattDelivered))) throw new Error("ACCOUNTING_MISMATCH");
  return { roundId, indexedBlock: String(before.block_number), indexedBlockHash: `0x${before.hash}`, finalityPolicy,
    freshness: finalityPolicy === "rpc-finalized" ? "indexed-finalized-checkpoint" : "indexed-confirmation-checkpoint",
    eventsRead, settled, closed, totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()])),
    note: "Historical indexed events only; current claims and balances require fresh contract reads." };
}
module.exports = { projectFinancials };
