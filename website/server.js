const express = require("express");
const fs = require("fs");
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
const HOLDER_LOG_CHUNK_SIZE = positiveInteger(process.env.HOLDER_LOG_CHUNK_SIZE, 10);
const HOLDER_DISCOVERY_CHUNK_SIZE = positiveInteger(process.env.HOLDER_DISCOVERY_CHUNK_SIZE, 10_000);
const HOLDER_CONFIRMATIONS = nonNegativeInteger(process.env.HOLDER_CONFIRMATIONS, 12);
const HOLDER_API_WAIT_MS = positiveInteger(process.env.HOLDER_API_WAIT_MS, 1_500);
const HOLDER_AUTO_RETRY_MS = positiveInteger(process.env.HOLDER_AUTO_RETRY_MS, 15_000);
const HOLDER_CHECKPOINT_EVERY_CHUNKS = positiveInteger(process.env.HOLDER_CHECKPOINT_EVERY_CHUNKS, 25);
const HOLDER_STATE_FILE = process.env.HOLDER_STATE_FILE || path.join(__dirname, ".holder-index-cache.json");
const RPC_TIMEOUT_MS = positiveInteger(process.env.RPC_TIMEOUT_MS, 20_000);
const RPC_MAX_RETRIES = nonNegativeInteger(process.env.RPC_MAX_RETRIES, 12);
const RPC_BACKOFF_BASE_MS = positiveInteger(process.env.RPC_BACKOFF_BASE_MS, 1_000);
const RPC_BACKOFF_MAX_MS = positiveInteger(process.env.RPC_BACKOFF_MAX_MS, 60_000);
const RPC_MIN_INTERVAL_MS = nonNegativeInteger(process.env.RPC_MIN_INTERVAL_MS, 500);
const RPC_JITTER_MS = nonNegativeInteger(process.env.RPC_JITTER_MS, 250);
const MAX_SPLIT_DEPTH = positiveInteger(process.env.HOLDER_MAX_SPLIT_DEPTH, 20);

const KNOWN_HOLDERS = new Map([
  ["0xf79913cb83cc9cabd95d0ba9250103fbb939f984", "MATT Treasury"],
  ["0xa517e05e96728e80284f2ae157ddf309449d7ce8", "Katana MATT/RON Pool"],
  [MATT_ADDRESS_LOWER, "MATT Contract"],
  ["0x000000000000000000000000000000000000dead", "Burn Address"]
]);

let rpcRequestId = 0;
let rpcQueue = Promise.resolve();
let nextRpcRequestAt = 0;
let holderIndex = loadHolderCheckpoint();
let holderSnapshot = null;
let holderRefreshPromise = null;
let holderRetryTimer = null;
let holderLastError = null;
let checkpointWarningShown = false;
let holderProgress = {
  phase: holderIndex ? "resuming" : "idle",
  deploymentBlock: holderIndex?.deploymentBlock ?? null,
  indexedBlock: holderIndex?.lastBlock ?? null,
  targetBlock: null,
  startedAt: null,
  updatedAt: null,
  retryAttempt: 0,
  nextRetryAt: null,
  lastRateLimitAt: null
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
      retryAttempt: holderProgress.retryAttempt,
      nextRetryAt: holderProgress.nextRetryAt,
      lastRateLimitAt: holderProgress.lastRateLimitAt,
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
        message: progressMessage(),
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
    console.error("MATT holder API error:", safeErrorMessage(error));
    scheduleHolderRefresh(HOLDER_AUTO_RETRY_MS);
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
    updatedAt: holderProgress.updatedAt,
    retryAttempt: holderProgress.retryAttempt,
    nextRetryAt: holderProgress.nextRetryAt,
    lastRateLimitAt: holderProgress.lastRateLimitAt
  };
}

