"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { getAddress, Interface, Contract, JsonRpcProvider, Wallet } = require("ethers");
const { validateManifest } = require("../../scripts/dyno/validate-manifest");
const { createStore } = require("./store");
const { identityCommitment, walletChallenge, verifyWalletChallenge, signPurchaseVoucher, random } = require("./identity");
const { verifyReportedNftDelivery } = require("./prize-delivery");
const { readPurchaseState, requirePurchasable, PurchaseStateError } = require("./purchase-state");
const { createMemoryAuthStore } = require("./auth-store");

function cookieMap(header = "") {
  const result = {};
  for (const item of header.split(";")) {
    const i = item.indexOf("="); if (i < 1) continue;
    try { result[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1)); } catch {}
  }
  return result;
}
function safeCsvCell(value) { const text = String(value ?? ""); return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; }

function createDynoRouter({ getDiscordSession, manifestPath, manifest: providedManifest, store, authStore: providedAuthStore, now = () => Date.now(), chainProvider, raffleManager, env = process.env } = {}) {
  const router = express.Router();
  const selectedPath = manifestPath || env.DYNO_MANIFEST || path.join(__dirname, "../../config/project-dyno.local.json");
  const manifest = providedManifest || JSON.parse(fs.readFileSync(selectedPath, "utf8"));
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Project DYNO manifest rejected: ${errors.join("; ")}`);
  const db = store || createStore({ production: manifest.environment === "production", env, chainId: manifest.chainId });
  const authStore = providedAuthStore || db.auth || createMemoryAuthStore();
  if (manifest.environment === "production" && authStore.kind !== "sqlite-encrypted") throw new Error("Project DYNO production requires configured durable encrypted authentication storage");
  const provider = chainProvider || (!manifest.mock && env[manifest.rpcUrlEnv] ? new JsonRpcProvider(env[manifest.rpcUrlEnv], manifest.chainId, { staticNetwork: true }) : null);
  const manager = raffleManager || (provider ? new Contract(manifest.raffleProxy, require("../../packages/abis/ProjectDynoRaffleManager.json").abi, provider) : null);
  const nftProvider = !manifest.mock && env[manifest.nftRpcUrlEnv] ? new JsonRpcProvider(env[manifest.nftRpcUrlEnv]) : null;
  const cookieName = "dyno_wallet";
  const sessionFor = req => {
    const id = cookieMap(req.headers.cookie)[cookieName]; return id ? authStore.get("wallet-session", id, now()) : null;
  };
  async function participantState(req) {
    if (manifest.mock) throw new PurchaseStateError("MOCK_PURCHASE_DISABLED", 503);
    const session = sessionFor(req), discord = await getDiscordSession?.(req);
    if (!session || !discord?.verified || !discord.guildMember || !discord.wallet || discord.wallet.toLowerCase() !== session.wallet.toLowerCase()) throw new PurchaseStateError("WALLET_AND_DISCORD_REQUIRED", 401);
    const commitment = identityCommitment(discord.discordUserId, env.DYNO_IDENTITY_SECRET);
    const state = await readPurchaseState({ provider, manager, chainId: manifest.chainId, roundId: String(req.body?.roundId || req.query.roundId || "1"), commitment, wallet: session.wallet, nowSeconds: Math.floor(now() / 1000) });
    if (!state.blockedReason) authStore.observeIdentity({ commitment, discordUserId: discord.discordUserId, displayName: discord.username || "Discord user", wallet: session.wallet, identityVersion: state.identityVersion, chainId: manifest.chainId, blockNumber: state.blockNumber, blockHash: state.blockHash, bindingConfirmed: state.bindingConfirmed }, env.DYNO_IDENTITY_SECRET);
    return { session, commitment, state };
  }
  function stateError(res, error) {
    return res.status(error instanceof PurchaseStateError ? error.status : 503).json({ error: error instanceof PurchaseStateError ? error.code : "CHAIN_STATE_UNAVAILABLE" });
  }
  router.use((req, res, next) => { if (/^\/(auth|link-status|quota|voucher)(\/|$)/.test(req.path)) res.set("Cache-Control", "no-store"); next(); });

  router.get("/health", async (_req, res) => res.json({ ok: await db.health(), database: db.kind, authentication: authStore.kind, environment: manifest.environment, mock: manifest.mock }));
  router.get("/config", (_req, res) => res.json({
    environment: manifest.environment, mock: manifest.mock, chainId: manifest.chainId, raffleProxy: manifest.raffleProxy,
    buybackProxy: manifest.buybackProxy, matt: manifest.matt, nftCollection: manifest.nftCollection, nftTokenId: manifest.nftTokenId,
    prizeDelivery: manifest.prizeDelivery, nftChainId: manifest.nftChainId,
    round: manifest.round, disclosure: manifest.mock ? "LOCAL MOCK DATA — purchases are disabled." : "Ticket MATT is sold atomically; refunds are paid in recorded RON proceeds.",
  }));
  router.get("/prize-delivery", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (manifest.mock) return res.json({ verified: false, status: "LOCAL_MOCK_NO_DELIVERY" });
    if (!provider || !nftProvider) return res.status(503).json({ verified: false, status: "NFT_RPC_UNAVAILABLE" });
    const roundId = String(req.query.roundId || "1");
    if (!/^[1-9][0-9]{0,77}$/.test(roundId)) return res.status(400).json({ error: "INVALID_ROUND" });
    try {
      const abi = require("../../packages/abis/ProjectDynoRaffleManager.json").abi;
      const result = await verifyReportedNftDelivery({ manager: new Contract(manifest.raffleProxy, abi, provider), roninProvider: provider, nftProvider, roundId, raffleChainId: manifest.chainId, finalityBlocks: manifest.nftFinalityBlocks });
      return res.json(result);
    } catch { return res.status(503).json({ verified: false, status: "DELIVERY_VERIFICATION_UNAVAILABLE" }); }
  });
  router.get("/round", (_req, res) => res.json({
    indexedBlock: null, freshness: "demo-unindexed", phase: manifest.mock ? "DRAFT_DEMO" : "UNAVAILABLE",
    eligibleCount: 0, capacity: 1000, directReceipts: "0", prizeLiability: "0", reserveTransferred: "0",
    treasuryRemainder: "0", measuredSaleReceipts: "0", refunds: "0", dcaBudget: "0", mattDelivered: "0", unspentReturn: "0",
  }));
  router.post("/auth/nonce", express.json({ limit: "8kb" }), (req, res) => {
    let wallet;
    try { wallet = getAddress(req.body?.wallet); } catch { return res.status(400).json({ error: "INVALID_WALLET" }); }
    const origin = manifest.environment === "production" ? new URL(manifest.publicOAuthRedirectUri).origin : `${req.protocol}://${req.get("host")}`;
    const challenge = walletChallenge({ wallet, domain: new URL(origin).host, uri: `${origin}/dyno`, chainId: manifest.chainId, now: now() });
    authStore.put("wallet-challenge", wallet.toLowerCase(), challenge, Date.parse(challenge.expiresAt));
    res.json(challenge);
  });
  router.post("/auth/verify", express.json({ limit: "12kb" }), (req, res) => {
    let wallet;
    try { wallet = getAddress(req.body?.wallet); } catch { return res.status(400).json({ error: "INVALID_WALLET" }); }
    const key = wallet.toLowerCase();
    const challenge = authStore.take("wallet-challenge", key, now());
    if (!verifyWalletChallenge(challenge, String(req.body?.signature || ""), wallet, now())) return res.status(401).json({ error: "INVALID_OR_EXPIRED_SIGNATURE" });
    const id = random();
    const expiresAt = now() + 24 * 60 * 60_000;
    authStore.put("wallet-session", id, { wallet, expiresAt }, expiresAt);
    res.cookie(cookieName, id, { httpOnly: true, secure: manifest.environment === "production", sameSite: "lax", path: "/", maxAge: 24 * 60 * 60_000 });
    res.json({ wallet });
  });
  router.post("/auth/logout", (req, res) => { const id = cookieMap(req.headers.cookie)[cookieName]; if (id) authStore.delete("wallet-session", id); res.clearCookie(cookieName, { path: "/" }); res.status(204).end(); });
  router.get("/link-status", async (req, res) => { const wallet = sessionFor(req); const discord = await getDiscordSession?.(req); res.json({ wallet: wallet?.wallet || null, discord: discord ? { verified: discord.verified, guildMember: discord.guildMember, username: discord.username } : null }); });
  router.get("/quota", async (req, res) => {
    try { const { state } = await participantState(req); const { signer, ...publicState } = state; res.json(publicState); }
    catch (error) { stateError(res, error); }
  });
  router.post("/voucher", express.json({ limit: "12kb" }), async (req, res) => {
    try {
      const quantity = Number(req.body?.quantity);
      if (![1, 2, 3].includes(quantity)) return res.status(400).json({ error: "INVALID_QUANTITY" });
      const { session, commitment, state } = await participantState(req);
      const signingTime = Math.floor(now() / 1000);
      if (Math.floor(signingTime / 86400) !== state.dayIndex || signingTime - state.chainTimestamp > 120) throw new PurchaseStateError("STALE_CHAIN_STATE", 503);
      const privateKey = env.DYNO_IDENTITY_SIGNER_PRIVATE_KEY;
      requirePurchasable(state, quantity, new Wallet(privateKey).address);
      const signed = await signPurchaseVoucher({ privateKey, chainId: manifest.chainId, manager: manifest.raffleProxy, roundId: state.roundId, commitment, wallet: session.wallet, quantity, identityVersion: state.identityVersion, nonce: `0x${crypto.randomBytes(32).toString("hex")}`, nowSeconds: signingTime });
      res.json(signed);
    } catch (error) { stateError(res, error); }
  });
  router.get("/quote", async (req, res) => {
    try {
      if (manifest.mock || !provider) return res.status(503).json({ error: "VERIFIED_QUOTE_UNAVAILABLE" });
      const quantity = Number(req.query.quantity);
      if (![1, 2, 3].includes(quantity)) return res.status(400).json({ error: "INVALID_QUANTITY" });
      const guard = new Contract(manifest.priceGuard, ["function validate() view", "function saleMinOut(uint256,uint16) view returns(uint256)"], provider);
      await guard.validate();
      const floor = await guard.saleMinOut(manifest.round.ticketMatt, manifest.round.saleSlippageBps);
      res.json({ quantity, minOuts: Array(quantity).fill(floor.toString()), blockNumber: await provider.getBlockNumber(), expiresAt: Math.floor(now() / 1000) + 120 });
    } catch { res.status(503).json({ error: "GUARD_REJECTED" }); }
  });
  router.post("/admin/prepare", express.json({ limit: "32kb" }), async (req, res) => {
    try {
      const session = sessionFor(req);
      if (!session || session.expiresAt < now()) return res.status(401).json({ error: "WALLET_LOGIN_REQUIRED" });
      let authorized = session.wallet.toLowerCase() === manifest.multisig.toLowerCase();
      if (!authorized && provider) {
        try { authorized = await new Contract(manifest.multisig, ["function isOwner(address) view returns(bool)"], provider).isOwner(session.wallet); } catch {}
      }
      if (!authorized) return res.status(403).json({ error: "MULTISIG_OWNER_REQUIRED" });
      const contractName = req.body?.contract === "vault" ? "ProjectDynoBuybackVault" : "ProjectDynoRaffleManager";
      const allowed = new Set(["createRound", "openRound", "resolveFlag", "disqualifyTicket", "finalizeEligibility", "settleRound", "attemptPrizePayout", "reportManualNftDelivery", "cancelRound", "relinkIdentity", "rotateIdentitySigner", "setSubsystemPaused", "setLiveSaleSlippage", "setReviewer", "setSlippageBps", "setExecutionPaused", "upgradeToAndCall"]);
      if (!allowed.has(req.body?.method)) return res.status(400).json({ error: "METHOD_NOT_ALLOWED" });
      const artifact = require(`../../packages/abis/${contractName}.json`);
      const data = new Interface(artifact.abi).encodeFunctionData(req.body.method, req.body.args || []);
      const target = contractName === "ProjectDynoBuybackVault" ? manifest.buybackProxy : manifest.raffleProxy;
      res.json({ target, value: String(req.body.value || "0"), data, meaning: `Prepare ${req.body.method}; not approved or executed`, submitted: false });
    } catch { res.status(400).json({ error: "PREPARATION_FAILED" }); }
  });
  router.get("/ledger", async (req, res) => {
    const rows = await db.ledger({ roundId: req.query.roundId, limit: req.query.limit, offset: req.query.offset });
    const checkpoint = db.checkpoint ? await db.checkpoint(manifest.chainId) : null;
    res.json({ rows, indexedBlock: checkpoint?.block_number || null, indexedBlockHash: checkpoint ? `0x${checkpoint.hash}` : null, freshness: checkpoint ? "indexed-finalized-checkpoint" : "unindexed" });
  });
  router.get("/ledger.csv", async (req, res) => {
    const rows = await db.ledger({ roundId: req.query.roundId, limit: Math.min(Number(req.query.limit || 250), 1000), offset: req.query.offset });
    const columns = ["block_number", "tx_hash", "log_index", "event_name", "payload"];
    const csv = [columns.join(","), ...rows.map(row => columns.map(column => `"${safeCsvCell(column === "payload" ? JSON.stringify(row[column]) : row[column]).replaceAll('"', '""')}"`).join(","))].join("\r\n");
    res.type("text/csv").set("Content-Disposition", "attachment; filename=project-dyno-ledger.csv").send(`sep=,\r\n${csv}\r\n`);
  });
  return router;
}

module.exports = { createDynoRouter, safeCsvCell };
