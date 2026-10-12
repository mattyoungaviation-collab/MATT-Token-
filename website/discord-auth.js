const crypto = require("crypto");
const { createMemoryAuthStore } = require("../services/dyno-api/auth-store");

const API = "https://discord.com/api/v10";
const COOKIE = "matt_discord";
const FLOW_COOKIE = "matt_discord_flow";
const defaultAuthStore = createMemoryAuthStore();
const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

function cookies(header = "") {
  const values = {};
  for (const item of header.split(";")) {
    const index = item.indexOf("="); if (index < 1) continue;
    try { values[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1)); } catch {}
  }
  return values;
}

function config(env = process.env) {
  const value = {
    clientId: String(env.DISCORD_CLIENT_ID || "").trim(),
    clientSecret: String(env.DISCORD_CLIENT_SECRET || "").trim(),
    redirectUri: String(env.DISCORD_REDIRECT_URI || "").trim(),
    guildId: String(env.DISCORD_GUILD_ID || "").trim(),
  };
  let validRedirect = false;
  try {
    const uri = new URL(value.redirectUri);
    validRedirect = uri.pathname === "/api/discord/callback" && !uri.username && !uri.password && !uri.search && !uri.hash &&
      (uri.protocol === "https:" || (env.NODE_ENV !== "production" && uri.protocol === "http:" && ["localhost", "127.0.0.1"].includes(uri.hostname)));
  } catch {}
  value.enabled = Boolean(/^\d{17,20}$/.test(value.clientId) && value.clientSecret && /^\d{17,20}$/.test(value.guildId) && validRedirect);
  return value;
}

async function requestJson(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error_description || body.message || `Discord returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function currentSession(req, authStore = req.app?.locals?.discordAuthStore || defaultAuthStore) {
  const id = cookies(req.headers.cookie)[COOKIE];
  const session = id ? authStore.get("discord-session", id) : null;
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

function getDiscordSession(req) {
  const session = currentSession(req);
  return session ? { ...session } : null;
}

function installDiscordAuth(app, { fetchImpl = fetch, env = process.env, authStore = defaultAuthStore } = {}) {
  if (app.locals) app.locals.discordAuthStore = authStore;
  app.get("/api/discord/config", (_req, res) => {
    const cfg = config(env);
    res.set("Cache-Control", "no-store").json({ enabled: cfg.enabled });
  });

  app.get("/api/discord/start", (req, res) => {
    const cfg = config(env);
    if (!cfg.enabled) return res.status(503).send("Discord verification is not configured.");
    const wallet = String(req.query.wallet || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) return res.status(400).send("Valid wallet required.");
    const state = token();
    const expiresAt = Date.now() + 10 * 60_000;
    authStore.put("discord-flow", state, { wallet, expiresAt }, expiresAt);
    res.cookie(FLOW_COOKIE, state, { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", maxAge: 10 * 60_000, path: "/api/discord" });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", "identify guilds.members.read");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/api/discord/callback", async (req, res) => {
    const cfg = config(env);
    const state = String(req.query.state || "");
    if (!cfg.enabled) return res.status(503).send("Discord verification is not configured.");
    const browserState = cookies(req.headers.cookie)[FLOW_COOKIE];
    if (!/^[A-Za-z0-9_-]{43}$/.test(browserState || "") || !/^[A-Za-z0-9_-]{43}$/.test(state) || !crypto.timingSafeEqual(Buffer.from(browserState), Buffer.from(state))) return res.status(400).send("Discord verification could not be matched to this browser. Start again from the raffle.");
    const flow = authStore.take("discord-flow", state);
    res.clearCookie(FLOW_COOKIE, { path: "/api/discord" });
    if (!flow || flow.expiresAt <= Date.now()) return res.status(400).send("Discord verification expired. Start again from the raffle.");
    if (req.query.error || !req.query.code) return res.status(400).send("Discord authorization was cancelled. Start again when ready.");
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
      }, fetchImpl);
      const user = await requestJson(`${API}/users/@me`, {
        headers: { authorization: `Bearer ${oauth.access_token}` },
      }, fetchImpl);
      if (!user.id) throw new Error("Discord did not return a user identity.");
      let guildMember = false;
      if (cfg.guildId) {
        await requestJson(`${API}/users/@me/guilds/${encodeURIComponent(cfg.guildId)}/member`, {
          headers: { authorization: `Bearer ${oauth.access_token}` },
        }, fetchImpl);
        guildMember = true;
      }
      const id = token();
      const session = {
        wallet: flow.wallet,
        discordUserId: String(user.id),
        username: String(user.global_name || user.username || "Discord user"),
        verified: true,
        guildMember,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60_000,
      };
      authStore.put("discord-session", id, session, session.expiresAt);
      res.cookie(COOKIE, id, { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", maxAge: 24 * 60 * 60_000, path: "/" });
      res.redirect("/dyno?discord_verified=1");
    } catch (error) {
      res.status(502).send("Discord verification failed. Confirm server membership and try again.");
    }
  });

  app.get("/api/discord/status", (req, res) => {
    const cfg = config(env);
    const session = currentSession(req, authStore);
    res.set("Cache-Control", "no-store").json(session ? {
      enabled: cfg.enabled,
      connected: true,
      verified: session.verified === true,
      wallet: session.wallet,
      username: session.username,
      guildMember: session.guildMember === true,
    } : { enabled: cfg.enabled, connected: false, verified: false });
  });

  const cleanup = setInterval(() => {
    authStore.prune();
  }, 60_000).unref();
  return { close: () => clearInterval(cleanup), getDiscordSession: req => { const session = currentSession(req, authStore); return session ? { ...session } : null; } };
}

module.exports = { installDiscordAuth, getDiscordSession, config };
