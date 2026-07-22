const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { ethers } = require('ethers');
const { createCrashContractRouter } = require('./crash-routes-contract');

const CHAIN_ID = 2020n;
const VAULT = '0x2b7d130Bb4B026B9EAF045AcAc4E69238f2d2Fd3';
const OPERATOR = '0x' + '11'.repeat(32);

function wagerId(roundId, wallet) {
  return ethers.keccak256(ethers.solidityPacked(['uint256', 'address', 'bytes32', 'address'], [CHAIN_ID, VAULT, roundId, wallet]));
}
function state(roundId, startedAgo = 100) {
  return { counter: 1, current: { counter: 1, roundId, seed: ethers.hexlify(ethers.randomBytes(32)), commitment: ethers.ZeroHash, bettingClosesAt: Math.floor(Date.now()/1000)-1, commitBlock: 1, stage: 'flying', flightStartedAt: Date.now() - startedAgo, crashPointBps: 100000, crashedAt: 0, settled: false }, history: [], cashouts: {} };
}
async function fixture({ delayMs = 0, settled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-test-'));
  const stateFile = path.join(dir, 'state.json');
  const roundId = ethers.keccak256(ethers.toUtf8Bytes(`round-${Math.random()}`));
  fs.writeFileSync(stateFile, JSON.stringify(state(roundId), null, 2));
  const player = ethers.Wallet.createRandom();
  const id = wagerId(roundId, player.address);
  let wagerReads = 0;
  const vaultRead = {
    async wagers(requested) {
      wagerReads += 1;
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return requested === id ? { player: player.address, roundId, amount: 1000n, openedAt: 0n, settled } : { player: ethers.ZeroAddress, roundId, amount: 0n, openedAt: 0n, settled: false };
    }
  };
  const app = express();
  app.use('/api/crash', createCrashContractRouter({ vaultAddress: VAULT, tokenAddress: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d', operatorPrivateKey: OPERATOR, liveEnabled: false, stateFile, vaultRead, token: {}, provider: {}, vaultWrite: {} }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/crash`;
  async function json(route, init) { const res = await fetch(`${base}${route}`, init); const body = await res.json(); return { res, body }; }
  const challenge = await json('/session/challenge', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ wallet: player.address }) });
  const signature = await player.signMessage(challenge.body.message);
  const session = await json('/session', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ wallet: player.address, message: challenge.body.message, signature }) });
  assert.equal(session.res.status, 200);
  return { server, stateFile, roundId, player, id, token: session.body.token, json, get wagerReads(){ return wagerReads; } };
}

test('cash-out locks before delayed RPC and duplicates return the first multiplier', async () => {
  const fx = await fixture({ delayMs: 200 });
  const before = Date.now();
  const first = await fx.json('/cashout', { method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${fx.token}`}, body: JSON.stringify({ roundId: fx.roundId }) });
  const after = Date.now();
  assert.equal(first.res.status, 200);
  assert.ok(first.body.wallReceivedAt - before < 100, `locked too late after ${first.body.wallReceivedAt - before}ms`);
  assert.ok(after - before >= 190, 'test did not exercise delayed wager RPC');
  await new Promise(r => setTimeout(r, 150));
  const second = await fx.json('/cashout', { method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${fx.token}`}, body: JSON.stringify({ roundId: fx.roundId }) });
  assert.equal(second.res.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.cashoutBps, first.body.cashoutBps);
  fx.server.close();
});

test('round crash during pending RPC still honors the earlier locked cash-out after restart', async () => {
  const fx = await fixture({ delayMs: 150 });
  const p = fx.json('/cashout', { method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${fx.token}`}, body: JSON.stringify({ roundId: fx.roundId }) });
  await new Promise(r => setTimeout(r, 30));
  const saved = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  saved.current.crashPointBps = 10100;
  fs.writeFileSync(fx.stateFile, JSON.stringify(saved, null, 2));
  const first = await p;
  assert.equal(first.res.status, 200);
  fx.server.close();
  const persisted = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  assert.equal(persisted.cashouts[fx.id].cashoutBps, first.body.cashoutBps);
});

test('invalid session and wrong-wallet session are rejected from cashing out another wallet wager', async () => {
  const fx = await fixture();
  const invalid = await fx.json('/cashout', { method:'POST', headers:{'content-type':'application/json', authorization:'Bearer invalid'}, body: JSON.stringify({ roundId: fx.roundId }) });
  assert.equal(invalid.res.status, 401);
  const other = ethers.Wallet.createRandom();
  const c = await fx.json('/session/challenge', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ wallet: other.address }) });
  const s = await fx.json('/session', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ wallet: other.address, message: c.body.message, signature: await other.signMessage(c.body.message) }) });
  const wrong = await fx.json('/cashout', { method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${s.body.token}`}, body: JSON.stringify({ roundId: fx.roundId }) });
  assert.equal(wrong.res.status, 409);
  assert.equal(wrong.body.error, 'NO_OPEN_WAGER');
  fx.server.close();
});
