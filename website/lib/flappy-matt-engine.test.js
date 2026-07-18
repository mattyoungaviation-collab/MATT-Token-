const assert = require("assert");
const engine = require("../public/flappy-matt-engine");
const { finalizeRound, leaderboardRows, newRound, parseTokenAmount } = require("./flappy-matt-rounds");

const seed = 123456;
const events = [0, 410, 840, 1260, 1690, 2120, 2550, 2980, 3410, 3840];
const first = engine.simulateRun(seed, events, 8_000);
const second = engine.simulateRun(seed, events, 8_000);
assert.deepStrictEqual(first, second, "replay must be deterministic");
assert.strictEqual(first.alive, false, "test run should collide");
assert.throws(() => engine.simulateRun(seed, [100, 50], 1_000), /ordered/);
assert.strictEqual(parseTokenAmount("100000"), 100000n * 10n ** 18n);

const round = newRound(Date.UTC(2026, 6, 18, 12));
round.potRaw = "10000000000000000000000000";
round.players = {
  a: { wallet: "0x0000000000000000000000000000000000000001", score: 10, achievedAt: 200, attempts: 1 },
  b: { wallet: "0x0000000000000000000000000000000000000002", score: 10, achievedAt: 100, attempts: 1 },
  c: { wallet: "0x0000000000000000000000000000000000000003", score: 8, achievedAt: 300, attempts: 1 }
};
const leaders = leaderboardRows(round);
assert.strictEqual(leaders[0].wallet.endsWith("2"), true, "earlier tied score should rank first");
const final = finalizeRound(round);
assert.strictEqual(final.winners[0].payoutRaw, "5000000000000000000000000");
assert.strictEqual(final.winners[1].payoutRaw, "3500000000000000000000000");
assert.strictEqual(final.winners[2].payoutRaw, "1500000000000000000000000");
console.log("Flappy MATT engine tests passed.");
