const assert = require("node:assert/strict");
const engine = require("../public/plinko-v2-engine");

assert.equal(engine.ROWS, 16);
assert.equal(engine.SLOT_COUNT, 17);
assert.deepEqual(engine.MULTIPLIERS, [
  200, 162, 38, 9, 3, 1.5, 0.5, 0.25, 0.1,
  0.25, 0.5, 1.5, 3, 9, 38, 162, 200
]);
assert.equal(engine.boardRtp(), 0.9738616943359375);

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

assert.equal(engine.payoutForSlot(0), 2_000_000);
assert.equal(engine.payoutForSlot(8), 1_000);
assert.throws(() => engine.stepsForSlot(17, "bad"), RangeError);
assert.throws(() => engine.slotForSteps([1, -1]), RangeError);
assert.throws(() => engine.pathFrame([], 0), RangeError);

console.log("Plinko V2 visual/result engine tests passed.");
