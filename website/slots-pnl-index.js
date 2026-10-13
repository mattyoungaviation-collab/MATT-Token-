const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const SLOTS = String(
  process.env.SLOTS_V2_ADDRESS || "0x256D9950fC658043813f5a1B811F483269a4b197"
);
const SLOTS_LOWER = SLOTS.toLowerCase();
const DEPLOYMENT_BLOCK = positiveInteger(process.env.SLOTS_DEPLOYMENT_BLOCK, 59_241_623);
const ABI = [
  "event SpinSettled(uint256 indexed spinId,bytes32 indexed requestHash,address indexed player,uint8 creditType,uint256 sessionId,uint32 mathVersion,uint64 packedGrid,uint32 winningLinesMask,uint8 scatterCount,uint8 wildReel,uint8 freeSpinsAwarded,uint256 wager,uint256 payout,uint256 treasuryLoss)"
];
const iface = new Interface(ABI);
const settledTopic = iface.getEvent("SpinSettled").topicHash;
const VALID_SORTS = new Set([
  "pnl-desc",
  "pnl-asc",
  "spent-desc",
  "won-desc",
  "biggest-desc",
  "win-rate-desc",
  "spins-desc",
  "recent-desc"
]);
const WIN_RATE_MINIMUM_SPINS = 10;

