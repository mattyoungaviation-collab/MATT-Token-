(function attachFlappyMattEngine(root, factory) {
  const engine = factory();
  if (typeof module === "object" && module.exports) module.exports = engine;
  if (root) root.FlappyMattEngine = engine;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFlappyMattEngine() {
  "use strict";

  const CONFIG = Object.freeze({
    width: 420,
    height: 680,
    birdX: 96,
    birdRadius: 15,
    startY: 306,
    gravity: 1_520,
    flapVelocity: -470,
    pipeSpeed: 158,
    pipeWidth: 66,
    pipeGap: 154,
    pipeSpacing: 218,
    firstPipeX: 520,
    minGapCenter: 178,
    maxGapCenter: 502,
    floorHeight: 54,
    stepMs: 1000 / 120,
    maxDurationMs: 900_000,
    maxFlaps: 6_000
  });

  function normalizeSeed(value) {
    const parsed = Number(value) >>> 0;
    return parsed || 0x6d2b79f5;
  }

  function mulberry32(seedValue) {
    let seed = normalizeSeed(seedValue);
    return function random() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function validateEvents(eventsValue) {
    if (!Array.isArray(eventsValue)) throw new Error("Flap events must be an array.");
    if (eventsValue.length > CONFIG.maxFlaps) throw new Error("Too many flap events.");
    const events = [];
    let previous = -1;
    for (const value of eventsValue) {
      const eventMs = Number(value);
      if (!Number.isSafeInteger(eventMs) || eventMs < 0 || eventMs > CONFIG.maxDurationMs) {
        throw new Error("Flap events contain an invalid timestamp.");
      }
      if (eventMs < previous) throw new Error("Flap events must be ordered.");
      events.push(eventMs);
      previous = eventMs;
    }
    return events;
  }

  function createRuntime(seedValue) {
    const seed = normalizeSeed(seedValue);
    const random = mulberry32(seed);
    const gapCenters = [];
    const state = {
      seed,
      timeMs: 0,
      birdY: CONFIG.startY,
      velocityY: 0,
      score: 0,
      alive: true,
      collision: null,
      pendingMs: 0
    };

    function gapCenter(index) {
      while (gapCenters.length <= index) {
        const span = CONFIG.maxGapCenter - CONFIG.minGapCenter;
        gapCenters.push(CONFIG.minGapCenter + random() * span);
      }
      return gapCenters[index];
    }

    function pipeX(index) {
      return CONFIG.firstPipeX + index * CONFIG.pipeSpacing - CONFIG.pipeSpeed * (state.timeMs / 1000);
    }

    function visiblePipes() {
      const pipes = [];
      const furthest = Math.max(3, Math.ceil((CONFIG.pipeSpeed * (state.timeMs / 1000) + CONFIG.width + CONFIG.pipeSpacing) / CONFIG.pipeSpacing));
      for (let index = 0; index <= furthest; index += 1) {
        const x = pipeX(index);
        if (x > CONFIG.width + CONFIG.pipeWidth || x + CONFIG.pipeWidth < -4) continue;
        pipes.push({ index, x, gapCenter: gapCenter(index) });
      }
      return pipes;
    }

    function detectCollision() {
      const top = state.birdY - CONFIG.birdRadius;
      const bottom = state.birdY + CONFIG.birdRadius;
      if (top <= 0) return "ceiling";
      if (bottom >= CONFIG.height - CONFIG.floorHeight) return "floor";

      const furthest = Math.max(3, Math.ceil((CONFIG.pipeSpeed * (state.timeMs / 1000) + CONFIG.width + CONFIG.pipeSpacing) / CONFIG.pipeSpacing));
      for (let index = 0; index <= furthest; index += 1) {
        const x = pipeX(index);
        const overlaps = CONFIG.birdX + CONFIG.birdRadius > x && CONFIG.birdX - CONFIG.birdRadius < x + CONFIG.pipeWidth;
        if (!overlaps) continue;
        const center = gapCenter(index);
        const gapTop = center - CONFIG.pipeGap / 2;
        const gapBottom = center + CONFIG.pipeGap / 2;
        if (top < gapTop || bottom > gapBottom) return `pipe:${index}`;
      }
      return null;
    }

    function updateScore() {
      let passed = 0;
      const furthest = Math.max(0, Math.ceil((CONFIG.pipeSpeed * (state.timeMs / 1000) + CONFIG.width) / CONFIG.pipeSpacing));
      for (let index = 0; index <= furthest; index += 1) {
        if (pipeX(index) + CONFIG.pipeWidth < CONFIG.birdX - CONFIG.birdRadius) passed += 1;
      }
      state.score = Math.max(state.score, passed);
    }

    function step() {
      if (!state.alive) return;
      const dt = CONFIG.stepMs / 1000;
      state.velocityY += CONFIG.gravity * dt;
      state.birdY += state.velocityY * dt;
      state.timeMs += CONFIG.stepMs;
      updateScore();
      const collision = detectCollision();
      if (collision) {
        state.alive = false;
        state.collision = collision;
      }
    }

    function advance(deltaMs) {
      if (!state.alive) return snapshot();
      state.pendingMs += Math.max(0, Number(deltaMs) || 0);
      while (state.alive && state.pendingMs + 0.0001 >= CONFIG.stepMs && state.timeMs < CONFIG.maxDurationMs) {
        state.pendingMs -= CONFIG.stepMs;
        step();
      }
      if (state.timeMs >= CONFIG.maxDurationMs && state.alive) {
        state.alive = false;
        state.collision = "time-limit";
      }
      return snapshot();
    }

    function flap() {
      if (!state.alive) return false;
      state.velocityY = CONFIG.flapVelocity;
      return true;
    }

    function snapshot() {
      return {
        seed: state.seed,
        timeMs: Math.round(state.timeMs),
        birdY: state.birdY,
        velocityY: state.velocityY,
        score: state.score,
        alive: state.alive,
        collision: state.collision,
        pipes: visiblePipes()
      };
    }

    return { advance, flap, snapshot };
  }

  function simulateRun(seedValue, eventsValue, durationValue) {
    const events = validateEvents(eventsValue);
    const durationMs = Number(durationValue);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > CONFIG.maxDurationMs) {
      throw new Error("Run duration is invalid.");
    }

    const runtime = createRuntime(seedValue);
    let cursor = 0;
    while (runtime.snapshot().alive && runtime.snapshot().timeMs < durationMs) {
      const state = runtime.snapshot();
      while (cursor < events.length && events[cursor] <= state.timeMs) {
        runtime.flap();
        cursor += 1;
      }
      runtime.advance(CONFIG.stepMs);
    }
    const result = runtime.snapshot();
    return {
      score: result.score,
      durationMs: result.timeMs,
      alive: result.alive,
      collision: result.collision,
      consumedFlaps: cursor,
      totalFlaps: events.length
    };
  }

  return Object.freeze({ CONFIG, createRuntime, simulateRun, validateEvents, normalizeSeed });
});
