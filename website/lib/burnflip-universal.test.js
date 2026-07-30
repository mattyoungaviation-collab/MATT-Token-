const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const { Interface } = require("ethers");

const root = path.join(__dirname, "..", "..");
const gameAddress = "0x9999999999999999999999999999999999999999";
const player = "0x1111111111111111111111111111111111111111";
const water = "0x57A8Eb80d6813AEEEB9c8e770011C016F980d581";

function freshRequire(relativePath) {
  const absolute = path.join(root, relativePath);
  delete require.cache[require.resolve(absolute)];
  return require(absolute);
}

async function serve(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

test("frontend configuration uses verified asset identities and keeps unsafe NOTUS disabled", () => {
  const source = fs.readFileSync(
    path.join(root, "website", "public", "coin-game-config.js"),
    "utf8",
  );
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const config = context.window.MATT_COIN_FLIP_CONFIG;

  assert.equal(config.tokenAddress, "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d");
  assert.equal(config.version, "universal-v2-matt");
  assert.equal(config.contractAddress, "0x7d3F3e454638418D315c1A5a39C9E3c7ECeDBc99");
  assert.equal(config.deploymentBlock, 58953064);
  assert.equal(config.assets.length, 9);
  assert.deepEqual(
    Array.from(config.assets, (asset) => asset.symbol),
    ["RON", "MATT", "USDC", "WATER", "FIRE", "EARTH", "COIN", "RONKE", "NOTUS"],
  );
  const matt = config.assets.find((asset) => asset.symbol === "MATT");
  assert.equal(matt.address, config.tokenAddress);
  assert.equal(matt.decimals, 18);
  assert.equal(matt.enabled, true);
  const usdc = config.assets.find((asset) => asset.symbol === "USDC");
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.enabled, false);
  assert.equal(config.assets.find((asset) => asset.symbol === "NOTUS").enabled, false);
});

test("existing BurnFlip shell exposes universal quote, confirmation, and result fields", () => {
  const shell = fs.readFileSync(
    path.join(root, "website", "public", "burnflip-shell.js"),
    "utf8",
  );
  const controller = fs.readFileSync(
    path.join(root, "website", "src", "burnflip-controller.ts"),
    "utf8",
  );
  const loader = fs.readFileSync(
    path.join(root, "website", "public", "explorer-links.js"),
    "utf8",
  );
  const styles = fs.readFileSync(
    path.join(root, "website", "public", "burnflip.css"),
    "utf8",
  );

  for (const id of [
    "burnflip-asset",
    "burnflip-matt-value",
    "burnflip-payout",
    "burnflip-burn",
    "coin-wallet-balance",
    "burnflip-confirm-dialog",
    "burnflip-result-summary",
  ]) {
    assert.match(shell, new RegExp(id));
  }
  assert.match(controller, /quoteMatt/);
  assert.match(controller, /Treasury received/);
  assert.match(controller, /function outcomeFor/);
  assert.match(controller, /await animateOutcome\(outcome, betId\)/);
  assert.match(controller, /await showResult\(betId, settled\)/);
  assert.match(controller, /placeRonBet/);
  assert.match(shell, /burnflip-coin-heads/);
  assert.match(shell, /burnflip-coin-tails/);
  assert.match(styles, /backface-visibility:\s*hidden/);
  assert.doesNotMatch(loader, /coin-settlement-animation/);
  assert.match(loader, /coin-game-config\.js\?v=27/);
  assert.match(loader, /burnflip-controller\.js\?v=27/);
});

test("stats API reads universal BurnFlip counters from the configured deployment", async (t) => {
  process.env.BURNFLIP_CONTRACT_ADDRESS = gameAddress;
  process.env.BURNFLIP_DEPLOYMENT_BLOCK = "100";
  const readAbi = new Interface([
    "function totalMattBurned() view returns (uint256)",
    "function availableRewardBalance() view returns (uint256)",
    "function totalGames() view returns (uint256)",
    "function totalMattPaid() view returns (uint256)",
  ]);
  const values = {
    totalMattBurned: 937_500n * 10n ** 18n,
    availableRewardBalance: 9_000_000n * 10n ** 18n,
    totalGames: 7n,
    totalMattPaid: 2_500_000n * 10n ** 18n,
  };
  async function rpcRequest(method, params) {
    if (method === "eth_blockNumber") return "0x69";
    if (method === "eth_call") {
      const parsed = readAbi.parseTransaction({ data: params[0].data });
      return readAbi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    }
    throw new Error(`Unexpected RPC method ${method}`);
  }

  const { installBurnFlipStatsCache } = freshRequire("website/burnflip-stats-cache.js");
  const app = express();
  installBurnFlipStatsCache(app, { rpcRequest });
  const hosted = await serve(app);
  t.after(() => hosted.server.close());

  const response = await fetch(`${hosted.base}/api/burnflip-stats?fresh=1`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.totalGames, "7");
  assert.equal(body.totalBurnedRaw, values.totalMattBurned.toString());
  assert.equal(body.totalPaidRaw, values.totalMattPaid.toString());
  assert.equal(body.availableRewardRaw, values.availableRewardBalance.toString());
});

test("history API indexes universal asset, MATT value, payout, and burn fields", async (t) => {
  process.env.BURNFLIP_CONTRACT_ADDRESS = gameAddress;
  process.env.BURNFLIP_DEPLOYMENT_BLOCK = "100";
  const eventAbi = new Interface([
    "event GamePlayed(uint256 indexed betId,address indexed player,address indexed asset,uint256 wagerAmount,uint256 mattEquivalent,uint8 choice,uint8 outcome,bool won,bool expired,uint256 payoutAmount,uint256 burnAmount)",
  ]);
  const encoded = eventAbi.encodeEventLog(eventAbi.getEvent("GamePlayed"), [
    1n,
    player,
    water,
    500n * 10n ** 18n,
    1_250_000n * 10n ** 18n,
    0,
    0,
    true,
    false,
    2_500_000n * 10n ** 18n,
    937_500n * 10n ** 18n,
  ]);
  const log = {
    address: gameAddress,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: "0x65",
    logIndex: "0x0",
    transactionHash: `0x${"a".repeat(64)}`,
  };
  async function rpcRequest(method) {
    if (method === "eth_blockNumber") return "0x66";
    if (method === "eth_getLogs") return [log];
    if (method === "eth_getBlockByNumber") return { timestamp: "0x6b49d200" };
    throw new Error(`Unexpected RPC method ${method}`);
  }

  const { installBurnFlipHistoryIndex } = freshRequire("website/burnflip-history-index.js");
  const app = express();
  installBurnFlipHistoryIndex(app, { rpcRequest });
  const hosted = await serve(app);
  t.after(() => hosted.server.close());

  const response = await fetch(`${hosted.base}/api/burnflip/history/${player}?fresh=1`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.player.flips, 1);
  assert.equal(body.player.history[0].wagerAsset, water.toLowerCase());
  assert.equal(body.player.history[0].wagerAmountRaw, (500n * 10n ** 18n).toString());
  assert.equal(body.player.history[0].mattEquivalentRaw, (1_250_000n * 10n ** 18n).toString());
  assert.equal(body.player.history[0].payoutRaw, (2_500_000n * 10n ** 18n).toString());
  assert.equal(body.player.history[0].burnRaw, "0");
  assert.equal(body.player.history[0].netRaw, (1_250_000n * 10n ** 18n).toString());
});
