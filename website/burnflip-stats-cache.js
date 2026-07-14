const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");

const BURNFLIP_ADDRESS = "0xd6B6E08fB04b2Ee76e6584f49c6adE75d7ad144e";
const BURNFLIP_ADDRESS_LOWER = BURNFLIP_ADDRESS.toLowerCase();
const DEPLOYMENT_BLOCK = 58_299_639;
const ABI = [
  "function totalBurnedByGame() view returns (uint256)",
  "function availableBankroll() view returns (uint256)",
  "function maxAcceptableBet() view returns (uint256)",
  "function nextBetId() view returns (uint256)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 choice,uint8 outcome,uint256 amount,uint256 payout,bool won,bytes32 entropyBlockHash,uint256 randomWord)"
];
const iface = new Interface(ABI);
const settledTopic = iface.getEvent("BetSettled").topicHash;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function decodeCall(name, raw) {
  return BigInt(iface.decodeFunctionResult(name, raw)[0]);
}

function installBurnFlipStatsCache(app, options) {
  const rpcRequest = options?.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("BurnFlip stats cache requires rpcRequest");

  const stateFile = String(options?.stateFile || process.env.BURNFLIP_STATS_FILE || "").trim();
  const cacheTtlMs = positiveInteger(process.env.BURNFLIP_STATS_CACHE_TTL_MS, 15_000);
  const firstLoadWaitMs = positiveInteger(process.env.BURNFLIP_STATS_FIRST_LOAD_WAIT_MS, 10_000);
  const logChunkSize = positiveInteger(process.env.BURNFLIP_STATS_LOG_CHUNK_SIZE, 5_000);
  const maxSplitDepth = positiveInteger(process.env.BURNFLIP_STATS_MAX_SPLIT_DEPTH, 20);
  let state = loadState(stateFile);
  let snapshot = state?.snapshot || null;
  let refreshPromise = null;
  let lastError = null;

  async function contractRead(name) {
    const data = iface.encodeFunctionData(name);
    const raw = await rpcRequest("eth_call", [{ to: BURNFLIP_ADDRESS, data }, "latest"]);
    return decodeCall(name, raw);
  }

  async function fetchSettlementLogs(fromBlock, toBlock, depth = 0) {
    if (fromBlock > toBlock) return [];
    try {
      const logs = await rpcRequest("eth_getLogs", [{
        address: BURNFLIP_ADDRESS,
        fromBlock: hexBlock(fromBlock),
        toBlock: hexBlock(toBlock),
        topics: [settledTopic]
      }]);
      if (!Array.isArray(logs)) throw new Error("Ronin returned invalid BurnFlip log data");
      return logs;
    } catch (error) {
      if (fromBlock >= toBlock || depth >= maxSplitDepth) throw error;
      const middle = Math.floor((fromBlock + toBlock) / 2);
      const left = await fetchSettlementLogs(fromBlock, middle, depth + 1);
      const right = await fetchSettlementLogs(middle + 1, toBlock, depth + 1);
      return left.concat(right);
    }
  }

  async function scanSettlements(fromBlock, toBlock, currentTotalWon) {
    let totalWon = currentTotalWon;
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const end = Math.min(toBlock, cursor + logChunkSize - 1);
      const logs = await fetchSettlementLogs(cursor, end);
      for (const log of logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "BetSettled" && Boolean(parsed.args.won)) {
            totalWon += BigInt(parsed.args.payout);
          }
        } catch {
          // Ignore malformed or unrelated logs.
        }
      }
      state.throughBlock = end;
      state.totalWonRaw = totalWon.toString();
      saveState(stateFile, state);
      cursor = end + 1;
    }
    return totalWon;
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const latestBlock = Number(BigInt(await rpcRequest("eth_blockNumber", [])));
      if (!Number.isSafeInteger(latestBlock) || latestBlock < DEPLOYMENT_BLOCK) {
        throw new Error("Ronin returned an invalid BurnFlip block height");
      }

      if (!state || state.version !== 1 || state.contract !== BURNFLIP_ADDRESS_LOWER ||
          !Number.isSafeInteger(Number(state.throughBlock)) || Number(state.throughBlock) < DEPLOYMENT_BLOCK - 1 ||
          Number(state.throughBlock) > latestBlock) {
        state = {
          version: 1,
          contract: BURNFLIP_ADDRESS_LOWER,
          deploymentBlock: DEPLOYMENT_BLOCK,
          throughBlock: DEPLOYMENT_BLOCK - 1,
          totalWonRaw: "0",
          snapshot: null
        };
      }

      // Read lightweight contract counters first. When there are no flips yet,
      // no historical event scan is necessary at all.
      const [burned, bankroll, maximum, nextBetId] = await Promise.all([
        contractRead("totalBurnedByGame"),
        contractRead("availableBankroll"),
        contractRead("maxAcceptableBet"),
        contractRead("nextBetId")
      ]);
      const totalFlips = nextBetId > 0n ? nextBetId - 1n : 0n;

      let totalWon = BigInt(state.totalWonRaw || "0");
      if (totalFlips === 0n) {
        totalWon = 0n;
        state.throughBlock = latestBlock;
        state.totalWonRaw = "0";
      } else if (Number(state.throughBlock) < latestBlock) {
        totalWon = await scanSettlements(Number(state.throughBlock) + 1, latestBlock, totalWon);
      }

      snapshot = {
        contractAddress: BURNFLIP_ADDRESS,
        deploymentBlock: DEPLOYMENT_BLOCK,
        indexedThroughBlock: Number(state.throughBlock),
        latestBlock,
        totalBurnedRaw: burned.toString(),
        availableBankrollRaw: bankroll.toString(),
        maximumBetRaw: maximum.toString(),
        totalFlips: totalFlips.toString(),
        totalWonRaw: totalWon.toString(),
        updatedAt: new Date().toISOString(),
        generatedAt: Date.now()
      };
      state.snapshot = snapshot;
      state.totalWonRaw = totalWon.toString();
      saveState(stateFile, state);
      lastError = null;
      return snapshot;
    })().catch(error => {
      lastError = error;
      console.warn("BurnFlip stats refresh failed:", safeMessage(error));
      return snapshot;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  app.get("/api/burnflip-stats", async (req, res) => {
    const force = String(req.query.fresh || "") === "1";
    const stale = !snapshot || Date.now() - Number(snapshot.generatedAt || 0) >= cacheTtlMs;
    if (force || stale) {
      const work = refresh();
      if (!snapshot) {
        await Promise.race([
          work,
          new Promise(resolve => setTimeout(resolve, firstLoadWaitMs))
        ]);
      }
    }

    if (!snapshot) {
      res.set("Cache-Control", "no-store");
      res.set("Retry-After", "2");
      return res.status(202).json({
        status: "WARMING",
        message: lastError
          ? safeMessage(lastError)
          : `BurnFlip statistics are still warming after ${Math.round(firstLoadWaitMs / 1000)} seconds.`
      });
    }

    res.set("Cache-Control", force
      ? "no-store"
      : "public, max-age=5, stale-while-revalidate=30");
    return res.json({
      status: refreshPromise ? "REFRESHING" : "READY",
      ...snapshot
    });
  });

  // Start immediately so the cache is usually ready before the first visitor arrives.
  refresh();

  return {
    getStatus: () => ({
      ready: Boolean(snapshot),
      updating: Boolean(refreshPromise),
      indexedThroughBlock: state?.throughBlock ?? null,
      stateFile: stateFile || null,
      lastError: lastError ? safeMessage(lastError) : null
    })
  };
}

function loadState(stateFile) {
  if (!stateFile) return null;
  try {
    if (!fs.existsSync(stateFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (parsed?.version !== 1 || parsed?.contract !== BURNFLIP_ADDRESS_LOWER) return null;
    console.log(`Loaded BurnFlip stats checkpoint through block ${parsed.throughBlock}.`);
    return parsed;
  } catch (error) {
    console.warn("Ignoring invalid BurnFlip stats checkpoint:", safeMessage(error));
    return null;
  }
}

function saveState(stateFile, state) {
  if (!stateFile) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, stateFile);
  } catch (error) {
    console.warn("BurnFlip stats checkpoint could not be saved:", safeMessage(error));
  }
}

function safeMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 220);
}

module.exports = { installBurnFlipStatsCache };
