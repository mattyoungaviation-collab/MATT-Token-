const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { ethers } = require("ethers");
const { TOKEN_ADDRESS, createCWGuildArcadeRouter } = require("./cwguild-arcade-routes");

async function fixture(overrides = {}) {
  let timestamp = Date.parse("2026-10-17T12:00:00Z");
  let payouts = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cwguild-arcade-"));
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/cwguild", createCWGuildArcadeRouter({
    live: true,
    stateFile: path.join(directory, "state.json"),
    minimumBalance: "1",
    prizeAmount: "100",
    signer: { getAddress: async () => "0x0000000000000000000000000000000000000001" },
    getOperatorAddress: async () => "0x0000000000000000000000000000000000000001",
    getBalance: async () => ethers.parseUnits("5", 18),
    getPoolBalance: async () => ethers.parseUnits("1000", 18),
    payPrize: async () => ({ hash: `0x${"ab".repeat(32)}`, wait: async () => ({ status: 1 }) }),
    randomInt: () => 0,
    now: () => timestamp,
    ...overrides
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/cwguild`;
  return {
    base,
    directory,
    advance: milliseconds => { timestamp += milliseconds; },
    payouts: () => payouts,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function json(url, options) {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  return { response, body: await response.json() };
}

test("publishes verified Ronin token configuration without requiring approvals", async t => {
  const site = await fixture();
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const { response, body } = await json(`${site.base}/status`);
  assert.equal(response.status, 200);
  assert.equal(body.token.address, TOKEN_ADDRESS);
  assert.equal(body.chainId, 2020);
  assert.equal(body.rules.wagerRequired, false);
  assert.equal(body.rules.approvalRequired, false);
});

test("rejects a signature from a different wallet", async t => {
  const site = await fixture();
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const stranger = ethers.Wallet.createRandom();
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const signature = await stranger.signMessage(challenge.body.message);
  const started = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: challenge.body.nonce, signature }) });
  assert.equal(started.response.status, 401);
  assert.match(started.body.error, /did not match/i);
});

test("pays one correct skill run and blocks a second daily prize", async t => {
  let payouts = 0;
  const site = await fixture({ payPrize: async () => { payouts += 1; return { hash: `0x${"cd".repeat(32)}`, wait: async () => ({ status: 1 }) }; } });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const signature = await player.signMessage(challenge.body.message);
  const started = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: challenge.body.nonce, signature }) });
  assert.equal(started.response.status, 201);
  site.advance(4_000);
  const finished = await json(`${site.base}/game/finish`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId, moves: started.body.sequence }) });
  assert.equal(finished.response.status, 200);
  assert.equal(finished.body.won, true);
  assert.equal(finished.body.paid, true);
  assert.equal(finished.body.claim.status, "confirmed");
  assert.equal(payouts, 1);

  const nextChallenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const nextSignature = await player.signMessage(nextChallenge.body.message);
  const duplicate = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: nextChallenge.body.nonce, signature: nextSignature }) });
  assert.equal(duplicate.response.status, 409);
  assert.match(duplicate.body.error, /already earned/i);
  assert.equal(payouts, 1);
});

test("keeps underfunded wallets out of the prize run", async t => {
  const site = await fixture({ getBalance: async () => 0n });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const signature = await player.signMessage(challenge.body.message);
  const started = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: challenge.body.nonce, signature }) });
  assert.equal(started.response.status, 403);
  assert.match(started.body.error, /hold at least/i);
});
