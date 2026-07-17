const fs = require("fs");
const path = require("path");

const MATT = String(process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d");
const MATT_LOWER = MATT.toLowerCase();
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const DEAD_TOPIC = `0x${"0".repeat(24)}000000000000000000000000000000000000dead`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function installBurnLeaderboardIndex(app, options = {}) {
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("Burn leaderboard requires rpcRequest");
  const stateFile = String(options.stateFile || process.env.BURN_LEADERBOARD_FILE || "").trim();
  const chunkSize = positiveInteger(process.env.BURN_LEADERBOARD_CHUNK_SIZE, 4_000);
  const refreshMs = positiveInteger(process.env.BURN_LEADERBOARD_REFRESH_MS, 20_000);
  let state = loadState(stateFile) || freshState();
  let refreshPromise = null;
  let lastRefreshAt = 0;
  let lastError = null;

  async function discoverDeploymentBlock(latest) {
    if (state.deploymentBlock != null) return state.deploymentBlock;
    let low = 0;
    let high = latest;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const code = await rpcRequest("eth_getCode", [MATT, hexBlock(middle)]);
      if (code && code !== "0x") high = middle;
      else low = middle + 1;
    }
    state.deploymentBlock = low;
    state.throughBlock = low - 1;
    saveState(stateFile, state);
    return low;
  }

  async function logsFor(fromBlock, toBlock, destinationTopic, depth = 0) {
    if (fromBlock > toBlock) return [];
    try {
      return await rpcRequest("eth_getLogs", [{
        address: MATT,
        fromBlock: hexBlock(fromBlock),
        toBlock: hexBlock(toBlock),
        topics: [TRANSFER_TOPIC, null, destinationTopic]
      }]);
    } catch (error) {
      if (fromBlock >= toBlock || depth >= 20) throw error;
      const middle = Math.floor((fromBlock + toBlock) / 2);
      return (await logsFor(fromBlock, middle, destinationTopic, depth + 1))
        .concat(await logsFor(middle + 1, toBlock, destinationTopic, depth + 1));
    }
  }

  function ingest(log) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (state.seen[key]) return;
    const wallet = topicAddress(log.topics?.[1]);
    const amount = BigInt(log.data || "0x0");
    if (amount <= 0n) return;
    const player = state.players[wallet] || { wallet, burns: 0, burnedRaw: "0", lastBurnBlock: null };
    player.burns += 1;
    player.burnedRaw = (BigInt(player.burnedRaw) + amount).toString();
    player.lastBurnBlock = Number(BigInt(log.blockNumber));
    state.players[wallet] = player;
    state.seen[key] = 1;
    state.totalBurnEvents += 1;
    state.totalBurnedRaw = (BigInt(state.totalBurnedRaw) + amount).toString();
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && Date.now() - lastRefreshAt < refreshMs) return state;
    refreshPromise = (async () => {
      const latest = Number(BigInt(await rpcRequest("eth_blockNumber", [])));
      if (state.version !== 1 || state.contract !== MATT_LOWER || state.throughBlock > latest) state = freshState();
      await discoverDeploymentBlock(latest);
      let cursor = state.throughBlock + 1;
      while (cursor <= latest) {
        const end = Math.min(latest, cursor + chunkSize - 1);
        const [zeroLogs, deadLogs] = await Promise.all([
          logsFor(cursor, end, ZERO_TOPIC),
          logsFor(cursor, end, DEAD_TOPIC)
        ]);
        const logs = zeroLogs.concat(deadLogs);
        logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
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
      console.warn("Burn leaderboard refresh failed:", lastError);
      return state;
    }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  app.get("/api/burn/leaderboard", async (req, res) => {
    await refresh(String(req.query.fresh || "") === "1");
    const search = String(req.query.search || "").trim().toLowerCase();
    const offset = clampInteger(req.query.offset, 0, 1_000_000, 0);
    const limit = clampInteger(req.query.limit, 1, 100, 25);
    const rows = Object.values(state.players)
      .filter(player => !search || player.wallet.includes(search))
      .sort((a, b) => compareBigDesc(a.burnedRaw, b.burnedRaw) || b.burns - a.burns);
    const players = rows.slice(offset, offset + limit).map((player, index) => ({
      rank: offset + index + 1,
      wallet: player.wallet,
      burns: player.burns,
      burnedRaw: player.burnedRaw,
      lastBurnBlock: player.lastBurnBlock
    }));
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    res.json({
      status: state.deploymentBlock == null ? "INDEXING" : "READY",
      totalPlayers: rows.length,
      totalBurnEvents: state.totalBurnEvents,
      totalBurnedRaw: state.totalBurnedRaw,
      deploymentBlock: state.deploymentBlock,
      indexedThroughBlock: state.throughBlock,
      updatedAt: state.updatedAt,
      players,
      hasMore: offset + limit < rows.length,
      error: lastError
    });
  });

  refresh(true);
  return { refresh, getStatus: () => ({ indexedThroughBlock: state.throughBlock, players: Object.keys(state.players).length, lastError }) };
}

function freshState() {
  return { version: 1, contract: MATT_LOWER, deploymentBlock: null, throughBlock: -1, totalBurnEvents: 0, totalBurnedRaw: "0", players: {}, seen: {}, updatedAt: null };
}
function loadState(file) { try { if (!file || !fs.existsSync(file)) return null; const state = JSON.parse(fs.readFileSync(file, "utf8")); return state?.contract === MATT_LOWER ? state : null; } catch { return null; } }
function saveState(file, state) { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, file); } catch (error) { console.warn("Burn leaderboard checkpoint failed:", safe(error)); } }
function topicAddress(topic) { if (!/^0x[0-9a-f]{64}$/i.test(String(topic || ""))) throw new Error("Invalid address topic"); return `0x${topic.slice(-40)}`.toLowerCase(); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function compareBigDesc(left, right) { left = BigInt(left); right = BigInt(right); return left === right ? 0 : left > right ? -1 : 1; }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function clampInteger(value, min, max, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function safe(error) { return String(error?.message || error || "Unknown error").slice(0, 220); }

module.exports = { installBurnLeaderboardIndex };
