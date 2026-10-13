const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { fork } = require("child_process");
const { installXFollowVerifier } = require("./x-follow-verifier-v2");
const { installDiscordAuth } = require("./discord-auth");
const { createStore: createDynoStore } = require("../services/dyno-api/store");
const { installBurnFlipStatsCache } = require("./burnflip-stats-cache");
const { installBurnFlipHistoryIndex } = require("./burnflip-history-index");
const { installBurnLeaderboardIndex } = require("./burn-leaderboard-index");
const { installBlackjackHistoryIndex } = require("./blackjack-history-index");
const { installSlotsPnlIndex } = require("./slots-pnl-index");
const { installWalletProfiles } = require("./wallet-profiles");
const { createBlackjackRouter } = require("./lib/blackjack-routes");
const { createDynoRouter } = require("../services/dyno-api/router");
const { selectDynoRuntime, createDisabledDynoRouter, disabledDynoPage } = require("../services/dyno-api/runtime");
const { createGiftBoxQuoteRouter } = require("./gift-box-quote-routes");
const { createLiquidityMarketRouter } = require("./liquidity-market-routes");
const { createPokerRouter } = require("./lib/poker-routes");

const app = express();
const publicPort = Number.parseInt(process.env.PORT || "3000", 10);
const proxyPort = Number.parseInt(process.env.INTERNAL_PROXY_PORT || String(publicPort + 1), 10);
const roninRpcUrl = process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";
const publicDir = path.join(__dirname, "public");
const ethersBrowserBundle = path.resolve(path.dirname(require.resolve("ethers")), "../dist/ethers.umd.min.js");
const configuredDiskPath = String(process.env.RENDER_DISK_PATH || process.env.PERSISTENT_DISK_PATH || "").trim();
const persistentDiskPath = configuredDiskPath || (fs.existsSync("/var/data") ? "/var/data" : "");
const holderStateFile = process.env.HOLDER_STATE_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-holder-index.json") : "");
const burnFlipStatsFile = process.env.BURNFLIP_STATS_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-burnflip-stats.json") : "");
const burnFlipHistoryFile = process.env.BURNFLIP_HISTORY_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-burnflip-history.json") : "");
const burnLeaderboardFile = process.env.BURN_LEADERBOARD_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-burn-leaderboard.json") : "");
const blackjackHistoryFile = process.env.BLACKJACK_HISTORY_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-blackjack-history.json") : "");
const slotsPnlStateFile = process.env.SLOTS_PNL_STATE_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-slots-pnl.json") : "");
const walletProfilesFile = process.env.WALLET_PROFILES_FILE || (persistentDiskPath ? path.join(persistentDiskPath, "matt-wallet-profiles.json") : "");