function installSlotsPnlIndex(app, options = {}) {
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("Slots PNL index requires rpcRequest");

  const stateFile = String(options.stateFile || process.env.SLOTS_PNL_STATE_FILE || "").trim();
  const chunkSize = positiveInteger(process.env.SLOTS_PNL_CHUNK_SIZE, 10_000);
  const refreshMs = positiveInteger(process.env.SLOTS_PNL_REFRESH_MS, 15_000);
  const finalityBlocks = positiveInteger(process.env.SLOTS_PNL_FINALITY_BLOCKS, 3);
  let state = loadState(stateFile) || freshState();
  let refreshPromise = null;
  let lastRefreshAt = 0;
  let lastError = null;

  async function logsFor(fromBlock, toBlock, depth = 0) {
    if (fromBlock > toBlock) return [];
    try {
      return await rpcRequest("eth_getLogs", [{
        address: SLOTS,
        fromBlock: hexBlock(fromBlock),
        toBlock: hexBlock(toBlock),
        topics: [settledTopic]
      }]);
    } catch (error) {
      if (fromBlock >= toBlock || depth >= 24) throw error;
      const middle = Math.floor((fromBlock + toBlock) / 2);
      return (await logsFor(fromBlock, middle, depth + 1))
        .concat(await logsFor(middle + 1, toBlock, depth + 1));
    }
  }

  function ingest(log) {
    const parsed = iface.parseLog(log);
    if (!parsed || parsed.name !== "SpinSettled") return;

    const spinId = BigInt(parsed.args.spinId).toString();
    if (state.seenSpins[spinId]) return;

    const wallet = String(parsed.args.player).toLowerCase();
    const creditType = Number(parsed.args.creditType);
    const wager = BigInt(parsed.args.wager);
    const payout = BigInt(parsed.args.payout);
    const player = state.players[wallet] || newPlayer(wallet);

    player.totalSpins += 1;
    player.wonRaw = addRaw(player.wonRaw, payout);
    if (payout > 0n) player.returningSpins += 1;

    if (creditType === 1) {
      player.paidSpins += 1;
      player.spentRaw = addRaw(player.spentRaw, wager);
      if (payout > wager) player.winningPaidSpins += 1;
      state.totalPaidSpins += 1;
      state.totalSpentRaw = addRaw(state.totalSpentRaw, wager);
    } else if (creditType === 2) {
      player.bonusSpins += 1;
      state.totalBonusSpins += 1;
    }

    if (payout > BigInt(player.biggestWinRaw)) {
      player.biggestWinRaw = payout.toString();
      player.biggestWinSpinId = spinId;
    }
    if (payout > BigInt(state.biggestWinRaw)) {
      state.biggestWinRaw = payout.toString();
      state.biggestWinWallet = wallet;
      state.biggestWinSpinId = spinId;
    }

    player.lastPlayedBlock = Number(BigInt(log.blockNumber));
    state.players[wallet] = player;
    state.seenSpins[spinId] = 1;
    state.totalSettledSpins += 1;
    state.totalWonRaw = addRaw(state.totalWonRaw, payout);
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && Date.now() - lastRefreshAt < refreshMs) return state;

    refreshPromise = (async () => {
      const chainHead = Number(BigInt(await rpcRequest("eth_blockNumber", [])));
      const target = Math.max(DEPLOYMENT_BLOCK - 1, chainHead - finalityBlocks);
      if (
        state.version !== 1
        || state.slots !== SLOTS_LOWER
        || state.deploymentBlock !== DEPLOYMENT_BLOCK
        || state.throughBlock > target
      ) state = freshState();

      let cursor = state.throughBlock + 1;
      while (cursor <= target) {
        const end = Math.min(target, cursor + chunkSize - 1);
        const logs = await logsFor(cursor, end);
        logs.sort((left, right) => {
          const blockDifference = Number(BigInt(left.blockNumber) - BigInt(right.blockNumber));
          if (blockDifference) return blockDifference;
          return Number(BigInt(left.logIndex || "0x0") - BigInt(right.logIndex || "0x0"));
        });
        for (const log of logs) ingest(log);
        state.throughBlock = end;
        state.updatedAt = new Date().toISOString();
        saveState(stateFile, state);
        cursor = end + 1;
      }

      lastRefreshAt = Date.now();
      lastError = null;
      return state;
    })().catch(error => {
      lastError = safe(error);
      console.warn("Slots PNL refresh failed:", lastError);
      return state;
    }).finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  }

  app.get("/api/slots/pnl", async (req, res) => {
    await refresh(String(req.query.fresh || "") === "1");
    const requestedSort = String(req.query.sort || "pnl-desc");
    const sort = VALID_SORTS.has(requestedSort) ? requestedSort : "pnl-desc";
    const search = normalizeSearch(req.query.search);
    const offset = clampInteger(req.query.offset, 0, 1_000_000, 0);
    const limit = clampInteger(req.query.limit, 1, 100, 25);
    const ranked = Object.values(state.players).map(publicPlayer).sort(comparator(sort));
    const rankByWallet = new Map(ranked.map((player, index) => [player.wallet, index + 1]));
    const matches = search
      ? ranked.filter(player => player.wallet.includes(search))
      : ranked;
    const players = matches.slice(offset, offset + limit).map(player => ({
      rank: rankByWallet.get(player.wallet),
      ...player
    }));

    const status = lastError && state.throughBlock < DEPLOYMENT_BLOCK ? "ERROR" : "READY";
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    res.json({
      status,
      sort,
      search,
      summary: {
        totalPlayers: Object.keys(state.players).length,
        matchingPlayers: matches.length,
        totalSettledSpins: state.totalSettledSpins,
        totalPaidSpins: state.totalPaidSpins,
        totalBonusSpins: state.totalBonusSpins,
        totalSpentRaw: state.totalSpentRaw,
        totalWonRaw: state.totalWonRaw,
        totalPnlRaw: subtractRaw(state.totalWonRaw, state.totalSpentRaw),
        biggestWinRaw: state.biggestWinRaw,
        biggestWinWallet: state.biggestWinWallet,
        biggestWinSpinId: state.biggestWinSpinId,
        deploymentBlock: state.deploymentBlock,
        indexedThroughBlock: state.throughBlock,
        updatedAt: state.updatedAt,
        winRateMinimumPaidSpins: WIN_RATE_MINIMUM_SPINS
      },
      players,
      pagination: {
        offset,
        limit,
        hasPrevious: offset > 0,
        hasMore: offset + limit < matches.length
      },
      definitions: {
        spent: "Settled paid-spin wagers only. Unused refundable credits are excluded.",
        won: "All settled paid-spin and bonus-spin payouts, whether claimed or still claimable.",
        pnl: "Total won minus total spent.",
        winRate: "Paid spins whose payout exceeded their wager, divided by settled paid spins.",
        biggestWin: "Largest gross payout from one settled paid or bonus spin."
      },
      error: lastError
    });
  });

  refresh(true);
  return {
    refresh,
    getStatus: () => ({
      indexedThroughBlock: state.throughBlock,
      players: Object.keys(state.players).length,
      totalPaidSpins: state.totalPaidSpins,
      lastError
    })
  };
}

