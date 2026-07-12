const express = require("express");
const path = require("path");

const app = express();
const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;

const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const MATT_ADDRESS_LOWER = MATT_ADDRESS.toLowerCase();
const MATT_TOTAL_SUPPLY = 10_000_000_000n * 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RONIN_RPC_URL = process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";

const HOLDER_CACHE_TTL_MS = positiveInteger(process.env.HOLDER_CACHE_TTL_MS, 60_000);
const HOLDER_LOG_CHUNK_SIZE = positiveInteger(process.env.HOLDER_LOG_CHUNK_SIZE, 5_000);
const HOLDER_DISCOVERY_CHUNK_SIZE = positiveInteger(process.env.HOLDER_DISCOVERY_CHUNK_SIZE, 500_000);
const HOLDER_CONFIRMATIONS = nonNegativeInteger(process.env.HOLDER_CONFIRMATIONS, 12);
const HOLDER_API_WAIT_MS = positiveInteger(process.env.HOLDER_API_WAIT_MS, 7_000);
const RPC_TIMEOUT_MS = positiveInteger(process.env.RPC_TIMEOUT_MS, 20_000);
const MAX_SPLIT_DEPTH = positiveInteger(process.env.HOLDER_MAX_SPLIT_DEPTH, 20);

const KNOWN_HOLDERS = new Map([
  ["0xf79913cb83cc9cabd95d0ba9250103fbb939f984", "MATT Treasury"],
  ["0xa517e05e96728e80284f2ae157ddf309449d7ce8", "Katana MATT/RON Pool"],
  [MATT_ADDRESS_LOWER, "MATT Contract"],
  ["0x000000000000000000000000000000000000dead", "Burn Address"]
]);

let rpcRequestId = 0;
let holderIndex = null;
let holderSnapshot = null;
let holderRefreshPromise = null;
let holderLastError = null;
let holderProgress = {
  phase: "idle",
  deploymentBlock: null,
  indexedBlock: null,
  targetBlock: null,
  startedAt: null,
  updatedAt: null
};

app.disable("x-powered-by");
app.use(express.static(publicDir, { extensions: ["html"], maxAge: "1h" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    holderIndex: {
      ready: Boolean(holderSnapshot),
      updating: Boolean(holderRefreshPromise),
      indexedBlock: holderIndex?.lastBlock ?? null,
      targetBlock: holderProgress.targetBlock,
      phase: holderProgress.phase,
      lastError: holderLastError ? safeErrorMessage(holderLastError) : null
    }
  });
});

app.get("/api/token", (_req, res) => res.sendFile(path.join(publicDir, "token.json")));

app.get("/api/holders", async (req, res) => {
  const query = stringQuery(req.query.q).trim().toLowerCase().slice(0, 100);
  const limit = boundedInteger(req.query.limit, 50, 1, 100);
  const offset = boundedInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  try {
    let snapshot = holderSnapshot;
    const stale = !snapshot || Date.now() - snapshot.generatedAt >= HOLDER_CACHE_TTL_MS;
    if (stale) startHolderRefresh();

    if (!snapshot && holderRefreshPromise) {
      await Promise.race([holderRefreshPromise, delay(HOLDER_API_WAIT_MS)]);
      snapshot = holderSnapshot;
    }

    if (!snapshot) {
      res.set("Cache-Control", "no-store");
      res.set("Retry-After", "3");
      return res.status(202).json({
        status: "INDEXING",
        message: holderLastError
          ? `The holder index is retrying after an RPC error: ${safeErrorMessage(holderLastError)}`
          : progressMessage(),
        progress: publicProgress(),
        token: tokenPayload(),
        summary: emptySummary(),
        pagination: { offset, limit, returned: 0, hasMore: false },
        holders: []
      });
    }

    const matchingHolders = query
      ? snapshot.holders.filter(holder => holderSearchText(holder).includes(query))
      : snapshot.holders;
    const page = matchingHolders.slice(offset, offset + limit);

    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    return res.json({
      status: holderRefreshPromise ? "REFRESHING" : "READY",
      progress: publicProgress(),
      token: tokenPayload(),
      summary: {
        holderCount: snapshot.holderCount,
        matchingCount: matchingHolders.length,
        totalHeldRaw: snapshot.totalHeldRaw,
        burnedRaw: snapshot.burnedRaw,
        indexedBlock: snapshot.indexedBlock,
        deploymentBlock: snapshot.deploymentBlock,
        transferCount: snapshot.transferCount,
        updatedAt: snapshot.updatedAt
      },
      pagination: {
        offset,
        limit,
        returned: page.length,
        hasMore: offset + page.length < matchingHolders.length
      },
      holders: page
    });
  } catch (error) {
    holderLastError = error;
    console.error("MATT holder API error:", error);
    res.set("Retry-After", "5");
    return res.status(503).json({
      error: "HOLDER_INDEX_UNAVAILABLE",
      message: `The holder index is temporarily unavailable: ${safeErrorMessage(error)}`,
      progress: publicProgress()
    });
  }
});

