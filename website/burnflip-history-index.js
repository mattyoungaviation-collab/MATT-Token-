const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const CONTRACT = "0xd6B6E08fB04b2Ee76e6584f49c6adE75d7ad144e";
const CONTRACT_LOWER = CONTRACT.toLowerCase();
const DEPLOYMENT_BLOCK = 58_299_639;
const ABI = [
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 choice,uint8 outcome,uint256 amount,uint256 payout,bool won,bytes32 entropyBlockHash,uint256 randomWord)"
];
const iface = new Interface(ABI);
const topic = iface.getEvent("BetSettled").topicHash;

function installBurnFlipHistoryIndex(app, options = {}) {
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("BurnFlip history requires rpcRequest");
  const stateFile = String(options.stateFile || process.env.BURNFLIP_HISTORY_FILE || "").trim();
  const chunkSize = positiveInteger(process.env.BURNFLIP_HISTORY_CHUNK_SIZE, 4_000);
  const refreshMs = positiveInteger(process.env.BURNFLIP_HISTORY_REFRESH_MS, 20_000);
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
      return (await logsFor(fromBlock, middle, depth + 1)).concat(await logsFor(middle + 1, toBlock, depth + 1));
    }
  }

  async function blockTimestamp(blockNumber) {
    if (blockTimes.has(blockNumber)) return blockTimes.get(blockNumber);
    const block = await rpcRequest("eth_getBlockByNumber", [hexBlock(blockNumber), false]);
    const timestamp = block?.timestamp ? Number(BigInt(block.timestamp)) * 1000 : null;
    blockTimes.set(blockNumber, timestamp);
    return timestamp;
  }

  async function ingest(log) {
    const parsed = iface.parseLog(log);
    if (!parsed || parsed.name !== "BetSettled") return;
    const betId = BigInt(parsed.args.betId).toString();
    if (state.seen[betId]) return;

    const wallet = String(parsed.args.player).toLowerCase();
    const amount = BigInt(parsed.args.amount);
    const payout = BigInt(parsed.args.payout);
    const net = payout - amount;
    const won = Boolean(parsed.args.won);
    const blockNumber = Number(BigInt(log.blockNumber));
    const timestamp = await blockTimestamp(blockNumber).catch(() => null);
    const record = {
      betId,
      wallet,
      choice: Number(parsed.args.choice),
      outcome: Number(parsed.args.outcome),
      amountRaw: amount.toString(),
      payoutRaw: payout.toString(),
      netRaw: net.toString(),
      won,
      transactionHash: log.transactionHash,
      blockNumber,
      timestamp
    };

    const player = state.players[wallet] || newPlayer(wallet);
    player.flips += 1;
    player.wins += won ? 1 : 0;
    player.losses += won ? 0 : 1;
    player.totalBetRaw = (BigInt(player.totalBetRaw) + amount).toString();
    player.totalPayoutRaw = (BigInt(player.totalPayoutRaw) + payout).toString();
    player.netRaw = (BigInt(player.netRaw) + net).toString();
    if (net > BigInt(player.biggestWinRaw)) player.biggestWinRaw = net.toString();
    if (net < 0n && -net > BigInt(player.biggestLossRaw)) player.biggestLossRaw = (-net).toString();
    player.lastPlayedAt = timestamp || Date.now();
    player.history.unshift(record);
    if (player.history.length > 250) player.history.length = 250;
    state.players[wallet] = player;
    state.seen[betId] = 1;
    state.totalSettlements += 1;
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && Date.now() - lastRefreshAt < refreshMs) return state;
    refreshPromise = (async () => {
      const latest = Number(BigInt(await rpcRequest("eth_blockNumber", [])));
      if (state.version !== 1 || state.contract !== CONTRACT_LOWER || state.throughBlock > latest) state = freshState();
      let cursor = state.throughBlock + 1;
      while (cursor <= latest) {
        const end = Math.min(latest, cursor + chunkSize - 1);
        const logs = await logsFor(cursor, end);
        logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
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
      console.warn("BurnFlip history refresh failed:", lastError);
      return state;
    }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  app.get("/api/burnflip/history/:wallet", async (req, res) => {
    await refresh(String(req.query.fresh || "") === "1");
    const wallet = normalizeWallet(req.params.wallet);
    if (!wallet) return res.status(400).json({ error: "INVALID_WALLET" });
    const player = state.players[wallet] || newPlayer(wallet);
    const limit = clampInteger(req.query.limit, 1, 250, 50);
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    return res.json({ status: "READY", indexedThroughBlock: state.throughBlock, player: publicPlayer(player, true, limit) });
  });

  app.get("/api/burnflip/leaderboard", async (req, res) => {
    await refresh(String(req.query.fresh || "") === "1");
    const sort = String(req.query.sort || "net-desc");
    const search = String(req.query.search || "").trim().toLowerCase();
    const minFlips = clampInteger(req.query.minFlips, 0, 1_000_000, 0);
    const offset = clampInteger(req.query.offset, 0, 1_000_000, 0);
    const limit = clampInteger(req.query.limit, 1, 100, 25);
    const rows = Object.values(state.players)
      .filter(player => player.flips >= minFlips && (!search || player.wallet.includes(search)))
      .sort(comparator(sort));
    const page = rows.slice(offset, offset + limit).map((player, index) => ({
      rank: offset + index + 1,
      ...publicPlayer(player, false)
    }));
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    return res.json({
      status: "READY",
      sort,
      totalPlayers: rows.length,
      totalSettlements: state.totalSettlements,
      indexedThroughBlock: state.throughBlock,
      updatedAt: state.updatedAt,
      players: page,
      hasMore: offset + limit < rows.length,
      error: lastError
    });
  });

  refresh(true);
  return { refresh, getStatus: () => ({ indexedThroughBlock: state.throughBlock, players: Object.keys(state.players).length, lastError }) };
}

function newPlayer(wallet) {
  return { wallet, flips: 0, wins: 0, losses: 0, totalBetRaw: "0", totalPayoutRaw: "0", netRaw: "0", biggestWinRaw: "0", biggestLossRaw: "0", lastPlayedAt: null, history: [] };
}
function publicPlayer(player, includeHistory, limit = 0) {
  return {
    wallet: player.wallet,
    flips: player.flips,
    wins: player.wins,
    losses: player.losses,
    winRate: player.flips ? player.wins / player.flips : 0,
    totalBetRaw: player.totalBetRaw,
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
    const left = BigInt(a[key]); const right = BigInt(b[key]);
    if (left === right) return b.flips - a.flips;
    return left > right ? direction : -direction;
  };
  switch (sort) {
    case "flips-desc": return (a, b) => b.flips - a.flips || b.wins - a.wins;
    case "net-asc": return byBig("netRaw", 1);
    case "volume-desc": return byBig("totalBetRaw", -1);
    case "wins-desc": return (a, b) => b.wins - a.wins || Number(BigInt(b.netRaw) - BigInt(a.netRaw));
    case "losses-desc": return (a, b) => b.losses - a.losses || Number(BigInt(a.netRaw) - BigInt(b.netRaw));
    case "winrate-desc": return (a, b) => (b.wins / Math.max(1, b.flips)) - (a.wins / Math.max(1, a.flips)) || b.flips - a.flips;
    case "biggest-win": return byBig("biggestWinRaw", -1);
    case "biggest-loss": return byBig("biggestLossRaw", -1);
    default: return byBig("netRaw", -1);
  }
}
function freshState() { return { version: 1, contract: CONTRACT_LOWER, deploymentBlock: DEPLOYMENT_BLOCK, throughBlock: DEPLOYMENT_BLOCK - 1, totalSettlements: 0, players: {}, seen: {}, updatedAt: null }; }
function loadState(file) { try { if (!file || !fs.existsSync(file)) return null; const state = JSON.parse(fs.readFileSync(file, "utf8")); return state?.contract === CONTRACT_LOWER ? state : null; } catch { return null; } }
function saveState(file, state) { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, file); } catch (error) { console.warn("BurnFlip history checkpoint failed:", safe(error)); } }
function normalizeWallet(value) { const wallet = String(value || "").toLowerCase(); return /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null; }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function clampInteger(value, min, max, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function safe(error) { return String(error?.message || error || "Unknown error").slice(0, 220); }

module.exports = { installBurnFlipHistoryIndex };
