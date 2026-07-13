const express = require("express");
const http = require("http");
const path = require("path");
const { fork } = require("child_process");

const app = express();
const publicPort = Number.parseInt(process.env.PORT || "3000", 10);
const internalPort = Number.parseInt(process.env.INTERNAL_SITE_PORT || String(publicPort + 1), 10);
const roninRpcUrl = process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";

const rpcTimeoutMs = positiveInteger(process.env.COIN_RPC_TIMEOUT_MS, 20_000);
const rpcMaxRetries = nonNegativeInteger(process.env.COIN_RPC_MAX_RETRIES, 8);
const rpcBackoffBaseMs = positiveInteger(process.env.COIN_RPC_BACKOFF_BASE_MS, 750);
const rpcBackoffMaxMs = positiveInteger(process.env.COIN_RPC_BACKOFF_MAX_MS, 30_000);
const rpcMinIntervalMs = nonNegativeInteger(process.env.COIN_RPC_MIN_INTERVAL_MS, 500);
const clientWindowMs = positiveInteger(process.env.COIN_RPC_CLIENT_WINDOW_MS, 60_000);
const clientRequestLimit = positiveInteger(process.env.COIN_RPC_CLIENT_LIMIT, 120);

const allowedRpcMethods = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version"
]);

let rpcRequestId = 0;
let rpcQueue = Promise.resolve();
let nextRpcRequestAt = 0;
const clientWindows = new Map();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use("/api/rpc", express.json({ limit: "32kb", strict: true }));

app.post("/api/rpc", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!allowClientRequest(req.ip || req.socket.remoteAddress || "unknown")) {
    res.set("Retry-After", "60");
    return res.status(429).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32005, message: "Browser RPC request limit exceeded. Try again shortly." }
    });
  }

  const method = typeof req.body?.method === "string" ? req.body.method : "";
  const params = Array.isArray(req.body?.params) ? req.body.params : [];
  const id = req.body?.id ?? null;

  if (!allowedRpcMethods.has(method)) {
    return res.status(403).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "RPC method is not allowed by the MATT Hub proxy." }
    });
  }

  try {
    const result = await rpcRequest(method, params);
    return res.json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    console.error(`Coin RPC proxy error during ${method}:`, safeErrorMessage(error));
    const retryable = isRetryableRpcError(error);
    if (retryable) res.set("Retry-After", "5");
    return res.status(retryable ? 503 : 502).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: safeErrorMessage(error) }
    });
  }
});

app.use((req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
  delete headers["content-length"];

  const upstream = http.request({
    hostname: "127.0.0.1",
    port: internalPort,
    path: req.originalUrl,
    method: req.method,
    headers
  }, upstreamResponse => {
    res.status(upstreamResponse.statusCode || 502);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value !== undefined && name.toLowerCase() !== "transfer-encoding") res.setHeader(name, value);
    }
    upstreamResponse.pipe(res);
  });

  upstream.on("error", error => {
    if (res.headersSent) return res.end();
    res.status(502).json({ error: "SITE_STARTING", message: safeErrorMessage(error) });
  });

  req.pipe(upstream);
});

const child = fork(path.join(__dirname, "server.js"), [], {
  env: { ...process.env, PORT: String(internalPort) },
  stdio: "inherit"
});

const server = app.listen(publicPort, () => {
  console.log(`MATT edge proxy listening on port ${publicPort}; site server on ${internalPort}.`);
});

child.on("exit", (code, signal) => {
  console.error(`MATT site server exited (${signal || code || "unknown"}).`);
  server.close(() => process.exit(code || 1));
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down MATT services.`);
  child.kill(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function allowClientRequest(client) {
  const now = Date.now();
  const current = clientWindows.get(client);
  if (!current || now - current.startedAt >= clientWindowMs) {
    clientWindows.set(client, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= clientRequestLimit;
}

setInterval(() => {
  const cutoff = Date.now() - clientWindowMs * 2;
  for (const [client, window] of clientWindows) {
    if (window.startedAt < cutoff) clientWindows.delete(client);
  }
}, clientWindowMs).unref();

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
  const exponential = Math.min(rpcBackoffMaxMs, rpcBackoffBaseMs * (2 ** attempt));
  const jitter = Math.floor(Math.random() * 251);
  return Math.max(Number(error?.retryAfterMs || 0), exponential + jitter);
}

async function reserveRpcSlot() {
  const queued = rpcQueue.then(async () => {
    const waitMs = Math.max(0, nextRpcRequestAt - Date.now());
    if (waitMs) await delay(waitMs);
    nextRpcRequestAt = Date.now() + rpcMinIntervalMs;
  });
  rpcQueue = queued.catch(() => {});
  return queued;
}

async function rpcRequestOnce(method, params) {
  await reserveRpcSlot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), rpcTimeoutMs);

  try {
    const response = await fetch(roninRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcRequestId, method, params }),
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(`Ronin RPC returned HTTP ${response.status}`);
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
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcRequest(method, params) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpcRequestOnce(method, params);
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt >= rpcMaxRetries) throw error;
      const waitMs = retryDelayMs(error, attempt);
      console.warn(`Coin RPC ${isRateLimitError(error) ? "rate limit" : "retry"} during ${method}; waiting ${waitMs}ms.`);
      await delay(waitMs);
    }
  }
}

function safeErrorMessage(error) {
  const message = String(error?.message || error || "Unknown error");
  return message.replace(roninRpcUrl, "configured Ronin RPC").slice(0, 240);
}
