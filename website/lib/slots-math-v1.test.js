"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const math = require("./slots-math-v1");
const config = require("../../config/slots.math.v1.json");

test("uses five 64-stop reels and twenty fixed paylines", () => {
  assert.equal(math.REELS.length, 5);
  assert.ok(math.REELS.every(reel => reel.length === 64));
  assert.equal(math.LINES.length, 20);
  assert.ok(math.LINES.every(line => line.length === 5 && line.every(row => row >= 0 && row <= 2)));
});

test("packs and unpacks the exact 5x3 source-of-truth grid", () => {
  const grid = math.gridFromStops([0, 7, 19, 31, 44]);
  assert.deepEqual(math.unpackGrid(math.packGrid(grid)), grid);
});

test("the Golden MATT wild substitutes but the Treasury Vault does not", () => {
  assert.equal(math.lineWinBps([8, 8, 7, 7, 7]), math.LINE_PAYS_BPS[7 * 3 + 2]);
  assert.equal(math.lineWinBps([7, 8, 7, 0, 0]), math.LINE_PAYS_BPS[7 * 3]);
  assert.equal(math.lineWinBps([7, 9, 7, 7, 7]), 0);
});

test("three, four, and five vaults award 10, 15, and 25 free spins", () => {
  for (const [count, expected] of [[3, 10], [4, 15], [5, 25]]) {
    const grid = Array.from({ length: 5 }, () => [0, 1, 2]);
    for (let index = 0; index < count; index += 1) grid[index][0] = 9;
    assert.equal(math.evaluateGrid(grid).freeSpins, expected);
  }
});

test("caps any individual displayed result at 500x", () => {
  const grid = Array.from({ length: 5 }, () => [8, 8, 8]);
  assert.equal(math.evaluateGrid(grid).multiplierBps, math.MAX_MULTIPLIER_BPS);
});

test("JSON deployment config exactly mirrors the tested browser math", () => {
  assert.deepEqual(config.linePaysBps, math.LINE_PAYS_BPS);
  assert.deepEqual(config.scatterPaysBps, math.SCATTER_PAYS_BPS);
  assert.deepEqual(config.bonusAwards, math.BONUS_AWARDS);
  assert.deepEqual(config.retriggerAwards, math.RETRIGGER_AWARDS);
  assert.equal(config.maximumMultiplierBps, math.MAX_MULTIPLIER_BPS);
  assert.deepEqual(config.packedReels.map(value => BigInt(value)), math.REELS.map(reel =>
    reel.reduce((packed, symbol, index) => packed | (BigInt(symbol) << BigInt(index * 4)), 0n)
  ));
});

test("simulation is deterministic for the published MATT seed", () => {
  assert.deepEqual(math.simulate(25_000, 0x4d415454), math.simulate(25_000, 0x4d415454));
});

test("working V1 simulation remains near the declared 97 percent target", () => {
  const result = math.simulate(250_000, 0x4d415454);
  assert.ok(result.rtp > 0.94 && result.rtp < 1.00, `RTP ${result.rtp}`);
  assert.ok(result.anyReturnRate > 0.35 && result.anyReturnRate < 0.45);
  assert.ok(result.bonusFrequency > 80 && result.bonusFrequency < 150);
});
