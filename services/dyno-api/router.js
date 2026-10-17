"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { getAddress, Interface, Contract, JsonRpcProvider, Wallet, ZeroHash } = require("ethers");
const { validateManifest } = require("../../scripts/dyno/validate-manifest");
const { createStore } = require("./store");
const { identityCommitment, walletChallenge, verifyWalletChallenge, signPurchaseVoucher, random } = require("./identity");
const { verifyReportedNftDelivery } = require("./prize-delivery");
const { readPurchaseState, requirePurchasable, PurchaseStateError } = require("./purchase-state");
const { createMemoryAuthStore } = require("./auth-store");
const { readActiveRound, readRound, readTicket, readWinners, readBuyback, atBlock, id } = require("./public-state");
const { projectFinancials } = require("./financials");
const { readProtection, prepareProtection } = require("./protection");

function cookieMap(header = "") {
  const result = {};
  for (const item of header.split(";")) {
    const i = item.indexOf("="); if (i < 1) continue;
    try { result[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1)); } catch {}
  }
  return result;
}
function safeCsvCell(value) { const text = String(value ?? ""); return /^[=+\-@]/.test(text.trimStart()) || /^[\u0000-\u001f]/.test(text) ? `'${text}` : text; }

function createDynoRouter({ getDiscordSession, manifestPath, manifest: providedManifest, store, authStore: providedAuthStore, now = () => Date.now(), chainProvider, raffleManager, buybackVault, protectionGuardFactory, multisigContract, env = process.env } = {}) {
  const router = express.Router();
  const selectedPath = manifestPath || env.DYNO_MANIFEST || path.join(__dirname, "../../config/project-dyno.local.json");
  const manifest = providedManifest || JSON.parse(fs.readFileSync(selectedPath, "utf8"));
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Project DYNO manifest rejected: ${errors.join("; ")}`);
  const siteOrigin = new URL(manifest.websiteOrigin || manifest.publicOAuthRedirectUri).origin;
  const allowedBrowserOrigins = new Set([siteOrigin, new URL(manifest.publicOAuthRedirectUri).origin]);
  const checkoutEnabled = manifest.environment !== "production" || env.DYNO_CHECKOUT_ENABLED === "true";
  const db = store || createStore({ production: manifest.environment === "production", env, chainId: manifest.chainId });
  const authStore = providedAuthStore || db.auth || createMemoryAuthStore();
  const financialCache = new Map();
  if (manifest.environment === "production" && authStore.kind !== "sqlite-encrypted") throw new Error("Project DYNO production requires configured durable encrypted authentication storage");
  if (typeof authStore.consumeRateLimit !== "function") throw new Error("Project DYNO requires authentication rate limiting");
  const provider = chainProvider || (!manifest.mock && env[manifest.rpcUrlEnv] ? new JsonRpcProvider(env[manifest.rpcUrlEnv], manifest.chainId, { staticNetwork: true }) : null);
  const manager = raffleManager || (provider ? new Contract(manifest.raffleProxy, require("../../packages/abis/ProjectDynoRaffleManager.json").abi, provider) : null);
  const vault = buybackVault || (provider ? new Contract(manifest.buybackProxy, require("../../packages/abis/ProjectDynoBuybackVault.json").abi, provider) : null);
  const nftProvider = !manifest.mock && env[manifest.nftRpcUrlEnv] ? new JsonRpcProvider(env[manifest.nftRpcUrlEnv]) : null;
  const cookieName = "dyno_wallet";
  const sessionFor = req => {
    const id = cookieMap(req.headers.cookie)[cookieName]; return id ? authStore.get("wallet-session", id, now()) : null;
  };
  function limitRequest(req, res, scope, subject, maximum, windowMs = 300_000) {
    if (authStore.consumeRateLimit(scope, subject, { limit: maximum, windowMs, now: now() })) return false;
    res.set("Retry-After", String(Math.ceil((windowMs - now() % windowMs) / 1000)));
    res.status(429).json({ error: "RATE_LIMITED" });
    return true;
  }
  const clientBucket = req => String(req.ip || req.socket?.remoteAddress || "unknown");
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

  router.get("/health", async (_req, res) => {
    let chainOpen = false;
    if (checkoutEnabled && !manifest.mock && provider && manager) {
      try {
        const pinned = await atBlock({ provider, chainId: manifest.chainId, nowSeconds: Math.floor(now() / 1000) }, async at => {
          const roundId = await manager.activeRoundId(at);
          if (roundId === 0n) return { open: false };
          const [round, paused] = await Promise.all([manager.getRoundStatus(roundId, at), manager.checkoutPaused(at)]);
          return { open: round.phase === 2n && paused === false };
        });
        chainOpen = pinned.open;
      } catch { /* An unavailable or stale chain never advertises purchases. */ }
    }
    const healthy = await db.health();
    res.set("Cache-Control", "no-store").json({ ok: healthy, database: db.kind, authentication: authStore.kind,
      environment: manifest.environment, mock: manifest.mock, enabled: !manifest.mock,
      purchasesEnabled: healthy && checkoutEnabled && chainOpen });
  });
  router.get("/config", (_req, res) => res.json({
    environment: manifest.environment, mock: manifest.mock, chainId: manifest.chainId, raffleProxy: manifest.raffleProxy,
    purchasesEnabled: checkoutEnabled && !manifest.mock,
    buybackProxy: manifest.buybackProxy, matt: manifest.matt, mattDecimals: manifest.mattDecimals, nftCollection: manifest.nftCollection, nftTokenId: manifest.nftTokenId,
    prizeDelivery: manifest.prizeDelivery, paymentModel: manifest.paymentModel, nftChainId: manifest.nftChainId,
    round: manifest.mock ? manifest.round : null, disclosure: manifest.mock ? "LOCAL MOCK DATA — purchases are disabled." : "Round prices and prizes must be read from the live contract; ticket MATT is held, not sold, and disqualified/cancelled tickets can claim both original assets.",
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
  router.get("/active-round", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (manifest.mock) return res.json({ mock: true, roundId: "1", status: "LOCAL_MOCK_ROUND", freshness: "local-mock-unindexed" });
    try { res.json(await readActiveRound({ provider, manager, chainId: manifest.chainId, nowSeconds: Math.floor(now() / 1000) })); }
    catch { res.status(503).json({ error: "CHAIN_STATE_UNAVAILABLE" }); }
  });
  for (const [route, reader] of [["/round", readRound], ["/ticket", readTicket], ["/winners", readWinners], ["/buyback", readBuyback]]) {
    router.get(route, async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (route === "/buyback" && manifest.paymentModel === "RON_AND_HELD_MATT") return res.status(410).json({ error: "NO_BUYBACK_IN_THIS_MODEL" });
      if (manifest.mock) return res.json({ mock: true, phase: "DRAFT_DEMO", eligibleCount: 0, capacity: 1000, freshness: "local-mock-unindexed", winners: [], slots: [], available: false });
      try {
        const result = await reader({ provider, manager, vault, chainId: manifest.chainId, roundId: String(req.query.roundId || "1"), ticketId: req.query.ticketId, offset: req.query.offset, limit: req.query.limit, nowSeconds: Math.floor(now() / 1000) });
        res.json(result);
      } catch (error) {
        const code = String(error.message || "");
        if (/^INVALID_(ROUND|TICKET|PAGINATION)$/.test(code)) return res.status(400).json({ error: code });
        if (/^(ROUND|TICKET)_NOT_FOUND$/.test(code)) return res.status(404).json({ error: code });
        return res.status(503).json({ error: "CHAIN_STATE_UNAVAILABLE" });
      }
    });
  }
  router.get("/financials", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (manifest.mock) return res.status(503).json({ error: "INDEX_UNAVAILABLE" });
    try {
      const roundId = id(req.query.roundId || "1"), checkpoint = await db.checkpoint(manifest.chainId);
      if (!checkpoint?.hash) throw new Error("INDEX_UNAVAILABLE");
      const key = `${roundId}:${checkpoint.block_number}:${checkpoint.hash}`;
      let result = financialCache.get(key);
      if (!result) {
        result = await projectFinancials({ store: db, chainId: manifest.chainId, roundId,
          finalityPolicy: manifest.indexerFinalityMode || (manifest.environment === "production" ? "rpc-finalized" : "confirmations") });
        if (financialCache.size >= 8) financialCache.clear();
        financialCache.set(key, result);
      }
      res.json(result);
    } catch (error) {
      if (error.message === "INVALID_ROUND") return res.status(400).json({ error: "INVALID_ROUND" });
      return res.status(503).json({ error: "INDEX_UNAVAILABLE" });
    }
  });
  router.post("/auth/nonce", express.json({ limit: "8kb" }), (req, res) => {
    if (limitRequest(req, res, "nonce-ip", clientBucket(req), 120)) return;
    let wallet;
    try { wallet = getAddress(req.body?.wallet); } catch { return res.status(400).json({ error: "INVALID_WALLET" }); }
    if (limitRequest(req, res, "nonce-wallet", wallet.toLowerCase(), 12)) return;
    const origin = manifest.environment === "production" ? siteOrigin : `${req.protocol}://${req.get("host")}`;
    const challenge = walletChallenge({ wallet, domain: new URL(origin).host, uri: `${origin}/dyno`, chainId: manifest.chainId, now: now() });
    authStore.put("wallet-challenge", wallet.toLowerCase(), challenge, Date.parse(challenge.expiresAt));
    res.json(challenge);
  });
  router.post("/auth/verify", express.json({ limit: "12kb" }), (req, res) => {
    if (limitRequest(req, res, "verify-ip", clientBucket(req), 120)) return;
    let wallet;
    try { wallet = getAddress(req.body?.wallet); } catch { return res.status(400).json({ error: "INVALID_WALLET" }); }
    if (limitRequest(req, res, "verify-wallet", wallet.toLowerCase(), 12)) return;
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
  router.get("/link-status", async (req, res) => {
    const wallet = sessionFor(req), discord = await getDiscordSession?.(req);
    const linked = Boolean(wallet && discord?.verified && discord.guildMember && discord.wallet?.toLowerCase() === wallet.wallet.toLowerCase());
    res.json({ wallet: wallet?.wallet || null, linked,
      discord: discord ? { verified: discord.verified, guildMember: discord.guildMember, username: discord.username } : null });
  });
  router.get("/quota", async (req, res) => {
    if (limitRequest(req, res, "quota-ip", clientBucket(req), 240)) return;
    const session = sessionFor(req);
    if (session && limitRequest(req, res, "quota-wallet", session.wallet.toLowerCase(), 60)) return;
    try { const { state } = await participantState(req); const { signer, ...publicState } = state; res.json(publicState); }
    catch (error) { stateError(res, error); }
  });
  router.post("/voucher", express.json({ limit: "12kb" }), async (req, res) => {
    if (!checkoutEnabled) return res.status(503).json({ error: "DYNO_CHECKOUT_DISABLED", purchasesEnabled: false });
    if (limitRequest(req, res, "voucher-ip", clientBucket(req), 120)) return;
    const session = sessionFor(req);
    if (session && limitRequest(req, res, "voucher-wallet", session.wallet.toLowerCase(), 15)) return;
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
      res.set("Cache-Control", "no-store");
      const result = await atBlock({ provider, chainId: manifest.chainId, nowSeconds: Math.floor(now() / 1000) }, async at => {
        const roundId = id(req.query.roundId || "1");
        const [terms, status] = await Promise.all([manager.getRoundTerms(roundId, at), manager.getRoundStatus(roundId, at)]);
        if (status.phase !== 2n || terms.ticketRon <= 0n || terms.ticketMatt <= 0n) throw new Error("CHECKOUT_UNAVAILABLE");
        return { quantity, roundId, paymentModel: "RON_AND_HELD_MATT", ticketRon: terms.ticketRon.toString(), ticketMatt: terms.ticketMatt.toString(), totalRon: (terms.ticketRon * BigInt(quantity)).toString(), totalMatt: (terms.ticketMatt * BigInt(quantity)).toString(), expiresAt: Math.floor(now() / 1000) + 120 };
      });
      res.json(result);
    } catch { res.status(503).json({ error: "FIXED_PRICE_QUOTE_UNAVAILABLE" }); }
  });
  const protectionOptions = req => ({ provider, manager, vault, manifest, roundId: String(req.body?.roundId || req.query.roundId || "1"), nowSeconds: Math.floor(now() / 1000), guardFactory: protectionGuardFactory, safe: multisigContract });
  async function readAdminAuthority(session, contractKey, onAuthorized) {
    if (!provider || !manager) throw new Error("ADMIN_AUTHORITY_UNAVAILABLE");
    const safe = multisigContract || new Contract(manifest.multisig, ["function isOwner(address) view returns(bool)"], provider);
    return atBlock({ provider, chainId: manifest.chainId, nowSeconds: Math.floor(now() / 1000) }, async (at, block) => {
      if (getAddress(await manager.multisig(at)) !== getAddress(manifest.multisig)) throw new Error("CONTROL_MISMATCH");
      const emergency = manifest.emergencyAdmin && getAddress(await manager.emergencyAdmin(at));
      if (emergency && emergency !== getAddress(manifest.emergencyAdmin)) throw new Error("CONTROL_MISMATCH");
      const direct = emergency && emergency === getAddress(session.wallet);
      const safeOwner = direct ? false : await safe.isOwner(session.wallet, at);
      const executionFrom = direct ? emergency : manifest.multisig;
      if (contractKey === "vault" && (direct || safeOwner) && !await vault?.hasRole(ZeroHash, executionFrom, at)) throw new Error("CONTROL_MISMATCH");
      if ((direct || safeOwner) && onAuthorized) await onAuthorized({ at, block, executionFrom });
      return { direct: !!direct, safeOwner: !!safeOwner, executionFrom };
    });
  }
  function protectionError(res, error) {
    const code = String(error.message || "");
    if (code === "MULTISIG_OWNER_REQUIRED") return res.status(403).json({ error: code });
    if (/^INVALID_(ROUND|PROTECTION)$/.test(code)) return res.status(400).json({ error: code });
    if (["PROTECTION_CHANGED", "PROTECTION_PHASE"].includes(code)) return res.status(409).json({ error: code });
    return res.status(503).json({ error: "PROTECTION_UNAVAILABLE" });
  }
  router.get("/protection", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (manifest.paymentModel === "RON_AND_HELD_MATT") return res.status(410).json({ error: "NO_SWAPS_IN_THIS_MODEL" });
    if (manifest.mock) return res.json({ mock: true, available: false, canPropose: false });
    try { res.json(await readProtection(protectionOptions(req))); } catch (error) { protectionError(res, error); }
  });
  router.get("/admin/protection", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (manifest.paymentModel === "RON_AND_HELD_MATT") return res.status(410).json({ error: "NO_SWAPS_IN_THIS_MODEL" });
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: "WALLET_LOGIN_REQUIRED" });
    if (manifest.mock) return res.status(503).json({ error: "MOCK_ADMIN_DISABLED" });
    try { res.json(await readProtection({ ...protectionOptions(req), wallet: session.wallet })); } catch (error) { protectionError(res, error); }
  });
  router.post("/admin/protection/prepare", express.json({ limit: "8kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (manifest.paymentModel === "RON_AND_HELD_MATT") return res.status(410).json({ error: "NO_SWAPS_IN_THIS_MODEL" });
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: "WALLET_LOGIN_REQUIRED" });
    if (manifest.mock) return res.status(503).json({ error: "MOCK_ADMIN_DISABLED" });
    if (req.headers.origin && !allowedBrowserOrigins.has(req.headers.origin)) return res.status(403).json({ error: "ORIGIN_REJECTED" });
    try {
      const state = await readProtection({ ...protectionOptions(req), wallet: session.wallet });
      res.json(await prepareProtection({ state, request: req.body, manifest, provider }));
    } catch (error) { protectionError(res, error); }
  });
  router.post("/admin/prepare", express.json({ limit: "32kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const session = sessionFor(req);
      if (!session || session.expiresAt < now()) return res.status(401).json({ error: "WALLET_LOGIN_REQUIRED" });
      if (manifest.mock) return res.status(503).json({ error: "MOCK_ADMIN_DISABLED" });
      if (req.headers.origin && !allowedBrowserOrigins.has(req.headers.origin)) return res.status(403).json({ error: "ORIGIN_REJECTED" });
      if (req.body?.value !== undefined && String(req.body.value) !== "0") return res.status(400).json({ error: "NONZERO_VALUE_NOT_ALLOWED" });
      if (!provider || !manager) return res.status(503).json({ error: "ADMIN_AUTHORITY_UNAVAILABLE" });
      const methods = {
        manager: new Set(["createRound", "openRound", "resolveFlag", "disqualifyTicket", "finalizeEligibility", "settleRound", "attemptPrizePayout", "reportManualNftDelivery", "cancelRound", "relinkIdentity", "rotateIdentitySigner", "setSubsystemPaused", "setReviewer", "setEmergencyAdmin", "setVrfRefundReceiver", "claimTreasuryMatt", "upgradeToAndCall"]),
        vault: new Set(), // inactive legacy vault has no operational draft actions in the no-sale model
      };
      const contractKey = req.body?.contract;
      if (!methods[contractKey]?.has(req.body?.method) || !Array.isArray(req.body?.args)) return res.status(400).json({ error: "METHOD_NOT_ALLOWED" });
      const contractName = contractKey === "vault" ? "ProjectDynoBuybackVault" : "ProjectDynoRaffleManager";
      const artifact = require(`../../packages/abis/${contractName}.json`);
      const data = new Interface(artifact.abi).encodeFunctionData(req.body.method, req.body.args);
      const target = contractKey === "vault" ? manifest.buybackProxy : manifest.raffleProxy;
      let authority;
      try {
        authority = await readAdminAuthority(session, contractKey, async ({ block, executionFrom }) => {
          try { await provider.send("eth_call", [{ from: executionFrom, to: target, data, value: "0x0" }, `0x${block.number.toString(16)}`]); }
          catch { throw new Error("ADMIN_SIMULATION_FAILED"); }
        });
      } catch (error) {
        if (error.message === "ADMIN_SIMULATION_FAILED") return res.status(409).json({ error: "ADMIN_SIMULATION_FAILED" });
        return res.status(503).json({ error: "ADMIN_AUTHORITY_UNAVAILABLE" });
      }
      if (!authority.direct && !authority.safeOwner) return res.status(403).json({ error: "MULTISIG_OWNER_REQUIRED" });
      const executionMode = authority.direct ? "emergency-wallet" : "multisig", executionFrom = authority.executionFrom;
      res.json({ target, value: "0", data, executionMode, executionFrom, authorityBlock: authority.chainBlock, authorityBlockHash: authority.chainBlockHash, simulated: true, meaning: `Prepare ${req.body.method}; ${executionMode === "emergency-wallet" ? "unilateral emergency authority" : "multisig approval required"}; simulated at the authority block, not approved or executed`, submitted: false });
    } catch { res.status(400).json({ error: "PREPARATION_FAILED" }); }
  });
  for (const format of ["json", "csv"]) router.get(format === "csv" ? "/admin/identities.csv" : "/admin/identities", async (req, res) => {
    res.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
    const session = sessionFor(req);
    if (!session || session.expiresAt < now()) return res.status(401).json({ error: "WALLET_LOGIN_REQUIRED" });
    if (manifest.mock || !authStore.listIdentityObservations) return res.status(503).json({ error: "PRIVATE_EXPORT_UNAVAILABLE" });
    const limit = String(req.query.limit ?? "50"), offset = String(req.query.offset ?? "0");
    if (!/^[1-9][0-9]*$/.test(limit) || !/^(0|[1-9][0-9]*)$/.test(offset) || BigInt(limit) > 250n || BigInt(offset) > 1_000_000n) return res.status(400).json({ error: "INVALID_PAGINATION" });
    let authority;
    try { authority = await readAdminAuthority(session, "manager"); }
    catch { return res.status(503).json({ error: "ADMIN_AUTHORITY_UNAVAILABLE" }); }
    if (!authority.direct && !authority.safeOwner) return res.status(403).json({ error: "MULTISIG_OWNER_REQUIRED" });
    try {
      const rows = authStore.listIdentityObservations({ limit: Number(limit), offset: Number(offset) }).map(record => ({
        commitment: record.commitment, discordUserId: String(record.discordUserId), displayName: record.displayName,
        wallet: record.wallet, identityVersion: String(record.identityVersion), chainId: String(record.chainId),
        blockNumber: String(record.blockNumber), blockHash: record.blockHash, bindingConfirmed: !!record.bindingConfirmed,
        observedAtUtc: new Date(record.observedAt).toISOString(),
      }));
      if (format === "json") return res.json({ exportVersion: 1, private: true, authorityBlock: authority.chainBlock, authorityBlockHash: authority.chainBlockHash, rows });
      const columns = ["exportVersion", "authorityBlock", "commitment", "discordUserId", "displayName", "wallet", "identityVersion", "chainId", "blockNumber", "blockHash", "bindingConfirmed", "observedAtUtc"];
      const csv = [columns.join(","), ...rows.map(row => columns.map(column => `"${safeCsvCell(column === "exportVersion" ? 1 : column === "authorityBlock" ? authority.chainBlock : row[column]).replaceAll('"', '""')}"`).join(","))].join("\r\n");
      return res.type("text/csv").set("Content-Disposition", "attachment; filename=project-dyno-private-identities.csv").send(`${csv}\r\n`);
    } catch { return res.status(503).json({ error: "PRIVATE_EXPORT_UNAVAILABLE" }); }
  });
  router.get("/admin/identity-history", async (req, res) => {
    res.set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
    const session = sessionFor(req);
    if (!session || session.expiresAt < now()) return res.status(401).json({ error: "WALLET_LOGIN_REQUIRED" });
    if (manifest.mock || !authStore.listIdentityObservationHistory) return res.status(503).json({ error: "PRIVATE_HISTORY_UNAVAILABLE" });
    const commitment = String(req.query.commitment || ""), limit = String(req.query.limit ?? "50"), offset = String(req.query.offset ?? "0");
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment) || !/^[1-9][0-9]*$/.test(limit) || !/^(0|[1-9][0-9]*)$/.test(offset) || BigInt(limit) > 250n || BigInt(offset) > 1_000_000n) return res.status(400).json({ error: "INVALID_HISTORY_REQUEST" });
    let authority;
    try { authority = await readAdminAuthority(session, "manager"); }
    catch { return res.status(503).json({ error: "ADMIN_AUTHORITY_UNAVAILABLE" }); }
    if (!authority.direct && !authority.safeOwner) return res.status(403).json({ error: "MULTISIG_OWNER_REQUIRED" });
    try {
      const rows = authStore.listIdentityObservationHistory({ commitment, limit: Number(limit), offset: Number(offset) }).map(record => ({
        auditId: String(record.auditId), commitment: record.commitment, discordUserId: String(record.discordUserId), displayName: record.displayName,
        wallet: record.wallet, identityVersion: String(record.identityVersion), chainId: String(record.chainId), blockNumber: String(record.blockNumber),
        blockHash: record.blockHash, bindingConfirmed: !!record.bindingConfirmed,
        observedAtUtc: new Date(record.observedAt).toISOString(), auditCreatedAtUtc: new Date(record.auditCreatedAt).toISOString(),
      }));
      res.json({ private: true, commitment, authorityBlock: authority.chainBlock, authorityBlockHash: authority.chainBlockHash, rows });
    } catch { res.status(503).json({ error: "PRIVATE_HISTORY_UNAVAILABLE" }); }
  });
  router.get("/wallet-tickets", async (req, res) => {
    res.set("Cache-Control", "no-store");
    let wallet;
    try { wallet = getAddress(req.query.wallet); } catch { return res.status(400).json({ error: "INVALID_WALLET" }); }
    const offset = Number(req.query.offset || 0), limit = 25;
    if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: "INVALID_PAGINATION" });
    try {
      const checkpoint = db.checkpoint ? await db.checkpoint(manifest.chainId) : null;
      if (!checkpoint?.hash) return res.status(503).json({ error: "INDEX_UNAVAILABLE" });
      const rows = await db.ledger({ wallet, eventName: "TicketPurchased", limit: limit + 1, offset });
      res.json({ wallet, rows: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null,
        indexedBlock: checkpoint.block_number, indexedBlockHash: `0x${checkpoint.hash}`,
        note: "Indexed purchase history; check each ticket for current eligibility and claims." });
    } catch { res.status(503).json({ error: "INDEX_UNAVAILABLE" }); }
  });
  router.get("/ledger", async (req, res) => {
    const rows = await db.ledger({ roundId: req.query.roundId, limit: req.query.limit, offset: req.query.offset });
    const checkpoint = db.checkpoint ? await db.checkpoint(manifest.chainId) : null;
    const finalityPolicy = manifest.indexerFinalityMode || (manifest.environment === "production" ? "rpc-finalized" : "confirmations");
    res.json({ rows, indexedBlock: checkpoint?.block_number || null, indexedBlockHash: checkpoint ? `0x${checkpoint.hash}` : null, finalityPolicy, freshness: checkpoint ? (finalityPolicy === "rpc-finalized" ? "indexed-finalized-checkpoint" : "indexed-confirmation-checkpoint") : "unindexed" });
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