let statsRpcId = 0;
let statsRpcQueue = Promise.resolve();
let nextStatsRpcAt = 0;
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function reserveStatsRpcSlot() {
  const queued = statsRpcQueue.then(async () => {
    const waitMs = Math.max(0, nextStatsRpcAt - Date.now());
    if (waitMs) await delay(waitMs);
    nextStatsRpcAt = Date.now() + 150;
  });
  statsRpcQueue = queued.catch(() => {});
  return queued;
}
function isRetryableStatsRpcError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "").toLowerCase();
  return status === 408 || status === 425 || status === 429 || status >= 500 || error?.name === "AbortError" || /timeout|timed out|fetch failed|econnreset|socket hang up|temporarily unavailable/.test(message);
}
async function statsRpcRequest(method, params = []) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await reserveStatsRpcSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(roninRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++statsRpcId, method, params }), signal: controller.signal });
      if (!response.ok) { const body = await response.text().catch(() => ""); const error = new Error(`Ronin RPC returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`); error.status = response.status; throw error; }
      const payload = await response.json();
      if (payload.error) { const error = new Error(payload.error.message || "Ronin RPC request failed"); error.code = payload.error.code; throw error; }
      return payload.result;
    } catch (error) {
      if (attempt >= 3 || !isRetryableStatsRpcError(error)) throw error;
      await delay(500 * (2 ** attempt));
    } finally { clearTimeout(timeout); }
  }
  throw new Error("Leaderboard stats RPC exhausted retries");
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
installXFollowVerifier(app);
const dynoRuntime = selectDynoRuntime();
const dynoStore = createDynoStore({ production: dynoRuntime.production, chainId: dynoRuntime.manifest?.chainId || null });
if (dynoRuntime.production && dynoStore.auth?.kind !== "sqlite-encrypted") throw new Error("Project DYNO production requires encrypted persistent authentication storage");
const discordAuth = installDiscordAuth(app, { authStore: dynoStore.auth });
app.use("/api/dyno", dynoRuntime.enabled ? createDynoRouter({ manifest: dynoRuntime.manifest, getDiscordSession: discordAuth.getDiscordSession, store: dynoStore }) : createDisabledDynoRouter(dynoStore));
if (process.env.DYNO_INDEXER_ENABLED === "true") {
  const manifest = dynoRuntime.manifest;
  if (manifest.mock || !process.env[manifest.rpcUrlEnv]) throw new Error("DYNO indexer requires an approved nonmock manifest and its RPC");
  const { DynoIndexer } = require("../services/dyno-indexer/indexer");
  const { startIndexer } = require("../services/dyno-indexer/runner");
  const indexer = new DynoIndexer({ rpcUrl: process.env[manifest.rpcUrlEnv], store: dynoStore, chainId: manifest.chainId,
    managerAddress: manifest.raffleProxy, vaultAddress: manifest.buybackProxy, startBlock: Number(process.env.DYNO_START_BLOCK || 0), finalityBlocks: Number(process.env.DYNO_FINALITY_BLOCKS || 12),
    managerAbi: require("../packages/abis/ProjectDynoRaffleManager.json").abi, vaultAbi: require("../packages/abis/ProjectDynoBuybackVault.json").abi });
  const runner = startIndexer(indexer);
  app.get("/api/dyno/indexer-health", (_req, res) => res.status(runner.status.ok ? 200 : 503).json(runner.status));
}
app.use("/api/gift-boxes", createGiftBoxQuoteRouter({ rpcRequest: statsRpcRequest }));
app.use("/api/liquidity/market", createLiquidityMarketRouter());
const walletProfiles = installWalletProfiles(app, { stateFile: walletProfilesFile });
installBurnFlipStatsCache(app, { rpcRequest: statsRpcRequest, stateFile: burnFlipStatsFile });
installBurnFlipHistoryIndex(app, { rpcRequest: statsRpcRequest, stateFile: burnFlipHistoryFile });
installBurnLeaderboardIndex(app, { rpcRequest: statsRpcRequest, stateFile: burnLeaderboardFile });
installBlackjackHistoryIndex(app, { rpcRequest: statsRpcRequest, stateFile: blackjackHistoryFile });
installSlotsPnlIndex(app, { rpcRequest: statsRpcRequest, stateFile: slotsPnlStateFile });
app.use("/api/poker", createPokerRouter({ live: process.env.POKER_LIVE_ENABLED === "true", contractAddress: process.env.POKER_ESCROW_ADDRESS || "", rpcUrl: process.env.RONIN_RPC_URL || "", operatorPrivateKey: process.env.POKER_OPERATOR_PRIVATE_KEY || "", stateSecret: process.env.POKER_STATE_SECRET || "", stateFile: persistentDiskPath ? path.join(persistentDiskPath, "poker-state.enc") : "" }));
app.use("/api/blackjack", createBlackjackRouter());
app.get(["/burnflip", "/burnflip/"], (_req, res) => res.redirect(302, "/hub#coin-flip"));
app.get(["/poker", "/poker/"], (_req, res) => res.sendFile(path.join(publicDir, "poker.html")));
app.get(["/blackjack", "/blackjack/"], (_req, res) => res.sendFile(path.join(publicDir, "blackjack.html")));
app.get(["/dyno", "/dyno/"], (_req, res) => dynoRuntime.enabled ? res.sendFile(path.join(publicDir, "dyno.html")) : res.set("Cache-Control", "no-store").type("html").send(disabledDynoPage));
app.use((req, res, next) => {
  if (req.path === "/flappy-matt" || req.path.startsWith("/flappy-matt/") || req.path.startsWith("/flappy-matt.")) {
    return res.status(404).send("Not found");
  }
  next();
});
app.use("/api/flappy", (_req, res) => res.status(404).json({ error: "Not found" }));
app.get("/blackjack.css", (_req, res) => res.sendFile(path.join(publicDir, "blackjack.css")));
app.get("/blackjack.js", (_req, res) => res.sendFile(path.join(publicDir, "blackjack.js")));
app.get("/vendor/ethers.umd.min.js", (_req, res) => { res.set("Cache-Control", "public, max-age=31536000, immutable"); res.type("application/javascript"); res.sendFile(ethersBrowserBundle); });
app.use((req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${proxyPort}` };
  delete headers["content-length"];
  const upstream = http.request({ hostname: "127.0.0.1", port: proxyPort, path: req.originalUrl, method: req.method, headers }, upstreamResponse => {
    res.status(upstreamResponse.statusCode || 502);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) if (value !== undefined && name.toLowerCase() !== "transfer-encoding") res.setHeader(name, value);
    upstreamResponse.pipe(res);
  });
  upstream.on("error", error => { if (res.headersSent) return res.end(); res.status(502).json({ error: "SITE_STARTING", message: String(error.message || error).slice(0, 200) }); });
  req.pipe(upstream);
});
const child = fork(path.join(__dirname, "server-proxy.js"), [], { env: { ...process.env, PORT: String(proxyPort), INTERNAL_SITE_PORT: String(proxyPort + 1), COIN_RPC_MIN_INTERVAL_MS: process.env.COIN_RPC_MIN_INTERVAL_MS || "100", RPC_MIN_INTERVAL_MS: process.env.RPC_MIN_INTERVAL_MS || "250", HOLDER_STATE_FILE: holderStateFile }, stdio: "inherit" });
const server = app.listen(publicPort, () => {
  console.log(`MATT combined server listening on ${publicPort}; RPC/site proxy on ${proxyPort}.`);
  console.log(holderStateFile ? `Persistent holder checkpoint: ${holderStateFile}` : "Persistent holder checkpoint: no Render disk detected; using ephemeral storage.");
  console.log(burnFlipStatsFile ? `Persistent BurnFlip stats: ${burnFlipStatsFile}` : "Persistent BurnFlip stats: no Render disk detected; using memory only.");
  console.log(burnFlipHistoryFile ? `Persistent BurnFlip history: ${burnFlipHistoryFile}` : "Persistent BurnFlip history: no Render disk detected; using memory only.");
  console.log(burnLeaderboardFile ? `Persistent burn leaderboard: ${burnLeaderboardFile}` : "Persistent burn leaderboard: no Render disk detected; using memory only.");
  console.log(blackjackHistoryFile ? `Persistent blackjack history: ${blackjackHistoryFile}` : "Persistent blackjack history: no Render disk detected; using memory only.");
  console.log(slotsPnlStateFile ? `Persistent Slots PNL: ${slotsPnlStateFile}` : "Persistent Slots PNL: no disk detected; using memory only.");
  console.log(walletProfilesFile ? `Persistent wallet profiles: ${walletProfilesFile}` : "Persistent wallet profiles: no Render disk detected; using memory only.");
});
function shutdown(signal) { child.kill(signal); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }
child.on("exit", (code, signal) => { console.error(`MATT proxy exited (${signal || code || "unknown"}).`); server.close(() => process.exit(code || 1)); });
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
