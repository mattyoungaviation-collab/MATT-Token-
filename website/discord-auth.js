const crypto = require("crypto");

const API = "https://discord.com/api/v10";
const COOKIE = "matt_discord";
const flows = new Map();
const sessions = new Map();
const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

function cookies(header = "") {
  return Object.fromEntries(header.split(";").map(value => value.trim()).filter(Boolean).map(value => {
    const index = value.indexOf("=");
    return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
  }));
}

function config() {
  const value = {
    clientId: String(process.env.DISCORD_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.DISCORD_CLIENT_SECRET || "").trim(),
    redirectUri: String(process.env.DISCORD_REDIRECT_URI || "").trim(),
  };
  value.enabled = Boolean(value.clientId && value.clientSecret && value.redirectUri);
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error_description || body.message || `Discord returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function currentSession(req) {
  const id = cookies(req.headers.cookie)[COOKIE];
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

function getDiscordSession(req) {
  const session = currentSession(req);
  return session ? { ...session } : null;
}

function installDiscordAuth(app) {
  const cfg = config();

  app.get("/api/discord/config", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ enabled: cfg.enabled });
  });

  app.get("/api/discord/start", (req, res) => {
    if (!cfg.enabled) return res.status(503).send("Discord verification is not configured.");
    const wallet = String(req.query.wallet || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) return res.status(400).send("Valid wallet required.");
    const state = token();
    flows.set(state, { wallet, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/api/discord/callback", async (req, res) => {
    const state = String(req.query.state || "");
    const flow = flows.get(state);
    flows.delete(state);
    if (!cfg.enabled) return res.status(503).send("Discord verification is not configured.");
    if (!flow || flow.expiresAt < Date.now()) return res.status(400).send("Discord verification expired. Start again from the raffle.");
    try {
      const body = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "authorization_code",
        code: String(req.query.code || ""),
        redirect_uri: cfg.redirectUri,
      });
      const oauth = await requestJson(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const user = await requestJson(`${API}/users/@me`, {
        headers: { authorization: `Bearer ${oauth.access_token}` },
      });
      if (!user.id) throw new Error("Discord did not return a user identity.");
      const id = token();
      sessions.set(id, {
        wallet: flow.wallet,
        discordUserId: String(user.id),
        username: String(user.global_name || user.username || "Discord user"),
        verified: true,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60_000,
      });
      res.cookie(COOKIE, id, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 24 * 60 * 60_000, path: "/" });
      res.redirect("/?discord_verified=1#dyno-raffle");
    } catch (error) {
      res.status(502).send(`Discord verification failed: ${String(error?.message || error).slice(0, 220)}`);
    }
  });

  app.get("/api/discord/status", (req, res) => {
    const session = currentSession(req);
    res.set("Cache-Control", "no-store").json(session ? {
      enabled: cfg.enabled,
      connected: true,
      verified: session.verified === true,
      wallet: session.wallet,
      username: session.username,
    } : { enabled: cfg.enabled, connected: false, verified: false });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, flow] of flows) if (flow.expiresAt < now) flows.delete(id);
    for (const [id, session] of sessions) if (session.expiresAt < now) sessions.delete(id);
  }, 60_000).unref();
}

module.exports = { installDiscordAuth, getDiscordSession };
