const assert = require("node:assert/strict");
const engine = require("../public/plinko-v4-engine");

assert.equal(engine.ROWS, 16);
assert.equal(engine.SLOT_COUNT, 17);
assert.deepEqual(engine.MULTIPLIERS, [
  50, 25, 10.0174, 5, 2, 1.5, 0.8, 0.7, 0.4848,
  0.7, 0.8, 1.5, 2, 5, 10.0174, 25, 50
]);
assert.ok(Math.abs(engine.boardRtp() - 0.982) < Number.EPSILON);

for (let slot = 0; slot < engine.SLOT_COUNT; slot += 1) {
  for (let sample = 0; sample < 50; sample += 1) {
    const steps = engine.stepsForSlot(slot, `slot-${slot}-sample-${sample}`);
    assert.equal(steps.length, 16);
    assert.equal(engine.slotForSteps(steps), slot);
    assert.equal(engine.finalOffsetForSteps(steps), engine.slotOffset(slot));

    const path = engine.pathForSlot(slot, `path-${slot}-${sample}`, {
      center: 500,
      top: 70,
      rowGap: 25,
      slotGap: 40,
      landingY: 520
    });
    assert.equal(path.slot, slot);
    assert.equal(path.points.length, 19);
    assert.equal(path.points[0].x, 500);
    assert.ok(path.points[0].y < 0);
    assert.equal(path.points[1].x, 500);
    assert.ok(path.points[1].y < 70);
    assert.equal(path.points.at(-1).x, 500 + engine.slotOffset(slot) * 40);
    assert.equal(path.points.at(-1).y, 520);

    const earlyFrame = engine.pathFrame(path.points, -0.01);
    assert.equal(earlyFrame.progress, 0);
    assert.equal(earlyFrame.segment, 0);
    assert.equal(earlyFrame.local, 0);
    assert.equal(earlyFrame.from, path.points[0]);
    assert.equal(earlyFrame.to, path.points[1]);

    const finalFrame = engine.pathFrame(path.points, 1.01);
    assert.equal(finalFrame.progress, 1);
    assert.equal(finalFrame.segment, path.points.length - 2);
    assert.equal(finalFrame.local, 1);
    assert.equal(finalFrame.to, path.points.at(-1));
  }
}

assert.equal(engine.payoutForSlot(0), 500_000);
assert.equal(engine.payoutForSlot(2), 100_174);
assert.equal(engine.payoutForSlot(8), 4_848);
assert.equal(
  engine.revealedClaimableWei(25_000n * 10n ** 18n, 11_000),
  36_000n * 10n ** 18n
);
assert.throws(() => engine.revealedClaimableWei(0n, -1), RangeError);
assert.equal(engine.isBatchRevealComplete(1, 100), false);
assert.equal(engine.isBatchRevealComplete(99, 100), false);
assert.equal(engine.isBatchRevealComplete(100, 100), true);
assert.throws(() => engine.isBatchRevealComplete(101, 100), RangeError);
assert.throws(() => engine.stepsForSlot(17, "bad"), RangeError);
assert.throws(() => engine.slotForSteps([1, -1]), RangeError);
assert.throws(() => engine.pathFrame([], 0), RangeError);

console.log("Plinko V4 visual/result engine tests passed.");
