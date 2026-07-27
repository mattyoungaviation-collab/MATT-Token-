const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Interface } = require("ethers");
const {
  CONTRACT,
  DEPLOYMENT_BLOCK,
  decodeSlots,
  installPlinkoHistoryIndex
} = require("../plinko-history-index");

const ABI = [
  "event BatchSettled(bytes32 indexed requestHash,address indexed player,uint8 coinCount,uint256 payout,uint256 packedSlotsA,uint256 packedSlotsB)"
];
const iface = new Interface(ABI);
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";
const coin = 10_000n * 10n ** 18n;

function packed(slots) {
  let a = 0n;
  let b = 0n;
  slots.forEach((slot, index) => {
    if (index < 51) a |= BigInt(slot) << (BigInt(index) * 5n);
    else b |= BigInt(slot) << (BigInt(index - 51) * 5n);
  });
  return [a, b];
}

function eventLog({ requestHash, player, slots, payout, blockNumber, logIndex }) {
  const [packedA, packedB] = packed(slots);
  const event = iface.encodeEventLog(iface.getEvent("BatchSettled"), [
    requestHash, player, slots.length, payout, packedA, packedB
  ]);
  return {
    address: CONTRACT,
    topics: event.topics,
    data: event.data,
    blockNumber: `0x${blockNumber.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: `0x${String(logIndex + 10).padStart(64, "0")}`
  };
}

async function fixture({ logDelayMs = 0 } = {}) {
  const latest = DEPLOYMENT_BLOCK + 8;
  const logs = [
    eventLog({
      requestHash: `0x${"a".repeat(64)}`,
      player: alice,
      slots: [0, 8],
      payout: 504_848n * 10n ** 18n,
      blockNumber: DEPLOYMENT_BLOCK + 2,
      logIndex: 0
    }),
    eventLog({
      requestHash: `0x${"b".repeat(64)}`,
      player: bob,
      slots: [8],
      payout: 4_848n * 10n ** 18n,
      blockNumber: DEPLOYMENT_BLOCK + 3,
      logIndex: 1
    })
  ];
  async function rpcRequest(method, params) {
    if (method === "eth_blockNumber") return `0x${latest.toString(16)}`;
    if (method === "eth_getLogs") {
      if (logDelayMs) await new Promise(resolve => setTimeout(resolve, logDelayMs));
      const from = Number(BigInt(params[0].fromBlock));
      const to = Number(BigInt(params[0].toBlock));
      return logs.filter(log => {
        const block = Number(BigInt(log.blockNumber));
        return block >= from && block <= to;
      });
    }
    if (method === "eth_getBlockByNumber") {
      return { timestamp: `0x${(1_800_000_000 + Number(BigInt(params[0])) - DEPLOYMENT_BLOCK).toString(16)}` };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  }
  const profiles = {
    getUsername(wallet) {
      return wallet.toLowerCase() === alice ? "AlphaMatt" : wallet.toLowerCase() === bob ? "BobDrops" : null;
    }
  };
  const app = express();
  installPlinkoHistoryIndex(app, { rpcRequest, profiles });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function json(route) {
    const response = await fetch(`${base}${route}`);
    return { response, body: await response.json() };
  }
  return { server, json };
}

test("decodes both packed Plinko slot words", () => {
  const slots = Array.from({ length: 100 }, (_, index) => index % 17);
  const [a, b] = packed(slots);
  assert.deepEqual(decodeSlots(100, a, b), slots);
});

test("indexes confirmed batches, resolves names, filters, and returns history", async t => {
  const fx = await fixture();
  t.after(() => fx.server.close());

  let board;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    board = await fx.json("/api/plinko/leaderboard?sort=net-desc&minCoins=1");
    if (board.body.status === "READY") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(board.response.status, 200);
  assert.equal(board.body.status, "READY");
  assert.equal(board.body.totalPlayers, 2);
  assert.equal(board.body.totalBatches, 2);
  assert.equal(board.body.totalCoins, 3);
  assert.equal(board.body.players[0].username, "AlphaMatt");
  assert.equal(board.body.players[0].winningCoins, 1);
  assert.equal(board.body.players[0].losingCoins, 1);
  assert.equal(board.body.players[1].username, "BobDrops");

  const byName = await fx.json("/api/plinko/leaderboard?search=alphamatt");
  assert.equal(byName.body.totalPlayers, 1);
  assert.equal(byName.body.players[0].wallet, alice);

  const history = await fx.json(`/api/plinko/history/${alice}?limit=100`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.player.username, "AlphaMatt");
  assert.equal(history.body.player.batches, 1);
  assert.equal(history.body.player.coins, 2);
  assert.deepEqual(history.body.player.history[0].slots, [0, 8]);
  assert.equal(history.body.player.history[0].netRaw, (484_848n * 10n ** 18n).toString());
});

test("returns an indexing snapshot without blocking a cold-start history scan", async t => {
  const fx = await fixture({ logDelayMs: 250 });
  t.after(() => fx.server.close());
  const startedAt = Date.now();
  const first = await fx.json("/api/plinko/leaderboard?limit=3");
  assert.equal(first.response.status, 200);
  assert.equal(first.body.status, "INDEXING");
  assert.ok(Date.now() - startedAt < 150, "cold-start response waited for the background scan");
  await new Promise(resolve => setTimeout(resolve, 300));
  const ready = await fx.json("/api/plinko/leaderboard?limit=3");
  assert.equal(ready.body.status, "READY");
  assert.equal(ready.body.totalBatches, 2);
});