function progressMessage() {
  const current = holderProgress.indexedBlock;
  const target = holderProgress.targetBlock;
  if (holderProgress.phase === "discovering") return "Finding the MATT deployment block on Ronin…";
  if (holderProgress.phase === "rate_limited") {
    return holderProgress.nextRetryAt
      ? `Alchemy rate limit reached. Indexing resumes automatically at ${new Date(holderProgress.nextRetryAt).toLocaleTimeString()}.`
      : "Alchemy rate limit reached. Indexing will resume automatically.";
  }
  if (holderProgress.phase === "retrying") return "The Ronin RPC is temporarily unavailable. Retrying automatically…";
  if (holderProgress.phase === "waiting_retry") return "The holder index paused after an RPC error and will resume automatically…";
  if (holderProgress.phase === "resuming") return "Resuming the saved MATT holder index…";
  if (holderProgress.phase === "indexing") {
    return current == null || target == null
      ? "Building the public MATT holder directory…"
      : `Indexed through block ${Number(current).toLocaleString()} of ${Number(target).toLocaleString()}.`;
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

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function isRateLimitError(error) {
  return error?.status === 429 || /rate limit|capacity|too many requests|compute units/i.test(String(error?.message || ""));
}

function isRetryableRpcError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "").toLowerCase();
  return isRateLimitError(error) || status === 408 || status === 425 || status >= 500 ||
    error?.name === "AbortError" || /timeout|timed out|fetch failed|econnreset|enotfound|socket hang up|temporarily unavailable/.test(message);
}

function retryDelayMs(error, attempt) {
  const exponential = Math.min(RPC_BACKOFF_MAX_MS, RPC_BACKOFF_BASE_MS * (2 ** attempt));
  const jitter = RPC_JITTER_MS ? Math.floor(Math.random() * (RPC_JITTER_MS + 1)) : 0;
  return Math.max(Number(error?.retryAfterMs || 0), exponential + jitter);
}

async function reserveRpcSlot() {
  const queued = rpcQueue.then(async () => {
    const waitMs = Math.max(0, nextRpcRequestAt - Date.now());
    if (waitMs) await delay(waitMs);
    nextRpcRequestAt = Date.now() + RPC_MIN_INTERVAL_MS;
  });
  rpcQueue = queued.catch(() => {});
  return queued;
}

async function rpcRequestOnce(method, params) {
  await reserveRpcSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(RONIN_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcRequestId, method, params }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(`Ronin RPC returned HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      throw error;
    }

    const payload = await response.json();
    if (payload.error) {
      const error = new Error(payload.error.message || "Ronin RPC request failed");
      error.code = payload.error.code;
      if (/rate limit|capacity|too many requests|compute units/i.test(error.message)) error.status = 429;
      throw error;
    }
    return payload.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Ronin RPC timed out during ${method}`);
      timeoutError.name = "AbortError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcRequest(method, params) {
  const previousPhase = holderProgress.phase;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await rpcRequestOnce(method, params);
      if (["rate_limited", "retrying"].includes(holderProgress.phase)) {
        updateProgress({
          phase: previousPhase === "ready" ? "indexing" : previousPhase,
          retryAttempt: 0,
          nextRetryAt: null
        });
      }
      return result;
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt >= RPC_MAX_RETRIES) throw error;
      const waitMs = retryDelayMs(error, attempt);
      const rateLimited = isRateLimitError(error);
      updateProgress({
        phase: rateLimited ? "rate_limited" : "retrying",
        retryAttempt: attempt + 1,
        nextRetryAt: new Date(Date.now() + waitMs).toISOString(),
        lastRateLimitAt: rateLimited ? new Date().toISOString() : holderProgress.lastRateLimitAt
      });
      console.warn(`${rateLimited ? "Alchemy rate limit" : "Ronin RPC retry"} during ${method}; attempt ${attempt + 1}/${RPC_MAX_RETRIES}, waiting ${waitMs}ms.`);
      await delay(waitMs);
    }
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
    if (isRetryableRpcError(error) || fromBlock >= toBlock || depth >= MAX_SPLIT_DEPTH) throw error;
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
    if (logs.length) return Math.min(...logs.map(log => parseHexNumber(log.blockNumber)));
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

function checkpointPayload(index) {
  return {
    version: 1,
    token: MATT_ADDRESS_LOWER,
    deploymentBlock: index.deploymentBlock,
    lastBlock: index.lastBlock,
    transferCount: index.transferCount,
    balances: [...index.balances].map(([address, balance]) => [address, balance.toString()])
  };
}

