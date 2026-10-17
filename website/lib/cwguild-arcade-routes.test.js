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
    getPoolBalance: async () => ethers.parseUnits("10000", 18),
    payPrize: async () => ({ hash: `0x${"ab".repeat(32)}`, wait: async () => ({ status: 1 }) }),
    randomInt: () => 0,
    now: () => timestamp,
    ...overrides
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/api/cwguild`,
    directory,
    advance: milliseconds => { timestamp += milliseconds; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function json(url, options) {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  return { response, body: await response.json() };
}

async function start(site, player) {
  const challenge = await json(`${site.base}/auth/challenge`, { method: "POST", body: JSON.stringify({ wallet: player.address }) });
  const signature = await player.signMessage(challenge.body.message);
  return json(`${site.base}/game/start`, { method: "POST", body: JSON.stringify({ wallet: player.address, nonce: challenge.body.nonce, signature }) });
}

async function winRound(site, player, game) {
  site.advance(350 + game.sequenceLength * 390);
  const recall = await json(`${site.base}/game/recall`, {
    method: "POST",
    body: JSON.stringify({ wallet: player.address, runId: game.runId, gameId: game.gameId })
  });
  assert.equal(recall.response.status, 200);
  site.advance(250);
  return json(`${site.base}/game/finish`, {
    method: "POST",
    body: JSON.stringify({ wallet: player.address, runId: game.runId, gameId: game.gameId, moves: game.sequence })
  });
}

test("publishes the five hard rounds and contractless safety rules", async t => {
  const site = await fixture();
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const { response, body } = await json(`${site.base}/status`);
  assert.equal(response.status, 200);
  assert.equal(body.token.address, TOKEN_ADDRESS);
  assert.equal(body.chainId, 2020);
  assert.equal(body.maxPayout, ethers.parseUnits("2000000", 18).toString());
  assert.deepEqual(body.rules.ladder.map(round => [round.sequenceLength, round.playMs]), [[6, 8000], [7, 7000], [8, 6000], [9, 5000], [10, 4000]]);
  assert.deepEqual(body.rules.ladder.map(round => ethers.formatUnits(round.rewardAmount, 18)), ["100.0", "300.0", "700.0", "1500.0", "3000.0"]);
  assert.equal(body.rules.rewardIsProvisionalUntilCashOut, true);
  assert.equal(body.rules.lossForfeitsPendingReward, true);
  assert.equal(body.rules.oneAttemptPerWalletUtcDay, true);
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

test("a round win is provisional until the player cashes out", async t => {
  let paidAmount = 0n;
  const site = await fixture({ payPrize: async (_wallet, amount) => { paidAmount = amount; return { hash: `0x${"cd".repeat(32)}`, wait: async () => ({ status: 1 }) }; } });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const started = await start(site, player);
  const won = await winRound(site, player, started.body);
  assert.equal(won.body.won, true);
  assert.equal(won.body.paid, false);
  assert.equal(won.body.pending, true);
  assert.equal(ethers.formatUnits(won.body.pendingAmount, 18), "100.0");
  assert.equal(paidAmount, 0n);

  const cashed = await json(`${site.base}/game/cashout`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  assert.equal(cashed.response.status, 200);
  assert.equal(cashed.body.paid, true);
  assert.equal(ethers.formatUnits(cashed.body.claim.amount, 18), "100.0");
  assert.equal(paidAmount, ethers.parseUnits("100", 18));
});

test("explicitly accepting round two risks round one's entire reward", async t => {
  let payouts = 0;
  const site = await fixture({ payPrize: async () => { payouts += 1; return { hash: `0x${"ef".repeat(32)}`, wait: async () => ({ status: 1 }) }; } });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const started = await start(site, player);
  await winRound(site, player, started.body);
  const next = await json(`${site.base}/game/next`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  assert.equal(next.response.status, 201);
  assert.equal(next.body.round, 2);
  assert.equal(next.body.sequenceLength, 7);
  assert.equal(next.body.inputMs, 7000);
  assert.equal(ethers.formatUnits(next.body.pendingAmount, 18), "100.0");

  site.advance(350 + next.body.sequenceLength * 390);
  await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: next.body.runId, gameId: next.body.gameId }) });
  site.advance(250);
  const lost = await json(`${site.base}/game/finish`, {
    method: "POST",
    body: JSON.stringify({ wallet: player.address, runId: next.body.runId, gameId: next.body.gameId, moves: [] })
  });
  assert.equal(lost.body.won, false);
  assert.equal(lost.body.lost, true);
  assert.equal(ethers.formatUnits(lost.body.forfeitedAmount, 18), "100.0");
  assert.equal(payouts, 0);
  const status = await json(`${site.base}/status?wallet=${player.address}`);
  assert.equal(status.body.run.status, "lost");
  assert.equal(status.body.run.pendingAmount, "0");
});

test("winning round two grows the cash-out amount to 300 CWGUILD", async t => {
  let paidAmount = 0n;
  const site = await fixture({ payPrize: async (_wallet, amount) => { paidAmount = amount; return { hash: `0x${"12".repeat(32)}`, wait: async () => ({ status: 1 }) }; } });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const started = await start(site, player);
  await winRound(site, player, started.body);
  const next = await json(`${site.base}/game/next`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  const wonTwo = await winRound(site, player, next.body);
  assert.equal(ethers.formatUnits(wonTwo.body.pendingAmount, 18), "300.0");
  const cashed = await json(`${site.base}/game/cashout`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  assert.equal(cashed.body.paid, true);
  assert.equal(paidAmount, ethers.parseUnits("300", 18));
});

test("timeout forfeits the pending reward and consumes the daily attempt", async t => {
  const site = await fixture();
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const started = await start(site, player);
  await winRound(site, player, started.body);
  const next = await json(`${site.base}/game/next`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  site.advance(350 + next.body.sequenceLength * 390);
  await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: next.body.runId, gameId: next.body.gameId }) });
  site.advance(next.body.inputMs + 1_600);
  const expired = await json(`${site.base}/game/finish`, {
    method: "POST",
    body: JSON.stringify({ wallet: player.address, runId: next.body.runId, gameId: next.body.gameId, moves: next.body.sequence })
  });
  assert.equal(expired.response.status, 200);
  assert.equal(expired.body.timedOut, true);
  assert.equal(ethers.formatUnits(expired.body.forfeitedAmount, 18), "100.0");

  const duplicate = await start(site, player);
  assert.equal(duplicate.response.status, 409);
  assert.match(duplicate.body.error, /already used/i);
});

test("random post-pattern recall rejects a screen recording replay", async t => {
  const values = [0, 1, 2, 3, 0, 1, 1, 3];
  const site = await fixture({ randomInt: () => values.shift() });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const started = await start(site, player);
  site.advance(350 + started.body.sequenceLength * 390);
  const recall = await json(`${site.base}/game/recall`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId, gameId: started.body.gameId }) });
  assert.equal(recall.body.direction, "backward");
  assert.equal(recall.body.startPosition, 4);
  site.advance(250);
  const replayed = await json(`${site.base}/game/finish`, {
    method: "POST",
    body: JSON.stringify({ wallet: player.address, runId: started.body.runId, gameId: started.body.gameId, moves: started.body.sequence })
  });
  assert.equal(replayed.body.won, false);
});

test("the lifetime ceiling is enforced when a player cashes out", async t => {
  let payouts = 0;
  const site = await fixture({
    maxPayout: "250",
    payPrize: async () => { payouts += 1; return { hash: `0x${"bc".repeat(32)}`, wait: async () => ({ status: 1 }) }; }
  });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const player = ethers.Wallet.createRandom();
  const started = await start(site, player);
  assert.equal(started.response.status, 201);
  await winRound(site, player, started.body);
  const next = await json(`${site.base}/game/next`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  await winRound(site, player, next.body);
  const blocked = await json(`${site.base}/game/cashout`, { method: "POST", body: JSON.stringify({ wallet: player.address, runId: started.body.runId }) });
  assert.equal(blocked.response.status, 503);
  assert.match(blocked.body.error, /payout ceiling/i);
  assert.equal(payouts, 0);
});

test("underfunded wallets cannot start the ladder", async t => {
  const site = await fixture({ getBalance: async () => 0n });
  t.after(async () => { await site.close(); fs.rmSync(site.directory, { recursive: true, force: true }); });
  const blocked = await start(site, ethers.Wallet.createRandom());
  assert.equal(blocked.response.status, 403);
  assert.match(blocked.body.error, /hold at least/i);
});
