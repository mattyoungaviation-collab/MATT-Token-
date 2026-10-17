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
  assert.equal(body.maxPayout, ethers.parseUnits("2000000", 18).toString());
  assert.equal(body.rules.playMs, 8_000);
  assert.equal(body.rules.randomizedRecall, true);
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
  site.advance(2_700);
  const recall = await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId }) });
  assert.equal(recall.response.status, 200);
  assert.equal(recall.body.direction, "forward");
  assert.equal(recall.body.startPosition, 1);
  site.advance(500);
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

test("reveals a randomized recall rule only after the pattern and rejects the plain recording", async t => {
  let payouts = 0;
  const values = [0, 1, 2, 3, 0, 1, 1, 3];
  const site = await fixture({
    randomInt: () => values.shift(),
    payPrize: async () => { payouts += 1; return { hash: `0x${"ef".repeat(32)}`, wait: async () => ({ status: 1 }) }; }
  });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const signature = await player.signMessage(challenge.body.message);
  const started = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: challenge.body.nonce, signature }) });

  const tooSoon = await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId }) });
  assert.equal(tooSoon.response.status, 422);
  site.advance(2_700);
  const recall = await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId }) });
  assert.equal(recall.body.direction, "backward");
  assert.equal(recall.body.startPosition, 4);
  site.advance(500);
  const replayed = await json(`${site.base}/game/finish`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId, moves: started.body.sequence }) });
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.body.won, false);
  assert.equal(payouts, 0);
});

test("expires the recall round and never pays after the timer", async t => {
  let payouts = 0;
  const site = await fixture({ payPrize: async () => { payouts += 1; return { hash: `0x${"aa".repeat(32)}`, wait: async () => ({ status: 1 }) }; } });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const signature = await player.signMessage(challenge.body.message);
  const started = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: challenge.body.nonce, signature }) });
  site.advance(2_700);
  await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId }) });
  site.advance(9_600);
  const expired = await json(`${site.base}/game/finish`, { method: "POST", body: JSON.stringify({ wallet: player.address, gameId: started.body.gameId, moves: started.body.sequence }) });
  assert.equal(expired.response.status, 410);
  assert.equal(payouts, 0);
});

test("stops all future prizes at the configured 2,000,000 CWGUILD lifetime ceiling", async t => {
  let payouts = 0;
  const site = await fixture({
    maxPayout: "100",
    payPrize: async () => { payouts += 1; return { hash: `0x${"bc".repeat(32)}`, wait: async () => ({ status: 1 }) }; }
  });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const winner = ethers.Wallet.createRandom();
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: winner.address }) });
  const signature = await winner.signMessage(challenge.body.message);
  const started = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: winner.address, nonce: challenge.body.nonce, signature }) });
  site.advance(2_700);
  await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: winner.address, gameId: started.body.gameId }) });
  site.advance(500);
  const paid = await json(`${site.base}/game/finish`, { method: "POST", body: JSON.stringify({ wallet: winner.address, gameId: started.body.gameId, moves: started.body.sequence }) });
  assert.equal(paid.body.paid, true);

  const next = ethers.Wallet.createRandom();
  const nextChallenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: next.address }) });
  const nextSignature = await next.signMessage(nextChallenge.body.message);
  const blocked = await json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: next.address, nonce: nextChallenge.body.nonce, signature: nextSignature }) });
  assert.equal(blocked.response.status, 503);
  assert.match(blocked.body.error, /2,000,000 CWGUILD/i);
  assert.equal(payouts, 1);
});
