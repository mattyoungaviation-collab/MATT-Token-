const express = require("express");
const crypto = require("crypto");

const BETTING_MS = 7_000;
const CRASHED_MS = 3_000;
const HOUSE_EDGE = 0.01;
const MAX_MULTIPLIER = 1_000;
const BOT_NAMES = ["DynoKing", "LuckyMatt", "BurnBoss", "GoldMatt", "RoninRider", "MoonDyno", "MattLegend", "FlipMaster", "CraftLord"];

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function crashFromSeed(seed, roundNumber) {
  const hash = sha256(`${seed}:${roundNumber}:MATT-CRASH-V2`);
  const h = Number.parseInt(hash.slice(0, 13), 16);
  const e = 2 ** 52;
  const raw = Math.floor((((1 - HOUSE_EDGE) * e) / (e - h)) * 100) / 100;
  return clamp(Number.isFinite(raw) ? raw : 1, 1, MAX_MULTIPLIER);
}

function elapsedToMultiplier(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  return Math.exp(0.095 * seconds + 0.0062 * seconds * seconds);
}

function multiplierToElapsed(multiplier) {
  const target = Math.log(Math.max(1, multiplier));
  const a = 0.0062;
  const b = 0.095;
  return ((-b + Math.sqrt(b * b + 4 * a * target)) / (2 * a)) * 1000;
}

function createCrashEngine(options = {}) {
  const secret = String(options.secret || process.env.CRASH_SERVER_SECRET || crypto.randomBytes(32).toString("hex"));
  let roundNumber = 1;
  let roundStartAt = Date.now();

  function roundData(number) {
    const seed = sha256(`${secret}:round:${number}`);
    const commitment = sha256(seed);
    const crashPoint = crashFromSeed(seed, number);
    const flightMs = Math.max(250, multiplierToElapsed(crashPoint));
    return { number, seed, commitment, crashPoint, flightMs, cycleMs: BETTING_MS + flightMs + CRASHED_MS };
  }

  function locateRound(now = Date.now()) {
    let data = roundData(roundNumber);
    while (now >= roundStartAt + data.cycleMs) {
      roundStartAt += data.cycleMs;
      roundNumber += 1;
      data = roundData(roundNumber);
    }

    const elapsed = Math.max(0, now - roundStartAt);
    let phase = "betting";
    let multiplier = 1;
    let phaseEndsAt = roundStartAt + BETTING_MS;

    if (elapsed >= BETTING_MS && elapsed < BETTING_MS + data.flightMs) {
      phase = "flying";
      multiplier = Math.min(data.crashPoint, elapsedToMultiplier(elapsed - BETTING_MS));
      phaseEndsAt = roundStartAt + BETTING_MS + data.flightMs;
    } else if (elapsed >= BETTING_MS + data.flightMs) {
      phase = "crashed";
      multiplier = data.crashPoint;
      phaseEndsAt = roundStartAt + data.cycleMs;
    }

    return { ...data, startAt: roundStartAt, phase, multiplier, phaseEndsAt, serverTime: now };
  }

  function deterministicBots(number) {
    const hash = sha256(`${secret}:bots:${number}`);
    const count = 5 + (Number.parseInt(hash.slice(0, 2), 16) % 5);
    return BOT_NAMES.slice(0, count).map((name, index) => {
      const offset = 2 + index * 6;
      const chunk = Number.parseInt(hash.slice(offset, offset + 6), 16);
      const bet = Math.round((20_000 + (chunk % 1_480_000)) / 1000) * 1000;
      const target = 1.08 + ((chunk % 10_000) / 10_000) ** 2.2 * 10;
      return { name, bet, target: Math.floor(target * 100) / 100 };
    });
  }

  function historyBefore(number, limit = 18) {
    const history = [];
    for (let current = number - 1; current >= 1 && history.length < limit; current -= 1) {
      const data = roundData(current);
      history.push({ roundNumber: current, crashPoint: data.crashPoint, commitment: data.commitment, seed: data.seed });
    }
    return history;
  }

  function publicState() {
    const current = locateRound();
    const revealSeed = current.phase === "crashed";
    return {
      version: 2,
      mode: "FREE_PLAY_SHARED",
      serverTime: current.serverTime,
      round: {
        number: current.number,
        phase: current.phase,
        multiplier: Math.floor(current.multiplier * 100) / 100,
        crashPoint: revealSeed ? current.crashPoint : null,
        commitment: current.commitment,
        seed: revealSeed ? current.seed : null,
        startAt: current.startAt,
        phaseEndsAt: current.phaseEndsAt
      },
      bots: deterministicBots(current.number),
      history: historyBefore(current.number)
    };
  }

  return { locateRound, publicState };
}

function createCrashRouter(options = {}) {
  const router = express.Router();
  const engine = createCrashEngine(options);

  router.get("/state", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(engine.publicState());
  });

  router.get("/health", (_req, res) => {
    const round = engine.locateRound();
    res.json({ ok: true, version: 2, mode: "FREE_PLAY_SHARED", round: round.number, phase: round.phase });
  });

  return router;
}

module.exports = { createCrashRouter, createCrashEngine, crashFromSeed };
