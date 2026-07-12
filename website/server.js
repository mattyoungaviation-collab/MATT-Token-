const express = require("express");
const path = require("path");

const app = express();
const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;

const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const MATT_ADDRESS_LOWER = MATT_ADDRESS.toLowerCase();
const MATT_TOTAL_SUPPLY = 10_000_000_000n * 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RONIN_RPC_URL = process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";
const HOLDER_CACHE_TTL_MS = positiveInteger(process.env.HOLDER_CACHE_TTL_MS, 60_000);
const HOLDER_LOG_CHUNK_SIZE = positiveInteger(process.env.HOLDER_LOG_CHUNK_SIZE, 25_000);
const HOLDER_CONFIRMATIONS = positiveInteger(process.env.HOLDER_CONFIRMATIONS, 12);
const RPC_TIMEOUT_MS = positiveInteger(process.env.RPC_TIMEOUT_MS, 15_000);
const MAX_DISCOVERY_WINDOWS = positiveInteger(process.env.HOLDER_MAX_DISCOVERY_WINDOWS, 250);

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

app.disable("x-powered-by");
app.use(express.static(publicDir, { extensions: ["html"], maxAge: "1h" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    holderIndex: {
      ready: Boolean(holderSnapshot),
      updating: Boolean(holderRefreshPromise),
      indexedBlock: holderIndex?.lastBlock ?? null,
      lastError: holderLastError ? "Holder index temporarily unavailable" : null
    }
  });
});

app.get("/api/token", (_req, res) => res.sendFile(path.join(publicDir, "token.json")));

app.get("/api/holders", async (req, res) => {
  try {
    const snapshot = await getHolderSnapshot();
    const query = stringQuery(req.query.q).trim().toLowerCase().slice(0, 100);
    const limit = boundedInteger(req.query.limit, 50, 1, 100);
    const offset = boundedInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const matchingHolders = query
      ? snapshot.holders.filter(holder => holderSearchText(holder).includes(query))
      : snapshot.holders;

    const page = matchingHolders.slice(offset, offset + limit);

    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    res.json({
      token: {
        address: MATT_ADDRESS,
        symbol: "MATT",
        decimals: 18,
        totalSupplyRaw: MATT_TOTAL_SUPPLY.toString()
      },
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
    console.error("MATT holder index error:", error);
    res.set("Retry-After", "30");
    res.status(503).json({
      error: "HOLDER_INDEX_UNAVAILABLE",
      message: "The public holder index is temporarily unavailable. Please try again shortly."
    });
  }
});

app.get(["/hub", "/hub/"], (_req, res) => res.sendFile(path.join(publicDir, "hub.html")));

app.get("/{*splat}", (req, res) => {
  if (!req.accepts("html")) {
    return res.status(404).json({ error: "Not found" });
  }
  return res.sendFile(path.join(publicDir, "index.html"));
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcRequestId,
        method,
        params
      }),
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

async function codeExistsAt(blockNumber) {
  const code = await rpcRequest("eth_getCode", [MATT_ADDRESS, blockHex(blockNumber)]);
  return typeof code === "string" && code !== "0x" && code !== "0x0";
}

async function findDeploymentBlockByCode(latestBlock) {
  if (!(await codeExistsAt(latestBlock))) throw new Error("MATT contract code was not found on Ronin Mainnet");

  let low = 0;
  let high = latestBlock;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await codeExistsAt(middle)) high = middle;
    else low = middle + 1;
  }

  return low;
}

function shouldSplitLogRange(error, fromBlock, toBlock, depth) {
  if (fromBlock >= toBlock || depth >= 12) return false;
  const message = String(error?.message || error).toLowerCase();
  const terminalFailure =
    message.includes("timed out") ||
    message.includes("http 429") ||
    message.includes("http 5") ||
    message.includes("fetch failed") ||
    message.includes("enotfound") ||
    message.includes("econnreset");
  return !terminalFailure;
}

