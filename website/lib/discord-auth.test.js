"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { installDiscordAuth, config } = require("../discord-auth");
const env = {
  NODE_ENV: "production",
  DISCORD_CLIENT_ID: "1559100671309905922",
  DISCORD_GUILD_ID: "1493734022281429257",
  DISCORD_REDIRECT_URI: "https://matttoken.com/api/discord/callback",
  DISCORD_CLIENT_SECRET: "test-only-oauth-secret",
};
const wallet = "0x1DAb596D0121C250a24B00137E84170FA6874be6";
function response() {
  return { statusCode: 200, cookies: {}, cleared: [], headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
    redirect(url) { this.location = url; this.statusCode = 302; return this; },
    cookie(name, value, options) { this.cookies[name] = { value, options }; return this; },
    clearCookie(name) { this.cleared.push(name); return this; },
  };
}
function fixture({ member = true } = {}) {
  const routes = new Map(); const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/token")) return { ok: true, json: async () => ({ access_token: "test-only-access-token" }) };
    if (url.endsWith("/users/@me")) return { ok: true, json: async () => ({ id: "123456789012345678", username: "Test participant" }) };
    return { ok: member, status: member ? 200 : 404, json: async () => member ? { user: { id: "123456789012345678" } } : { message: "private-api-error-test-only-access-token" } };
  };
  installDiscordAuth({ get: (route, handler) => routes.set(route, handler) }, { fetchImpl, env });
  const start = () => {
    const res = response(); routes.get("/api/discord/start")({ query: { wallet } }, res);
    return { res, state: new URL(res.location).searchParams.get("state"), cookie: `matt_discord_flow=${res.cookies.matt_discord_flow.value}` };
  };
  return { routes, calls, start };
}
test("Discord configuration requires membership settings and HTTPS in production", () => {
  assert.equal(config(env).enabled, true);
  assert.equal(config({ ...env, DISCORD_GUILD_ID: "" }).enabled, false);
  assert.equal(config({ ...env, DISCORD_CLIENT_SECRET: "" }).enabled, false);
  assert.equal(config({ ...env, DISCORD_REDIRECT_URI: "http://matttoken.com/api/discord/callback" }).enabled, false);
});
test("OAuth start requests minimal scopes and binds state to an HttpOnly Secure browser cookie", () => {
  const { res, state } = fixture().start(); const uri = new URL(res.location);
  assert.equal(uri.searchParams.get("scope"), "identify guilds.members.read");
  assert.equal(uri.searchParams.get("redirect_uri"), env.DISCORD_REDIRECT_URI);
  assert.equal(state.length, 43);
  assert.equal(res.cookies.matt_discord_flow.options.httpOnly, true);
  assert.equal(res.cookies.matt_discord_flow.options.secure, true);
});
test("Foreign-browser callback is rejected before exchange; valid callback is single-use", async () => {
  const f = fixture(); const { state, cookie } = f.start();
  const forged = response();
  await f.routes.get("/api/discord/callback")({ query: { state, code: "test-code" }, headers: {} }, forged);
  assert.equal(forged.statusCode, 400); assert.equal(f.calls.length, 0);
  const accepted = response();
  await f.routes.get("/api/discord/callback")({ query: { state, code: "test-code" }, headers: { cookie } }, accepted);
  assert.equal(accepted.location, "/dyno?discord_verified=1");
  assert.ok(accepted.cookies.matt_discord);
  assert.equal(f.calls[2].url, `https://discord.com/api/v10/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`);
  const replay = response();
  await f.routes.get("/api/discord/callback")({ query: { state, code: "test-code" }, headers: { cookie } }, replay);
  assert.equal(replay.statusCode, 400); assert.equal(f.calls.length, 3);
});
test("Non-member receives no verified session and private API errors stay redacted", async () => {
  const f = fixture({ member: false }); const { state, cookie } = f.start(); const res = response();
  await f.routes.get("/api/discord/callback")({ query: { state, code: "test-code" }, headers: { cookie } }, res);
  assert.equal(res.statusCode, 502); assert.equal(res.cookies.matt_discord, undefined);
  assert.doesNotMatch(res.body, /test-only|private-api-error/);
});
test("Cancelled Discord authorization exchanges no code and creates no session", async () => {
  const f = fixture(); const { state, cookie } = f.start(); const res = response();
  await f.routes.get("/api/discord/callback")({ query: { state, error: "access_denied" }, headers: { cookie } }, res);
  assert.equal(res.statusCode, 400); assert.equal(f.calls.length, 0);
  assert.equal(res.cookies.matt_discord, undefined);
});
