const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const VAULT = String(process.env.BLACKJACK_VAULT_ADDRESS || "0x715C79bcb0AA4DBccc79AfE2C19176B81193F842");
const VAULT_LOWER = VAULT.toLowerCase();
const ABI = [
  "event WagerSettled(bytes32 indexed wagerId,address indexed player,uint8 outcome,uint256 returnedPrincipal,uint256 profit,uint256 burned)"
];
const iface = new Interface(ABI);
const topic = iface.getEvent("WagerSettled").topicHash;

function installBlackjackHistoryIndex(app, options = {}) {
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("Blackjack history requires rpcRequest");
  const stateFile = String(options.stateFile || process.env.BLACKJACK_HISTORY_FILE || "").trim();
  const chunkSize = positiveInteger(process.env.BLACKJACK_HISTORY_CHUNK_SIZE, 4_000);
  const refreshMs = positiveInteger(process.env.BLACKJACK_HISTORY_REFRESH_MS, 20_000);
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
      const code = await rpcRequest("eth_getCode", [VAULT, hexBlock(middle)]);
      if (code && code !== "0x") high = middle;
      else low = middle + 1;
    }
    state.deploymentBlock = low;
    state.throughBlock = low - 1;
    saveState(stateFile, state);
    return low;
  }

  async function logsFor(fromBlock, toBlock, depth = 0) {
    if (fromBlock > toBlock) return [];
    try {
      return await rpcRequest("eth_getLogs", [{
        address: VAULT,
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

  function ingest(log) {
    const parsed = iface.parseLog(log);
    if (!parsed || parsed.name !== "WagerSettled") return;
    const wagerId = String(parsed.args.wagerId).toLowerCase();
    if (state.seen[wagerId]) return;
    const wallet = String(parsed.args.player).toLowerCase();
    const outcome = Number(parsed.args.outcome);
    const burned = BigInt(parsed.args.burned);
    const player = state.players[wallet] || newPlayer(wallet);
    player.hands += 1;
    if (outcome === 0) player.losses += 1;
    else if (outcome === 1) player.surrenders += 1;
    else if (outcome === 2) player.pushes += 1;
    else if (outcome === 3) player.wins += 1;
    else if (outcome === 4) { player.wins += 1; player.blackjacks += 1; }
    player.burnedRaw = (BigInt(player.burnedRaw) + burned).toString();
    player.lastPlayedBlock = Number(BigInt(log.blockNumber));
    state.players[wallet] = player;
    state.seen[wagerId] = 1;
    state.totalHands += 1;
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    if (!force && Date.now() - lastRefreshAt < refreshMs) return state;
    refreshPromise = (async () => {
      const latest = Number(BigInt(await rpcRequest("eth_blockNumber", [])));
      if (state.version !== 1 || state.vault !== VAULT_LOWER || state.throughBlock > latest) state = freshState();
      await discoverDeploymentBlock(latest);
      let cursor = state.throughBlock + 1;
      while (cursor <= latest) {
        const end = Math.min(latest, cursor + chunkSize - 1);
        const logs = await logsFor(cursor, end);
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
      console.warn("Blackjack history refresh failed:", lastError);
      return state;
    }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  app.get("/api/blackjack/leaderboard", async (req, res) => {
    await refresh(String(req.query.fresh || "") === "1");
    const sort = String(req.query.sort || "hands-desc");
    const search = String(req.query.search || "").trim().toLowerCase();
    const offset = clampInteger(req.query.offset, 0, 1_000_000, 0);
    const limit = clampInteger(req.query.limit, 1, 100, 25);
    const rows = Object.values(state.players)
      .filter(player => !search || player.wallet.includes(search))
      .sort(comparator(sort));
    const players = rows.slice(offset, offset + limit).map((player, index) => ({ rank: offset + index + 1, ...player }));
    res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    res.json({
      status: state.deploymentBlock == null ? "INDEXING" : "READY",
      sort,
      totalPlayers: rows.length,
      totalHands: state.totalHands,
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

function newPlayer(wallet) { return { wallet, hands: 0, wins: 0, losses: 0, pushes: 0, surrenders: 0, blackjacks: 0, burnedRaw: "0", lastPlayedBlock: null }; }
function comparator(sort) {
  if (sort === "wins-desc") return (a, b) => b.wins - a.wins || b.hands - a.hands;
  if (sort === "blackjacks-desc") return (a, b) => b.blackjacks - a.blackjacks || b.hands - a.hands;
  if (sort === "burned-desc") return (a, b) => compareBigDesc(a.burnedRaw, b.burnedRaw) || b.hands - a.hands;
  return (a, b) => b.hands - a.hands || b.wins - a.wins;
}
function freshState() { return { version: 1, vault: VAULT_LOWER, deploymentBlock: null, throughBlock: -1, totalHands: 0, players: {}, seen: {}, updatedAt: null }; }
function loadState(file) { try { if (!file || !fs.existsSync(file)) return null; const state = JSON.parse(fs.readFileSync(file, "utf8")); return state?.vault === VAULT_LOWER ? state : null; } catch { return null; } }
function saveState(file, state) { if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, file); } catch (error) { console.warn("Blackjack history checkpoint failed:", safe(error)); } }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function compareBigDesc(left, right) { left = BigInt(left); right = BigInt(right); return left === right ? 0 : left > right ? -1 : 1; }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function clampInteger(value, min, max, fallback) { const parsed = Number.parseInt(value, 10); return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function safe(error) { return String(error?.message || error || "Unknown error").slice(0, 220); }

module.exports = { installBlackjackHistoryIndex };