app.get(["/hub", "/hub/"], (_req, res) => res.sendFile(path.join(publicDir, "hub.html")));

app.get("/{*splat}", (req, res) => {
  if (!req.accepts("html")) return res.status(404).json({ error: "Not found" });
  return res.sendFile(path.join(publicDir, "index.html"));
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(stringQuery(value), 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function stringQuery(value) {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value == null ? "" : String(value);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function safeErrorMessage(error) {
  const message = String(error?.message || error || "Unknown error");
  return message.replace(RONIN_RPC_URL, "configured Ronin RPC").slice(0, 240);
}

function tokenPayload() {
  return {
    address: MATT_ADDRESS,
    symbol: "MATT",
    decimals: 18,
    totalSupplyRaw: MATT_TOTAL_SUPPLY.toString()
  };
}

function emptySummary() {
  return {
    holderCount: null,
    matchingCount: 0,
    totalHeldRaw: null,
    burnedRaw: null,
    indexedBlock: holderIndex?.lastBlock ?? null,
    deploymentBlock: holderIndex?.deploymentBlock ?? null,
    transferCount: holderIndex?.transferCount ?? 0,
    updatedAt: null
  };
}

function publicProgress() {
  return {
    phase: holderProgress.phase,
    deploymentBlock: holderProgress.deploymentBlock,
    indexedBlock: holderProgress.indexedBlock,
    targetBlock: holderProgress.targetBlock,
    startedAt: holderProgress.startedAt,
    updatedAt: holderProgress.updatedAt
  };
}

function progressMessage() {
  if (holderProgress.phase === "discovering") return "Finding the MATT deployment block on Ronin…";
  if (holderProgress.phase === "indexing") {
    const current = holderProgress.indexedBlock;
    const target = holderProgress.targetBlock;
    return current == null || target == null
      ? "Building the public MATT holder directory…"
      : `Building the public MATT holder directory through block ${Number(target).toLocaleString()}…`;
  }
  return "Preparing the public MATT holder directory…";
}

function updateProgress(patch) {
  holderProgress = { ...holderProgress, ...patch, updatedAt: new Date().toISOString() };
}

function holderSearchText(holder) {
  return `${holder.address} ${holder.label || ""} ${holder.level}`.toLowerCase();
}

function blockHex(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}

function parseHexNumber(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Invalid hexadecimal number: ${value}`);
  }
  return Number.parseInt(value, 16);
}

function topicAddress(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-f]{64}$/i.test(topic)) {
    throw new Error("Invalid indexed address topic");
  }
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function normalizeAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`Invalid address: ${address}`);
  return normalized;
}

async function rpcRequest(method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(RONIN_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcRequestId, method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Ronin RPC returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || "Ronin RPC request failed");
    return payload.result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Ronin RPC timed out during ${method}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function latestBlockNumber() {
  return parseHexNumber(await rpcRequest("eth_blockNumber", []));
}

async function fetchLogsRange(fromBlock, toBlock, topics, depth = 0) {
  if (fromBlock > toBlock) return [];
  try {
    const result = await rpcRequest("eth_getLogs", [{
      address: MATT_ADDRESS,
      fromBlock: blockHex(fromBlock),
      toBlock: blockHex(toBlock),
      topics
    }]);
    if (!Array.isArray(result)) throw new Error("Ronin RPC returned invalid log data");
    return result;
  } catch (error) {
    if (fromBlock >= toBlock || depth >= MAX_SPLIT_DEPTH) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    const left = await fetchLogsRange(fromBlock, middle, topics, depth + 1);
    const right = await fetchLogsRange(middle + 1, toBlock, topics, depth + 1);
    return left.concat(right);
  }
}

async function findDeploymentBlockByMintLog(latestBlock) {
  const configured = Number.parseInt(process.env.MATT_DEPLOYMENT_BLOCK || "", 10);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  if (holderIndex?.deploymentBlock != null) return holderIndex.deploymentBlock;

  updateProgress({
    phase: "discovering",
    deploymentBlock: null,
    indexedBlock: null,
    targetBlock: latestBlock
  });

  let toBlock = latestBlock;
  while (toBlock >= 0) {
    const fromBlock = Math.max(0, toBlock - HOLDER_DISCOVERY_CHUNK_SIZE + 1);
    const logs = await fetchLogsRange(fromBlock, toBlock, [TRANSFER_TOPIC, ZERO_TOPIC]);
    if (logs.length) {
      return Math.min(...logs.map(log => parseHexNumber(log.blockNumber)));
    }
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }
  throw new Error("Could not locate the MATT mint event. Add MATT_DEPLOYMENT_BLOCK in Render.");
}

function adjustBalance(balances, address, delta) {
  const normalized = normalizeAddress(address);
  const next = (balances.get(normalized) || 0n) + delta;
  if (next < 0n) throw new Error(`Negative indexed balance for ${normalized}`);
  if (next === 0n) balances.delete(normalized);
  else balances.set(normalized, next);
}

function applyTransferLog(balances, log) {
  if (!Array.isArray(log?.topics) || log.topics.length < 3) throw new Error("Malformed Transfer log");
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  const amount = BigInt(log.data);
  if (from !== ZERO_ADDRESS) adjustBalance(balances, from, -amount);
  if (to !== ZERO_ADDRESS) adjustBalance(balances, to, amount);
}

function levelFromBalance(balanceRaw) {
  const tokens = balanceRaw / 10n ** 18n;
  if (tokens >= 100_000_000n) return "Legendary Matt";
  if (tokens >= 10_000_000n) return "Gold Matt";
  if (tokens >= 1_000_000n) return "Certified Matt";
  if (tokens >= 100_000n) return "Big Matt";
  return "MATT Holder";
}

function percentOfSupply(balanceRaw) {
  const scaled = balanceRaw * 1_000_000n / MATT_TOTAL_SUPPLY;
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function buildSnapshot(index) {
  const holders = [];
  let totalHeld = 0n;
  for (const [address, balanceRaw] of index.balances) {
    if (balanceRaw <= 0n || address === ZERO_ADDRESS) continue;
    totalHeld += balanceRaw;
    holders.push({ address, balanceRaw });
  }
  holders.sort((left, right) => {
    if (left.balanceRaw === right.balanceRaw) return left.address.localeCompare(right.address);
    return left.balanceRaw > right.balanceRaw ? -1 : 1;
  });
  const serialized = holders.map((holder, indexValue) => ({
    rank: indexValue + 1,
    address: holder.address,
    label: KNOWN_HOLDERS.get(holder.address) || null,
    level: levelFromBalance(holder.balanceRaw),
    balanceRaw: holder.balanceRaw.toString(),
    sharePercent: percentOfSupply(holder.balanceRaw)
  }));
  const burned = MATT_TOTAL_SUPPLY > totalHeld ? MATT_TOTAL_SUPPLY - totalHeld : 0n;
  return {
    holderCount: serialized.length,
    totalHeldRaw: totalHeld.toString(),
    burnedRaw: burned.toString(),
    indexedBlock: index.lastBlock,
    deploymentBlock: index.deploymentBlock,
    transferCount: index.transferCount,
    updatedAt: new Date().toISOString(),
    generatedAt: Date.now(),
    holders: serialized
  };
}

async function syncHolderIndex() {
  const networkLatest = await latestBlockNumber();
  const confirmedLatest = Math.max(0, networkLatest - HOLDER_CONFIRMATIONS);

  if (!holderIndex) {
    const deploymentBlock = await findDeploymentBlockByMintLog(confirmedLatest);
    holderIndex = {
      deploymentBlock,
      lastBlock: deploymentBlock - 1,
      transferCount: 0,
      balances: new Map()
    };
  }

  updateProgress({
    phase: "indexing",
    deploymentBlock: holderIndex.deploymentBlock,
    indexedBlock: holderIndex.lastBlock,
    targetBlock: confirmedLatest
  });

  let cursor = holderIndex.lastBlock + 1;
  while (cursor <= confirmedLatest) {
    const endBlock = Math.min(confirmedLatest, cursor + HOLDER_LOG_CHUNK_SIZE - 1);
    const logs = await fetchLogsRange(cursor, endBlock, [TRANSFER_TOPIC]);
    logs.sort((left, right) => {
      const blockDifference = parseHexNumber(left.blockNumber) - parseHexNumber(right.blockNumber);
      return blockDifference || parseHexNumber(left.logIndex) - parseHexNumber(right.logIndex);
    });
    for (const log of logs) applyTransferLog(holderIndex.balances, log);
    holderIndex.transferCount += logs.length;
    holderIndex.lastBlock = endBlock;
    cursor = endBlock + 1;
    updateProgress({ indexedBlock: holderIndex.lastBlock });
  }

  holderSnapshot = buildSnapshot(holderIndex);
  holderLastError = null;
  updateProgress({
    phase: "ready",
    deploymentBlock: holderIndex.deploymentBlock,
    indexedBlock: holderIndex.lastBlock,
    targetBlock: confirmedLatest
  });
  return holderSnapshot;
}

function startHolderRefresh() {
  if (holderRefreshPromise) return holderRefreshPromise;
  holderLastError = null;
  updateProgress({ startedAt: new Date().toISOString() });
  holderRefreshPromise = syncHolderIndex()
    .catch(error => {
      holderLastError = error;
      updateProgress({ phase: "error" });
      console.warn("MATT holder index refresh failed:", safeErrorMessage(error));
      throw error;
    })
    .finally(() => {
      holderRefreshPromise = null;
    });
  holderRefreshPromise.catch(() => {});
  return holderRefreshPromise;
}

if (require.main === module) {
  app.listen(port, () => {
    console.log(`MATT website listening on ${port}`);
    const warmup = setTimeout(() => startHolderRefresh(), 500);
    warmup.unref();
  });
}

module.exports = {
  app,
  applyTransferLog,
  buildSnapshot,
  levelFromBalance,
  percentOfSupply,
  topicAddress
};