async function fetchTransferLogsRange(fromBlock, toBlock, depth = 0) {
  if (fromBlock > toBlock) return [];

  try {
    const result = await rpcRequest("eth_getLogs", [{
      address: MATT_ADDRESS,
      fromBlock: blockHex(fromBlock),
      toBlock: blockHex(toBlock),
      topics: [TRANSFER_TOPIC]
    }]);
    if (!Array.isArray(result)) throw new Error("Ronin RPC returned invalid log data");
    return result;
  } catch (error) {
    if (!shouldSplitLogRange(error, fromBlock, toBlock, depth)) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    const left = await fetchTransferLogsRange(fromBlock, middle, depth + 1);
    const right = await fetchTransferLogsRange(middle + 1, toBlock, depth + 1);
    return left.concat(right);
  }
}

async function findDeploymentBlockByMintLog(latestBlock) {
  let toBlock = latestBlock;

  for (let windowIndex = 0; windowIndex < MAX_DISCOVERY_WINDOWS && toBlock >= 0; windowIndex += 1) {
    const fromBlock = Math.max(0, toBlock - HOLDER_LOG_CHUNK_SIZE + 1);
    const logs = await fetchTransferLogsRange(fromBlock, toBlock);
    const mintBlocks = logs
      .filter(log => Array.isArray(log.topics) && topicAddress(log.topics[1]) === ZERO_ADDRESS)
      .map(log => parseHexNumber(log.blockNumber));

    if (mintBlocks.length) return Math.min(...mintBlocks);
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }

  throw new Error("Could not discover the MATT deployment block. Set MATT_DEPLOYMENT_BLOCK on the server.");
}

async function resolveDeploymentBlock(latestBlock) {
  const configured = Number.parseInt(process.env.MATT_DEPLOYMENT_BLOCK || "", 10);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  if (holderIndex?.deploymentBlock != null) return holderIndex.deploymentBlock;

  try {
    return await findDeploymentBlockByMintLog(latestBlock);
  } catch (error) {
    console.warn("Transfer-log deployment discovery failed; falling back to historical contract-code lookup:", error.message);
    return findDeploymentBlockByCode(latestBlock);
  }
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
    const deploymentBlock = await resolveDeploymentBlock(confirmedLatest);
    holderIndex = {
      deploymentBlock,
      lastBlock: deploymentBlock - 1,
      transferCount: 0,
      balances: new Map()
    };
  }

  let cursor = holderIndex.lastBlock + 1;
  while (cursor <= confirmedLatest) {
    const endBlock = Math.min(confirmedLatest, cursor + HOLDER_LOG_CHUNK_SIZE - 1);
    const logs = await fetchTransferLogsRange(cursor, endBlock);
    logs.sort((left, right) => {
      const blockDifference = parseHexNumber(left.blockNumber) - parseHexNumber(right.blockNumber);
      return blockDifference || parseHexNumber(left.logIndex) - parseHexNumber(right.logIndex);
    });

    for (const log of logs) applyTransferLog(holderIndex.balances, log);
    holderIndex.transferCount += logs.length;
    holderIndex.lastBlock = endBlock;
    cursor = endBlock + 1;
  }

  holderSnapshot = buildSnapshot(holderIndex);
  holderLastError = null;
  return holderSnapshot;
}

async function getHolderSnapshot() {
  const isFresh = holderSnapshot && Date.now() - holderSnapshot.generatedAt < HOLDER_CACHE_TTL_MS;
  if (isFresh) return holderSnapshot;
  if (holderRefreshPromise) return holderRefreshPromise;

  holderRefreshPromise = syncHolderIndex().finally(() => {
    holderRefreshPromise = null;
  });
  return holderRefreshPromise;
}

if (require.main === module) {
  app.listen(port, () => {
    console.log(`MATT website listening on ${port}`);
    const warmup = setTimeout(() => {
      getHolderSnapshot().catch(error => {
        holderLastError = error;
        console.warn("MATT holder index warmup failed:", error.message);
      });
    }, 1_000);
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
