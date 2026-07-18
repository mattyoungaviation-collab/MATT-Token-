const ROUND_MS = 24 * 60 * 60_000;
const TREASURY_FEE_RAW = 1_000n * 10n ** 18n;

function newRound(now) {
  const startsAt = Math.floor(now / ROUND_MS) * ROUND_MS;
  return {
    id: new Date(startsAt).toISOString().slice(0, 10),
    startsAt,
    endsAt: startsAt + ROUND_MS,
    potRaw: "0",
    entries: 0,
    players: {}
  };
}

function leaderboardRows(round) {
  return Object.values(round.players || {})
    .sort((left, right) => right.score - left.score || left.achievedAt - right.achievedAt || left.wallet.localeCompare(right.wallet))
    .map((player, index) => ({ rank: index + 1, ...player }));
}

function prizePotRaw(round) {
  const gross = BigInt(round.potRaw || "0");
  const fees = BigInt(Number(round.entries || 0)) * TREASURY_FEE_RAW;
  return gross > fees ? gross - fees : 0n;
}

function finalizeRound(round) {
  const leaders = leaderboardRows(round).slice(0, 3);
  const pot = prizePotRaw(round);
  const first = pot * 50n / 100n;
  const second = pot * 35n / 100n;
  const third = pot - first - second;
  const shares = [first, second, third];
  const winners = leaders.map((leader, index) => ({
    ...leader,
    sharePercent: [50, 35, 15][index],
    payoutRaw: shares[index].toString(),
    payoutMatt: formatUnits(shares[index]),
    payoutStatus: "PENDING_SMART_CONTRACT_SETTLEMENT"
  }));
  return {
    id: round.id,
    startsAt: round.startsAt,
    endsAt: round.endsAt,
    grossEntriesRaw: String(round.potRaw || "0"),
    treasuryFeeRaw: (BigInt(Number(round.entries || 0)) * TREASURY_FEE_RAW).toString(),
    potRaw: pot.toString(),
    potMatt: formatUnits(pot),
    entries: round.entries,
    playerCount: Object.keys(round.players || {}).length,
    winners,
    status: winners.length ? "CONTRACT_PAYOUT_PENDING" : "NO_WINNERS",
    finalizedAt: Date.now()
  };
}

function publicRound(round) {
  const pot = prizePotRaw(round);
  return {
    id: round.id,
    startsAt: round.startsAt,
    endsAt: round.endsAt,
    potRaw: pot.toString(),
    potMatt: formatUnits(pot),
    entries: Number(round.entries || 0),
    playerCount: Object.keys(round.players || {}).length
  };
}

function parseTokenAmount(value) {
  const text = String(value || "0").trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) return 0n;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

function formatUnits(value) {
  const raw = BigInt(value || 0);
  const whole = raw / 10n ** 18n;
  const fraction = (raw % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

module.exports = { ROUND_MS, TREASURY_FEE_RAW, newRound, leaderboardRows, prizePotRaw, finalizeRound, publicRound, parseTokenAmount, formatUnits };