function publicPlayer(player) {
  const spent = BigInt(player.spentRaw);
  const won = BigInt(player.wonRaw);
  return {
    wallet: player.wallet,
    paidSpins: player.paidSpins,
    bonusSpins: player.bonusSpins,
    totalSpins: player.totalSpins,
    winningPaidSpins: player.winningPaidSpins,
    returningSpins: player.returningSpins,
    spentRaw: player.spentRaw,
    wonRaw: player.wonRaw,
    pnlRaw: (won - spent).toString(),
    biggestWinRaw: player.biggestWinRaw,
    biggestWinSpinId: player.biggestWinSpinId,
    winRateBps: player.paidSpins
      ? Math.floor((player.winningPaidSpins * 10_000) / player.paidSpins)
      : 0,
    returnRateBps: player.totalSpins
      ? Math.floor((player.returningSpins * 10_000) / player.totalSpins)
      : 0,
    lastPlayedBlock: player.lastPlayedBlock
  };
}

function comparator(sort) {
  const tie = (left, right) => right.totalSpins - left.totalSpins
    || compareBigDesc(left.spentRaw, right.spentRaw)
    || left.wallet.localeCompare(right.wallet);
  if (sort === "pnl-asc") return (left, right) => compareBigAsc(left.pnlRaw, right.pnlRaw) || tie(left, right);
  if (sort === "spent-desc") return (left, right) => compareBigDesc(left.spentRaw, right.spentRaw) || tie(left, right);
  if (sort === "won-desc") return (left, right) => compareBigDesc(left.wonRaw, right.wonRaw) || tie(left, right);
  if (sort === "biggest-desc") return (left, right) => compareBigDesc(left.biggestWinRaw, right.biggestWinRaw) || tie(left, right);
  if (sort === "spins-desc") return (left, right) => right.totalSpins - left.totalSpins || tie(left, right);
  if (sort === "recent-desc") return (left, right) => (right.lastPlayedBlock || 0) - (left.lastPlayedBlock || 0) || tie(left, right);
  if (sort === "win-rate-desc") return (left, right) => {
    const leftQualified = left.paidSpins >= WIN_RATE_MINIMUM_SPINS ? 1 : 0;
    const rightQualified = right.paidSpins >= WIN_RATE_MINIMUM_SPINS ? 1 : 0;
    return rightQualified - leftQualified
      || right.winRateBps - left.winRateBps
      || right.paidSpins - left.paidSpins
      || tie(left, right);
  };
  return (left, right) => compareBigDesc(left.pnlRaw, right.pnlRaw) || tie(left, right);
}

function newPlayer(wallet) {
  return {
    wallet,
    paidSpins: 0,
    bonusSpins: 0,
    totalSpins: 0,
    winningPaidSpins: 0,
    returningSpins: 0,
    spentRaw: "0",
    wonRaw: "0",
    biggestWinRaw: "0",
    biggestWinSpinId: null,
    lastPlayedBlock: null
  };
}

function freshState() {
  return {
    version: 1,
    slots: SLOTS_LOWER,
    deploymentBlock: DEPLOYMENT_BLOCK,
    throughBlock: DEPLOYMENT_BLOCK - 1,
    totalSettledSpins: 0,
    totalPaidSpins: 0,
    totalBonusSpins: 0,
    totalSpentRaw: "0",
    totalWonRaw: "0",
    biggestWinRaw: "0",
    biggestWinWallet: null,
    biggestWinSpinId: null,
    players: {},
    seenSpins: {},
    updatedAt: null
  };
}

function loadState(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state?.version === 1
      && state?.slots === SLOTS_LOWER
      && state?.deploymentBlock === DEPLOYMENT_BLOCK
      ? state
      : null;
  } catch {
    return null;
  }
}

function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn("Slots PNL checkpoint failed:", safe(error));
  }
}

function normalizeSearch(value) {
  const text = String(value || "").trim().toLowerCase();
  return text.startsWith("ronin:") ? `0x${text.slice(6)}` : text;
}
function addRaw(current, amount) { return (BigInt(current) + BigInt(amount)).toString(); }
function subtractRaw(left, right) { return (BigInt(left) - BigInt(right)).toString(); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function compareBigDesc(left, right) { left = BigInt(left); right = BigInt(right); return left === right ? 0 : left > right ? -1 : 1; }
function compareBigAsc(left, right) { return compareBigDesc(right, left); }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function clampInteger(value, min, max, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function safe(error) { return String(error?.message || error || "Unknown error").slice(0, 220); }

module.exports = { installSlotsPnlIndex };
