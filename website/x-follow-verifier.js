const crypto = require("crypto");
const { Wallet, verifyMessage, AbiCoder, keccak256, getBytes } = require("ethers");

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const API_URL = "https://api.x.com/2";
const COOKIE_NAME = "matt_x_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;
const PROOF_TTL_SECONDS = 10 * 60;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const flows = new Map();
const sessions = new Map();

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function randomToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function sha256(value) {
  return base64url(crypto.createHash("sha256").update(value).digest());
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function safeReturnPath(value) {
  return typeof value === "string" && /^\/[a-zA-Z0-9/_?=&.-]*$/.test(value) ? value : "/hub.html#daily-missions";
}

function requiredConfig() {
  const config = {
    clientId: process.env.X_CLIENT_ID || "",
    clientSecret: process.env.X_CLIENT_SECRET || "",
    redirectUri: process.env.X_REDIRECT_URI || "",
    targetUserId: process.env.X_TARGET_USER_ID || "",
    targetHandle: process.env.X_TARGET_HANDLE || "crafting_skill",
    verifierPrivateKey: process.env.X_REWARD_VERIFIER_PRIVATE_KEY || "",
  };
  config.enabled = Boolean(config.clientId && config.redirectUri && config.targetUserId && config.verifierPrivateKey);
  return config;
}

async function xRequest(url, accessToken) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.detail || payload?.title || `X API returned HTTP ${response.status}`);
  return payload;
}

async function exchangesCode(config, code, verifier) {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }
  const response = await fetch(TOKEN_URL, { method: "POST", headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(payload?.error_description || "X OAuth token exchange failed");
  return payload;
}

async function followsTarget(accessToken, sourceUserId, targetUserId) {
  let paginationToken = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${API_URL}/users/${encodeURIComponent(sourceUserId)}/following`);
    url.searchParams.set("max_results", "1000");
    if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
    const payload = await xRequest(url, accessToken);
    if ((payload.data || []).some(user => String(user.id) === String(targetUserId))) return true;
    paginationToken = payload.meta?.next_token || "";
    if (!paginationToken) return false;
  }
  throw new Error("X follow list was too large to verify safely");
}

function sessionFor(req) {
  const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return { id, session };
}

function installXFollowVerifier(app) {
  const config = requiredConfig();
  app.use("/api/x", require("express").json({ limit: "16kb", strict: true }));

  app.get("/api/x/config", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      enabled: config.enabled,
      targetHandle: config.targetHandle,
      reason: config.enabled ? null : "X OAuth environment variables are not configured",
    });
  });

  app.get("/api/x/start", (req, res) => {
    if (!config.enabled) return res.status(503).send("X verification is not configured.");
    const wallet = String(req.query.wallet || "").toLowerCase();
    if (!addressPattern.test(wallet)) return res.status(400).send("A valid Ronin wallet is required.");

    const state = randomToken();
    const verifier = randomToken(48);
    flows.set(state, {
      wallet,
      verifier,
      returnPath: safeReturnPath(req.query.return),
      expiresAt: Date.now() + FLOW_TTL_MS,
    });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("scope", "users.read follows.read offline.access");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", sha256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(url.toString());
  });

  app.get("/api/x/callback", async (req, res) => {
    const flow = flows.get(String(req.query.state || ""));
    flows.delete(String(req.query.state || ""));
    if (!flow || flow.expiresAt <= Date.now()) return res.status(400).send("X verification session expired. Return to MATT Hub and try again.");
    if (req.query.error) return res.redirect(`${flow.returnPath}?x_error=${encodeURIComponent(String(req.query.error))}`);

    try {
      const token = await exchangesCode(config, String(req.query.code || ""), flow.verifier);
      const me = await xRequest(`${API_URL}/users/me`, token.access_token);
      if (!me.data?.id) throw new Error("X did not return a user account");
      const id = randomToken();
      sessions.set(id, {
        wallet: flow.wallet,
        xUserId: String(me.data.id),
        username: String(me.data.username || ""),
        accessToken: token.access_token,
        expiresAt: Date.now() + SESSION_TTL_MS,
        nonce: randomToken(18),
      });
      res.cookie(COOKIE_NAME, id, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: SESSION_TTL_MS,
        path: "/",
      });
      return res.redirect(`${flow.returnPath}${flow.returnPath.includes("?") ? "&" : "?"}x_connected=1`);
    } catch (error) {
      return res.status(502).send(`X verification failed: ${String(error.message || error).slice(0, 180)}`);
    }
  });

  app.get("/api/x/status", (req, res) => {
    const found = sessionFor(req);
    res.set("Cache-Control", "no-store");
    if (!found) return res.json({ connected: false, enabled: config.enabled, targetHandle: config.targetHandle });
    const { session } = found;
    return res.json({
      connected: true,
      enabled: config.enabled,
      wallet: session.wallet,
      username: session.username,
      targetHandle: config.targetHandle,
      nonce: session.nonce,
    });
  });

  app.post("/api/x/proof", async (req, res) => {
    const found = sessionFor(req);
    if (!found) return res.status(401).json({ error: "Connect and authorize X first." });
    const { session } = found;
    const wallet = String(req.body?.wallet || "").toLowerCase();
    const betId = String(req.body?.betId || "");
    const signature = String(req.body?.signature || "");
    if (wallet !== session.wallet || !/^\d+$/.test(betId)) return res.status(400).json({ error: "Wallet or bet is invalid." });

    const message = `MATT X follow verification\nWallet: ${wallet}\nBet: ${betId}\nNonce: ${session.nonce}`;
    let recovered;
    try { recovered = verifyMessage(message, signature).toLowerCase(); } catch { return res.status(401).json({ error: "Wallet signature is invalid." }); }
    if (recovered !== wallet) return res.status(401).json({ error: "Wallet signature does not match the connected wallet." });

    try {
      const following = await followsTarget(session.accessToken, session.xUserId, config.targetUserId);
      if (!following) return res.status(403).json({ error: `@${session.username} is not currently following @${config.targetHandle}.` });

      const contractAddress = process.env.MATT_DAILY_REWARDS_V2_ADDRESS || "";
      if (!addressPattern.test(contractAddress)) throw new Error("Rewards V2 contract address is not configured");
      const chainId = BigInt(process.env.RONIN_CHAIN_ID || "2020");
      const xUserHash = keccak256(Buffer.from(session.xUserId, "utf8"));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + PROOF_TTL_SECONDS);
      const encoded = AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "address", "uint256", "bytes32", "uint256"],
        [contractAddress, chainId, wallet, BigInt(betId), xUserHash, deadline]
      );
      const digest = keccak256(encoded);
      const proof = await new Wallet(config.verifierPrivateKey).signMessage(getBytes(digest));
      session.nonce = randomToken(18);
      return res.json({ xUserHash, deadline: deadline.toString(), proof, username: session.username });
    } catch (error) {
      return res.status(502).json({ error: String(error.message || error).slice(0, 200) });
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of flows) if (value.expiresAt <= now) flows.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
  }, 60_000).unref();
}

module.exports = { installXFollowVerifier };
