(function (root, factory) {
  const engine = factory();
  if (typeof module === "object" && module.exports) module.exports = engine;
  if (root) root.MattPlinkoV2Engine = engine;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROWS = 16;
  const SLOT_COUNT = 17;
  const COIN_PRICE = 10_000;
  const MULTIPLIERS = Object.freeze([
    200, 162, 38, 9, 3, 1.5, 0.5, 0.25, 0.1,
    0.25, 0.5, 1.5, 3, 9, 38, 162, 200
  ]);
  const COMBINATIONS = Object.freeze([
    1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870,
    11440, 8008, 4368, 1820, 560, 120, 16, 1
  ]);

  function assertSlot(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
      throw new RangeError(`Invalid Plinko slot ${slot}.`);
    }
  }

  function hash32(value) {
    const text = String(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    }
    return hash >>> 0;
  }

  function nextRandom(state) {
    let value = state >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  }

  function stepsForSlot(slot, key) {
    assertSlot(slot);
    const steps = Array(slot).fill(1).concat(Array(ROWS - slot).fill(-1));
    let randomState = hash32(key) || 0x9e3779b9;
    for (let index = steps.length - 1; index > 0; index -= 1) {
      randomState = nextRandom(randomState);
      const swapIndex = randomState % (index + 1);
      [steps[index], steps[swapIndex]] = [steps[swapIndex], steps[index]];
    }
    return steps;
  }

  function slotForSteps(steps) {
    if (!Array.isArray(steps) || steps.length !== ROWS) {
      throw new RangeError("A visual path must contain exactly sixteen peg decisions.");
    }
    return steps.reduce((rights, direction) => {
      if (direction !== -1 && direction !== 1) {
        throw new RangeError("Every peg decision must be left (-1) or right (1).");
      }
      return rights + (direction === 1 ? 1 : 0);
    }, 0);
  }

  function finalOffsetForSteps(steps) {
    return steps.reduce((offset, direction) => offset + direction / 2, 0);
  }

  function slotOffset(slot) {
    assertSlot(slot);
    return slot - ROWS / 2;
  }

  function multiplierForSlot(slot) {
    assertSlot(slot);
    return MULTIPLIERS[slot];
  }

  function payoutForSlot(slot) {
    return COIN_PRICE * multiplierForSlot(slot);
  }

  function boardRtp() {
    const weighted = COMBINATIONS.reduce(
      (sum, combinations, slot) => sum + combinations * MULTIPLIERS[slot],
      0
    );
    return weighted / (2 ** ROWS);
  }

  function pathForSlot(slot, key, geometry) {
    const { center, top, rowGap, slotGap, landingY } = geometry;
    const steps = stepsForSlot(slot, key);
    // Every coin begins completely above the canvas, then enters through the
    // same centered launch chute before making its first peg decision.
    const points = [
      { x: center, y: -24 },
      { x: center, y: Math.max(12, top - rowGap * 0.72) }
    ];
    let x = center;
    for (let row = 0; row < ROWS; row += 1) {
      x += steps[row] * slotGap / 2;
      points.push({ x, y: top + row * rowGap + rowGap * 0.58 });
    }
    points.push({ x: center + slotOffset(slot) * slotGap, y: landingY });
    return { steps, points, slot };
  }

  return Object.freeze({
    ROWS,
    SLOT_COUNT,
    COIN_PRICE,
    MULTIPLIERS,
    COMBINATIONS,
    hash32,
    nextRandom,
    stepsForSlot,
    slotForSteps,
    finalOffsetForSteps,
    slotOffset,
    multiplierForSlot,
    payoutForSlot,
    boardRtp,
    pathForSlot
  });
});
