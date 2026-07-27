const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const CONTRACT = "0xFF2E30F4EFe8aF8E32365fCba76dCc9136006822";
const CONTRACT_LOWER = CONTRACT.toLowerCase();
const DEPLOYMENT_BLOCK = 58_730_944;
const COIN_PRICE_RAW = 10_000n * 10n ** 18n;
const MULTIPLIER_SCALE = 10_000n;
const MULTIPLIERS = [
  500_000n, 250_000n, 100_174n, 50_000n, 20_000n, 15_000n, 8_000n, 7_000n,
  4_848n,
  7_000n, 8_000n, 15_000n, 20_000n, 50_000n, 100_174n, 250_000n, 500_000n
];
const ABI = [
  "event BatchSettled(bytes32 indexed requestHash,address indexed player,uint8 coinCount,uint256 payout,uint256 packedSlotsA,uint256 packedSlotsB)"
];
const iface = new Interface(ABI);
const topic = iface.getEvent("BatchSettled").topicHash;

function installPlinkoHistoryIndex(app, options = {}) {
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("Plinko history requires rpcRequest");
  const profiles = options.profiles || null;
  const stateFile = String(options.stateFile || process.env.PLINKO_HISTORY_FILE || "").trim();
  const chunkSize = positiveInteger(process.env.PLINKO_HISTORY_CHUNK_SIZE, 4_000);
  const refreshMs = positiveInteger(process.env.PLINKO_HISTORY_REFRESH_MS, 20_000);
  let state = loadState(stateFile) || freshState();
  let refreshPromise = null;
  let lastRefreshAt = 0;
  let lastError = null;
  const blockTimes = new Map();

  async function logsFor(fromBlock, toBlock, depth = 0) {
    if (fromBlock > toBlock) return [];
    try {
      return await rpcRequest("eth_getLogs", [{
        address: CONTRACT,
        fromBlock: hexBlock(fromBlock),
        toBlock: hexBlock(toBlock),
        topics: [topic]
      }]);
    } catch (error) {
      if (fromBlock >= toBlock || depth >= 20) throw error;
      const middle = Math.floor((fromBlock + toBlock) / 2);
      return (await logsFor(fromBlock, middle, depth + 1))
        .concat(await logsFor(middle + 1, toBlock, depth + 1));
    }
  }

  async function blockTimestamp(blockNumber) {
    if (blockTimes.has(blockNumber)) return blockTimes.get(blockNumber);
    const block = await rpcRequest("eth_getBlockByNumber", [hexBlock(blockNumber), false]);
    const timestamp = block?.timestamp ? Number(BigInt(block.timestamp)) * 1_000 : null;
    blockTimes.set(blockNumber, timestamp);
    return timestamp;
  }

  async function ingest(log) {
    const parsed = iface.parseLog(log);
    if (!parsed || parsed.name !== "BatchSettled") return;
    const requestHash = String(parsed.args.requestHash).toLowerCase();
    if (state.seen[requestHash]) return;

    const wallet = String(parsed.args.player).toLowerCase();
    const coinCount = Number(parsed.args.coinCount);
    const payout = BigInt(parsed.args.payout);
    const wager = COIN_PRICE_RAW * BigInt(coinCount);
    const net = payout - wager;
    const slots = decodeSlots(coinCount, parsed.args.packedSlotsA, parsed.args.packedSlotsB);
    const winningCoins = slots.filter(slot => MULTIPLIERS[slot] >= MULTIPLIER_SCALE).length;
    const losingCoins = coinCount - winningCoins;
    const bestMultiplierRaw = slots.reduce(
      (best, slot) => MULTIPLIERS[slot] > best ? MULTIPLIERS[slot] : best,
      0n
    );
    const blockNumber = Number(BigInt(log.blockNumber));
    const timestamp = await blockTimestamp(blockNumber).catch(() => null);
    const record = {
      requestHash,
      wallet,
      coinCount,
      winningCoins,
      losingCoins,
      wagerRaw: wager.toString(),
      payoutRaw: payout.toString(),
      netRaw: net.toString(),
      bestMultiplierRaw: bestMultiplierRaw.toString(),
      slots,
      transactionHash: log.transactionHash,
      blockNumber,
      timestamp
    };

    const player = state.players[wallet] || newPlayer(wallet);
    player.batches += 1;
    player.coins += coinCount;
    player.winningCoins += winningCoins;
    player.losingCoins += losingCoins;
    player.profitableBatches += net > 0n ? 1 : 0;
    player.losingBatches += net < 0n ? 1 : 0;
    player.breakEvenBatches += net === 0n ? 1 : 0;
    player.totalWagerRaw = (BigInt(player.totalWagerRaw) + wager).toString();
    player.totalPayoutRaw = (BigInt(player.totalPayoutRaw) + payout).toString();
    player.netRaw = (BigInt(player.netRaw) + net).toString();
    if (net > BigInt(player.biggestWinRaw)) player.biggestWinRaw = net.toString();
    if (net < 0n && -net > BigInt(player.biggestLossRaw)) {
      player.biggestLossRaw = (-net).toString();
    }
    player.lastPlayedAt = timestamp || Date.now();
    player.history.unshift(record);
    if (player.history.length > 250) player.history.length = 250;
    state.players[wallet] = player;
    state.seen[requestHash] = 1;
    state.totalBatches += 1;
    state.totalCoins += coinCount;
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && Date.now() - lastRefreshAt < refreshMs) return state;
    refreshPromise = (async () => {
      const latest = Number(BigInt(await rpcRequest("eth_blockNumber", [])));
      if (
        state.version !== 1
        || state.contract !== CONTRACT_LOWER
        || state.throughBlock > latest
      ) state = freshState();
      let cursor = state.throughBlock + 1;
      while (cursor <= latest) {
        const end = Math.min(latest, cursor + chunkSize - 1);
        const logs = await logsFor(cursor, end);
        logs.sort((a, b) =>
          compareBigInt(BigInt(a.blockNumber), BigInt(b.blockNumber))
          || compareBigInt(BigInt(a.logIndex), BigInt(b.logIndex))
        );
        for (const log of logs) await ingest(log);
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
      console.warn("Plinko history refresh failed:", lastError);
      return state;
    }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  app.get("/api/plinko/history/:wallet", async (req, res) => {
    const force = String(req.query.fresh || "") === "1";
    if (force) await refresh(true);
    else refresh(false);
    const wallet = normalizeWallet(req.params.wallet);
    if (!wallet) return res.status(400).json({ error: "INVALID_WALLET" });
    const player = state.players[wallet] || newPlayer(wallet);
    const limit = clampInteger(req.query.limit, 1, 250, 100);
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    return res.json({
      status: refreshPromise ? "INDEXING" : "READY",
      indexedThroughBlock: state.throughBlock,
      player: publicPlayer(player, true, limit, usernameFor(profiles, wallet))
    });
  });

  app.get("/api/plinko/leaderboard", async (req, res) => {
    const force = String(req.query.fresh || "") === "1";
    if (force) await refresh(true);
    else refresh(false);
    const sort = String(req.query.sort || "net-desc");
    const search = String(req.query.search || "").trim().toLowerCase();
    const minCoins = clampInteger(req.query.minCoins, 0, 1_000_000, 0);
    const offset = clampInteger(req.query.offset, 0, 1_000_000, 0);
    const limit = clampInteger(req.query.limit, 1, 100, 25);
    const rows = Object.values(state.players)
      .map(player => ({ player, username: usernameFor(profiles, player.wallet) }))
      .filter(({ player, username }) =>
        player.coins >= minCoins
        && (!search || player.wallet.includes(search) || String(username || "").toLowerCase().includes(search))
      )
      .sort((left, right) => comparator(sort)(left.player, right.player));
    const page = rows.slice(offset, offset + limit).map(({ player, username }, index) => ({
      rank: offset + index + 1,
      ...publicPlayer(player, false, 0, username)
    }));
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    return res.json({
      status: refreshPromise ? "INDEXING" : "READY",
      sort,
      totalPlayers: rows.length,
      totalBatches: state.totalBatches,
      totalCoins: state.totalCoins,
      indexedThroughBlock: state.throughBlock,
      updatedAt: state.updatedAt,
      players: page,
      hasMore: offset + limit < rows.length,
      error: lastError
    });
  });

  refresh(true);
  return {
    refresh,
    getStatus: () => ({
      indexedThroughBlock: state.throughBlock,
      players: Object.keys(state.players).length,
      totalBatches: state.totalBatches,
      totalCoins: state.totalCoins,
      indexing: Boolean(refreshPromise),
      lastError
    })
  };
}

function decodeSlots(coinCountValue, packedAValue, packedBValue) {
  const coinCount = Number(coinCountValue);
  if (!Number.isInteger(coinCount) || coinCount < 1 || coinCount > 100) {
    throw new Error("Invalid Plinko coin count");
  }
  const packedA = BigInt(packedAValue);
  const packedB = BigInt(packedBValue);
  const slots = [];
  for (let index = 0; index < coinCount; index += 1) {
    const source = index < 51 ? packedA : packedB;
    const offset = BigInt(index < 51 ? index : index - 51) * 5n;
    const slot = Number((source >> offset) & 31n);
    if (slot < 0 || slot >= MULTIPLIERS.length) throw new Error("Invalid packed Plinko slot");
    slots.push(slot);
  }
  return slots;
}

function newPlayer(wallet) {
  return {
    wallet,
    batches: 0,
    coins: 0,
    winningCoins: 0,
    losingCoins: 0,
    profitableBatches: 0,
    losingBatches: 0,
    breakEvenBatches: 0,
    totalWagerRaw: "0",
    totalPayoutRaw: "0",
    netRaw: "0",
    biggestWinRaw: "0",
    biggestLossRaw: "0",
    lastPlayedAt: null,
    history: []
  };
}

function publicPlayer(player, includeHistory, limit = 0, username = null) {
  return {
    wallet: player.wallet,
    username: username || null,
    batches: player.batches,
    coins: player.coins,
    winningCoins: player.winningCoins,
    losingCoins: player.losingCoins,
    profitableBatches: player.profitableBatches,
    losingBatches: player.losingBatches,
    breakEvenBatches: player.breakEvenBatches,
    winRate: player.coins ? player.winningCoins / player.coins : 0,
    totalWagerRaw: player.totalWagerRaw,
    totalPayoutRaw: player.totalPayoutRaw,
    netRaw: player.netRaw,
    biggestWinRaw: player.biggestWinRaw,
    biggestLossRaw: player.biggestLossRaw,
    lastPlayedAt: player.lastPlayedAt,
    ...(includeHistory ? { history: player.history.slice(0, limit) } : {})
  };
}

function comparator(sort) {
  const byBig = (key, direction = -1) => (a, b) => {
    const left = BigInt(a[key]);
    const right = BigInt(b[key]);
    if (left === right) return b.coins - a.coins || a.wallet.localeCompare(b.wallet);
    return left > right ? direction : -direction;
  };
  switch (sort) {
    case "batches-desc": return (a, b) => b.batches - a.batches || b.coins - a.coins;
    case "coins-desc": return (a, b) => b.coins - a.coins || b.batches - a.batches;
    case "net-asc": return byBig("netRaw", 1);
    case "volume-desc": return byBig("totalWagerRaw", -1);
    case "wins-desc": return (a, b) => b.winningCoins - a.winningCoins || b.coins - a.coins;
    case "losses-desc": return (a, b) => b.losingCoins - a.losingCoins || b.coins - a.coins;
    case "winrate-desc": return (a, b) =>
      (b.winningCoins / Math.max(1, b.coins)) - (a.winningCoins / Math.max(1, a.coins))
      || b.coins - a.coins;
    case "biggest-win": return byBig("biggestWinRaw", -1);
    case "biggest-loss": return byBig("biggestLossRaw", -1);
    default: return byBig("netRaw", -1);
  }
}

function usernameFor(profiles, wallet) {
  try { return profiles?.getUsername?.(wallet) || null; }
  catch { return null; }
}
function freshState() {
  return {
    version: 1,
    contract: CONTRACT_LOWER,
    deploymentBlock: DEPLOYMENT_BLOCK,
    throughBlock: DEPLOYMENT_BLOCK - 1,
    totalBatches: 0,
    totalCoins: 0,
    players: {},
    seen: {},
    updatedAt: null
  };
}
function loadState(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state?.version === 1 && state?.contract === CONTRACT_LOWER ? state : null;
  } catch { return null; }
}
function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn("Plinko history checkpoint failed:", safe(error));
  }
}
function normalizeWallet(value) {
  const wallet = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null;
}
function compareBigInt(left, right) { return left === right ? 0 : left < right ? -1 : 1; }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function safe(error) { return String(error?.message || error || "Unknown error").slice(0, 220); }

module.exports = {
  CONTRACT,
  DEPLOYMENT_BLOCK,
  MULTIPLIERS,
  decodeSlots,
  installPlinkoHistoryIndex
};
