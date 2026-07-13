const crypto = require("crypto");
const { Wallet, AbiCoder, keccak256, getBytes } = require("ethers");

const flows = new Map();
const sessions = new Map();
const COOKIE = "matt_x_v2";
const API = "https://api.x.com/2";
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const challenge = value => crypto.createHash("sha256").update(value).digest("base64url");

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf("=");
    return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
}

function config() {
  const value = {
    clientId: process.env.X_CLIENT_ID || "",
    clientSecret: process.env.X_CLIENT_SECRET || "",
    redirectUri: process.env.X_REDIRECT_URI || "",
    targetId: process.env.X_TARGET_USER_ID || "",
    targetHandle: process.env.X_TARGET_HANDLE || "crafting_skill",
    verifierKey: process.env.X_REWARD_VERIFIER_PRIVATE_KEY || "",
    contract: process.env.MATT_DAILY_REWARDS_V2_ADDRESS || "",
    chainId: BigInt(process.env.RONIN_CHAIN_ID || "2020"),
  };
  value.enabled = Boolean(value.clientId && value.redirectUri && value.targetId && value.verifierKey && addressPattern.test(value.contract));
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || body.title || body.error_description || `X returned HTTP ${response.status}`);
  return body;
}

async function isFollowing(accessToken, sourceId, targetId) {
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${API}/users/${sourceId}/following`);
    url.searchParams.set("max_results", "1000");
    if (cursor) url.searchParams.set("pagination_token", cursor);
    const result = await requestJson(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if ((result.data || []).some(user => String(user.id) === String(targetId))) return true;
    cursor = result.meta?.next_token || "";
    if (!cursor) return false;
  }
  throw new Error("Follow list is too large to verify");
}

function currentSession(req) {
  const id = cookies(req.headers.cookie)[COOKIE];
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

function installXFollowVerifier(app) {
  const express = require("express");
  app.use("/api/x", express.json({ limit: "16kb" }));

  app.get("/api/x/config", (_req, res) => {
    const cfg = config();
    res.set("Cache-Control", "no-store").json({ enabled: cfg.enabled, targetHandle: cfg.targetHandle });
  });

  app.get("/api/x/start", (req, res) => {
    const cfg = config();
    if (!cfg.enabled) return res.status(503).send("Verified X rewards are not configured.");
    const wallet = String(req.query.wallet || "").toLowerCase();
    if (!addressPattern.test(wallet)) return res.status(400).send("Valid wallet required.");
    const state = token();
    const verifier = token(48);
    flows.set(state, { wallet, verifier, expiresAt: Date.now() + 600000 });
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", "users.read follows.read offline.access");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(url.toString());
  });

  app.get("/api/x/callback", async (req, res) => {
    const cfg = config();
    const state = String(req.query.state || "");
    const flow = flows.get(state);
    flows.delete(state);
    if (!flow || flow.expiresAt < Date.now()) return res.status(400).send("X verification expired.");
    try {
      const body = new URLSearchParams({
        code: String(req.query.code || ""), grant_type: "authorization_code",
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, code_verifier: flow.verifier,
      });
      const headers = { "content-type": "application/x-www-form-urlencoded" };
      if (cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
      const oauth = await requestJson("https://api.x.com/2/oauth2/token", { method: "POST", headers, body });
      const me = await requestJson(`${API}/users/me`, { headers: { authorization: `Bearer ${oauth.access_token}` } });
      const id = token();
      sessions.set(id, {
        wallet: flow.wallet, accessToken: oauth.access_token,
        xUserId: String(me.data.id), username: String(me.data.username || ""),
        expiresAt: Date.now() + 3600000,
      });
      res.cookie(COOKIE, id, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 3600000, path: "/" });
      res.redirect("/hub.html?x_connected=1#daily-missions");
    } catch (error) {
      res.status(502).send(`X verification failed: ${String(error.message || error).slice(0, 180)}`);
    }
  });

  app.get("/api/x/status", (req, res) => {
    const cfg = config();
    const session = currentSession(req);
    res.set("Cache-Control", "no-store").json(session ? {
      enabled: cfg.enabled, connected: true, wallet: session.wallet,
      username: session.username, targetHandle: cfg.targetHandle,
    } : { enabled: cfg.enabled, connected: false, targetHandle: cfg.targetHandle });
  });

  app.post("/api/x/proof", async (req, res) => {
    const cfg = config();
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: "Authorize X first." });
    const wallet = String(req.body?.wallet || "").toLowerCase();
    const betId = String(req.body?.betId || "");
    if (wallet !== session.wallet || !/^\d+$/.test(betId)) return res.status(400).json({ error: "Wallet or bet mismatch." });
    try {
      if (!(await isFollowing(session.accessToken, session.xUserId, cfg.targetId))) {
        return res.status(403).json({ error: `@${session.username} is not following @${cfg.targetHandle}.` });
      }
      const xUserHash = keccak256(Buffer.from(session.xUserId));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const encoded = AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "address", "uint256", "bytes32", "uint256"],
        [cfg.contract, cfg.chainId, wallet, BigInt(betId), xUserHash, deadline]
      );
      const proof = await new Wallet(cfg.verifierKey).signMessage(getBytes(keccak256(encoded)));
      res.json({ xUserHash, deadline: deadline.toString(), proof, username: session.username });
    } catch (error) {
      res.status(502).json({ error: String(error.message || error).slice(0, 200) });
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, flow] of flows) if (flow.expiresAt < now) flows.delete(id);
    for (const [id, session] of sessions) if (session.expiresAt < now) sessions.delete(id);
  }, 60000).unref();
}

module.exports = { installXFollowVerifier };