function loadHolderCheckpoint() {
  try {
    if (!fs.existsSync(HOLDER_STATE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(HOLDER_STATE_FILE, "utf8"));
    if (parsed?.version !== 1 || parsed?.token !== MATT_ADDRESS_LOWER) return null;
    const configuredDeploymentBlock = Number.parseInt(process.env.MATT_DEPLOYMENT_BLOCK || "", 10);
    if (Number.isSafeInteger(configuredDeploymentBlock) && Number(parsed.deploymentBlock) !== configuredDeploymentBlock) {
      return null;
    }
    const deploymentBlock = Number(parsed.deploymentBlock);
    const lastBlock = Number(parsed.lastBlock);
    const transferCount = Number(parsed.transferCount || 0);
    if (![deploymentBlock, lastBlock, transferCount].every(Number.isSafeInteger)) return null;
    const balances = new Map((parsed.balances || []).map(([address, balance]) => [normalizeAddress(address), BigInt(balance)]));
    console.log(`Loaded MATT holder checkpoint through block ${lastBlock}.`);
    return { deploymentBlock, lastBlock, transferCount, balances };
  } catch (error) {
    console.warn("Ignoring invalid MATT holder checkpoint:", safeErrorMessage(error));
    return null;
  }
}

function saveHolderCheckpoint(index) {
  try {
    fs.mkdirSync(path.dirname(HOLDER_STATE_FILE), { recursive: true });
    const temporaryFile = `${HOLDER_STATE_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(checkpointPayload(index)));
    fs.renameSync(temporaryFile, HOLDER_STATE_FILE);
  } catch (error) {
    if (!checkpointWarningShown) {
      checkpointWarningShown = true;
      console.warn("MATT holder checkpoint could not be written; continuing in memory:", safeErrorMessage(error));
    }
  }
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
    targetBlock: confirmedLatest,
    retryAttempt: 0,
    nextRetryAt: null
  });

  let cursor = holderIndex.lastBlock + 1;
  let chunksSinceCheckpoint = 0;
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
    chunksSinceCheckpoint += 1;
    updateProgress({
      phase: "indexing",
      indexedBlock: holderIndex.lastBlock,
      retryAttempt: 0,
      nextRetryAt: null
    });

    if (chunksSinceCheckpoint >= HOLDER_CHECKPOINT_EVERY_CHUNKS) {
      saveHolderCheckpoint(holderIndex);
      chunksSinceCheckpoint = 0;
    }
  }

  saveHolderCheckpoint(holderIndex);
  holderSnapshot = buildSnapshot(holderIndex);
  holderLastError = null;
  updateProgress({
    phase: "ready",
    deploymentBlock: holderIndex.deploymentBlock,
    indexedBlock: holderIndex.lastBlock,
    targetBlock: confirmedLatest,
    retryAttempt: 0,
    nextRetryAt: null
  });
  return holderSnapshot;
}

function clearScheduledHolderRefresh() {
  if (holderRetryTimer) clearTimeout(holderRetryTimer);
  holderRetryTimer = null;
}

function scheduleHolderRefresh(waitMs = HOLDER_AUTO_RETRY_MS) {
  if (holderRefreshPromise || holderRetryTimer) return;
  const boundedWait = Math.max(1_000, waitMs);
  updateProgress({
    phase: "waiting_retry",
    nextRetryAt: new Date(Date.now() + boundedWait).toISOString()
  });
  holderRetryTimer = setTimeout(() => {
    holderRetryTimer = null;
    startHolderRefresh();
  }, boundedWait);
  holderRetryTimer.unref?.();
}

function startHolderRefresh() {
  if (holderRefreshPromise) return holderRefreshPromise;
  clearScheduledHolderRefresh();
  holderLastError = null;
  updateProgress({
    startedAt: holderProgress.startedAt || new Date().toISOString(),
    nextRetryAt: null
  });

  holderRefreshPromise = syncHolderIndex()
    .catch(error => {
      holderLastError = error;
      console.warn("MATT holder index refresh paused:", safeErrorMessage(error));
      scheduleHolderRefresh(retryDelayMs(error, Math.min(holderProgress.retryAttempt || 0, RPC_MAX_RETRIES)));
      return holderSnapshot;
    })
    .finally(() => {
      holderRefreshPromise = null;
      if (holderLastError && !holderRetryTimer) scheduleHolderRefresh();
    });

  return holderRefreshPromise;
}

if (require.main === module) {
  app.listen(port, () => {
    console.log(`MATT website listening on ${port}`);
    console.log(`Holder index RPC pacing: one request every ${RPC_MIN_INTERVAL_MS}ms, up to ${RPC_MAX_RETRIES} retries.`);
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
  topicAddress,
  parseRetryAfter,
  isRateLimitError,
  isRetryableRpcError,
  retryDelayMs,
  rpcRequest
};
