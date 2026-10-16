"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Wallet, ZeroAddress, ZeroHash } = require("ethers");
const { createDynoRouter } = require("./router");
const { createMemoryStore } = require("./store");
const { identityCommitment } = require("./identity");
const local = require("../../config/project-dyno.local.json");

async function fixture(t, { mock = false } = {}) {
  const wallet = Wallet.createRandom(), signer = Wallet.createRandom();
  const env = { DYNO_IDENTITY_SECRET: "test-identity-secret-".repeat(3), DYNO_IDENTITY_SIGNER_PRIVATE_KEY: signer.privateKey };
  const commitment = identityCommitment("123456789012345678", env.DYNO_IDENTITY_SECRET);
  let nowMs = 86400 * 20000 * 1000 + 1000000;
  const block = { number: 100, hash: "0x" + "12".repeat(32), timestamp: Math.floor(nowMs / 1000) };
  const values = { activeRoundId: 1n, getRoundStatus: { phase: 2n, eligibleCount: 500n }, mattActive: 350000000000000000000000000n,
    getRoundTerms: { ticketRon: 35000000000000000000n, ticketMatt: 700000000000000000000000n }, checkoutPaused: false,
    accountSuspended: false, identityVersion: 3n, walletForAccount: wallet.address, accountForWallet: commitment,
    accountDayCount: 1n, walletDayCount: 0n, identitySigner: signer.address };
  const manager = Object.fromEntries(Object.keys(values).map(name => [name, async () => values[name]]));
  const provider = { send: async () => "0x7a69", getBlock: async () => block };
  const manifest = { ...structuredClone(local), mock };
  const app = express();
  app.use("/api/dyno", createDynoRouter({ manifest, env, store: createMemoryStore(), now: () => nowMs,
    chainProvider: provider, raffleManager: manager, getDiscordSession: () => ({ wallet: wallet.address, discordUserId: "123456789012345678", verified: true, guildMember: true }) }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, cookie) => fetch(origin + "/api/dyno" + route, { headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  async function login() {
    const nonce = await (await request("/auth/nonce", { wallet: wallet.address })).json();
    const signature = await wallet.signMessage(nonce.message);
    const response = await request("/auth/verify", { wallet: wallet.address, signature });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0], signature, nonce };
  }
  return { wallet, signer, values, provider, block, request, login, setNow(value) { nowMs = value; }, getNow: () => nowMs };
}

test("authenticated quota is exact and uncached; client identity version cannot override chain state", async t => {
  const f = await fixture(t), { cookie } = await f.login();
  const quotaResponse = await f.request("/quota?roundId=1", null, cookie), quota = await quotaResponse.json();
  assert.equal(quotaResponse.headers.get("cache-control"), "no-store");
  assert.equal(quota.remaining, 2); assert.equal(quota.identityVersion, 3); assert.equal(quota.blockNumber, "100");
  assert.equal(quota.signer, undefined); assert.equal(quota.discordUserId, undefined);
  const response = await f.request("/voucher", { quantity: 2, roundId: "1", identityVersion: 999 }, cookie);
  assert.equal(response.status, 200); const signed = await response.json();
  assert.equal(signed.voucher.identityVersion, 3); assert.equal(signed.signer, f.signer.address);
  const second = await (await f.request("/voucher", { quantity: 2, roundId: "1" }, cookie)).json();
  assert.notEqual(second.voucher.nonce, signed.voucher.nonce);
  // Issuance reserves nothing; a later successful chain purchase consumes allowance.
  f.values.accountDayCount = 3n;
  const denied = await f.request("/voucher", { quantity: 1 }, cookie);
  assert.equal(denied.status, 409); assert.deepEqual(await denied.json(), { error: "DAILY_LIMIT" });
});
test("wallet nonce requests are throttled without consuming on-chain ticket allowance", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) assert.equal((await f.request("/auth/nonce", { wallet: f.wallet.address })).status, 200);
  const limited = await f.request("/auth/nonce", { wallet: f.wallet.address });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "RATE_LIMITED" });
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(f.values.accountDayCount, 1n);
});
test("invalid signature and replay are rejected without crashing; expired sessions cannot query quota/admin", async t => {
  const f = await fixture(t);
  await f.request("/auth/nonce", { wallet: f.wallet.address });
  const bad = await f.request("/auth/verify", { wallet: f.wallet.address, signature: "not-a-signature" });
  assert.equal(bad.status, 401);
  const { cookie, signature } = await f.login();
  assert.equal((await f.request("/auth/verify", { wallet: f.wallet.address, signature })).status, 401);
  f.setNow(f.getNow() + 86400 * 1000);
  assert.equal((await f.request("/quota", null, cookie)).status, 401);
  const link = await (await f.request("/link-status", null, cookie)).json(); assert.equal(link.wallet, null);
  assert.equal((await f.request("/admin/prepare", { method: "settleRound", args: [1] }, cookie)).status, 401);
  assert.equal((await f.request("/link-status", null, "dyno_wallet=%ZZ")).status, 200);
});
test("suspension, relink, signer mismatch and unavailable RPC cannot issue a voucher or leak RPC credentials", async t => {
  const f = await fixture(t), { cookie } = await f.login();
  f.values.accountSuspended = true;
  assert.deepEqual(await (await f.request("/voucher", { quantity: 1 }, cookie)).json(), { error: "ACCOUNT_SUSPENDED" });
  f.values.accountSuspended = false; f.values.walletForAccount = ZeroAddress; f.values.accountForWallet = ZeroHash;
  assert.deepEqual(await (await f.request("/voucher", { quantity: 1 }, cookie)).json(), { error: "RELINK_REQUIRED" });
  f.values.walletForAccount = f.wallet.address; f.values.accountForWallet = identityCommitment("123456789012345678", "test-identity-secret-".repeat(3));
  f.values.identitySigner = Wallet.createRandom().address;
  const rotated = await f.request("/voucher", { quantity: 1 }, cookie); assert.equal(rotated.status, 503);
  assert.deepEqual(await rotated.json(), { error: "SIGNER_MISMATCH" });
  f.provider.getBlock = async () => { throw new Error("https://private-rpc.invalid/private-api-key"); };
  const outage = await f.request("/quota", null, cookie); assert.equal(outage.status, 503);
  assert.deepEqual(await outage.json(), { error: "CHAIN_STATE_UNAVAILABLE" });
});
test("midnight during chain reads refuses issuance instead of signing with yesterday's quota", async t => {
  const f = await fixture(t), { cookie } = await f.login();
  f.setNow(20001 * 86400 * 1000 - 1000); f.block.timestamp = Math.floor(f.getNow() / 1000);
  f.values.identityVersion = 0n; f.values.walletForAccount = ZeroAddress; f.values.accountForWallet = ZeroHash;
  let reads = 0;
  f.provider.getBlock = async () => { if (++reads === 2) f.setNow(f.getNow() + 1000); return f.block; };
  const result = await f.request("/voucher", { quantity: 1 }, cookie);
  assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: "STALE_CHAIN_STATE" });
});
test("local mock never enables purchases even with authenticated sessions and injected chain readers", async t => {
  const f = await fixture(t, { mock: true }), { cookie } = await f.login();
  assert.equal((await f.request("/quota", null, cookie)).status, 503);
  assert.deepEqual(await (await f.request("/voucher", { quantity: 1 }, cookie)).json(), { error: "MOCK_PURCHASE_DISABLED" });
});
test("no-sale quote uses fixed chain amounts and retires swap/buyback controls", async t => {
  const f = await fixture(t);
  const response = await f.request("/quote?quantity=2&roundId=1");
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.paymentModel, "RON_AND_HELD_MATT");
  assert.equal(quote.totalRon, "70000000000000000000");
  assert.equal(quote.totalMatt, "1400000000000000000000000");
  assert.equal(quote.minOuts, undefined);
  assert.equal((await f.request("/protection")).status, 410);
  assert.equal((await f.request("/buyback")).status, 410);
});
