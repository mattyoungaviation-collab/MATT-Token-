"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express"), { Wallet } = require("ethers");
const { createSqliteStore } = require("./sqlite-store"), { createDynoRouter } = require("./router");
const { installDiscordAuth } = require("../../website/discord-auth");

test("real HTTP wallet challenges, Discord OAuth state and sessions survive app/database restart; replay and logout remain durable", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dyno-auth-test-"));
  const env = { NODE_ENV: "development", DYNO_DATABASE_FILE: path.join(directory, "dyno.sqlite"), DYNO_STORAGE_KEY: Buffer.alloc(32, 10).toString("base64"),
    DISCORD_CLIENT_ID: "1559100671309905922", DISCORD_GUILD_ID: "1493734022281429257", DISCORD_CLIENT_SECRET: "test-only-client-secret", DISCORD_REDIRECT_URI: "http://localhost:3000/api/discord/callback" };
  let running;
  const calls = [];
  async function start() {
    const store = createSqliteStore({ env }), app = express();
    const fetchImpl = async url => { calls.push(url); return { ok: true, json: async () => url.endsWith("/oauth2/token") ? { access_token: "never-retained-access-token" } : url.endsWith("/users/@me") ? { id: "123456789012345678", username: "Private name" } : { user: { id: "123456789012345678" } } }; };
    const discord = installDiscordAuth(app, { env, fetchImpl, authStore: store.auth });
    app.use("/api/dyno", createDynoRouter({ env, store, getDiscordSession: discord.getDiscordSession }));
    const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    running = { store, server, discord, request: (route, { body, cookie } = {}) => fetch(origin + route, { redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) }) };
    return running;
  }
  async function stop() { if (!running) return; running.discord.close(); running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); await running.store.close(); running = null; }
  t.after(async () => {
    await stop();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("dyno-auth-test-")) throw new Error("Unsafe test cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const wallet = Wallet.createRandom(), first = await start();
  const challenge = await (await first.request("/api/dyno/auth/nonce", { body: { wallet: wallet.address } })).json();
  const signature = await wallet.signMessage(challenge.message);
  const flow = await first.request(`/api/discord/start?wallet=${wallet.address}`), state = new URL(flow.headers.get("location")).searchParams.get("state"), flowCookie = flow.headers.get("set-cookie").split(";")[0];
  await stop(); const second = await start();
  const verified = await second.request("/api/dyno/auth/verify", { body: { wallet: wallet.address, signature } }); assert.equal(verified.status, 200);
  const walletCookie = verified.headers.get("set-cookie").split(";")[0];
  const callback = await second.request(`/api/discord/callback?state=${state}&code=test-code`, { cookie: flowCookie }); assert.equal(callback.status, 302);
  const discordCookie = callback.headers.get("set-cookie").split(",").find(value => value.trim().startsWith("matt_discord=")).trim().split(";")[0];
  assert.equal(calls.length, 3);
  await stop(); const third = await start();
  const status = await (await third.request("/api/discord/status", { cookie: discordCookie })).json(); assert.equal(status.connected, true); assert.equal(status.username, "Private name"); assert.equal(status.discordUserId, undefined);
  const link = await (await third.request("/api/dyno/link-status", { cookie: `${walletCookie}; ${discordCookie}` })).json(); assert.equal(link.wallet, wallet.address); assert.equal(link.discord.verified, true); assert.equal(link.linked, true);
  assert.equal((await third.request(`/api/discord/callback?state=${state}&code=test-code`, { cookie: flowCookie })).status, 400); assert.equal(calls.length, 3);
  assert.equal((await third.request("/api/dyno/auth/verify", { body: { wallet: wallet.address, signature } })).status, 401);
  await third.request("/api/dyno/auth/logout", { body: {}, cookie: walletCookie });
  await stop(); const fourth = await start();
  assert.equal((await (await fourth.request("/api/dyno/link-status", { cookie: walletCookie })).json()).wallet, null);
});
