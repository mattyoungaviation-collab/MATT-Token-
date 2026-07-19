const express = require("express");
const crypto = require("crypto");
const { app: websiteApp } = require("./server-combined");

const app = express();
const port = process.env.PORT || 3000;
const BETTING_MS = 7_000;
const CRASHED_MS = 3_000;
const HOUSE_EDGE = 0.01;
const MAX_MULTIPLIER = 1_000;
const EPOCH = Date.UTC(2026, 6, 19, 0, 0, 0);
const SECRET = process.env.CRASH_SERVER_SECRET || "matt-crash-shared-rounds-v2";
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

function roundData(roundNumber) {
  const seed = sha256(`${SECRET}:round:${roundNumber}`);
  const commitment = sha256(seed);
  const crashPoint = crashFromSeed(seed, roundNumber);
  const flightMs = Math.max(250, multiplierToElapsed(crashPoint));
  return { roundNumber, seed, commitment, crashPoint, flightMs, cycleMs: BETTING_MS + flightMs + CRASHED_MS };
}

function locateRound(now = Date.now()) {
  let roundNumber = 1;
  let startAt = EPOCH;
  while (roundNumber < 1_000_000) {
    const data = roundData(roundNumber);
    if (now < startAt + data.cycleMs) break;
    startAt += data.cycleMs;
    roundNumber += 1;
  }

  const data = roundData(roundNumber);
  const elapsed = Math.max(0, now - startAt);
  let phase = "betting";
  let multiplier = 1;
  let phaseEndsAt = startAt + BETTING_MS;

  if (elapsed >= BETTING_MS && elapsed < BETTING_MS + data.flightMs) {
    phase = "flying";
    multiplier = Math.min(data.crashPoint, elapsedToMultiplier(elapsed - BETTING_MS));
    phaseEndsAt = startAt + BETTING_MS + data.flightMs;
  } else if (elapsed >= BETTING_MS + data.flightMs) {
    phase = "crashed";
    multiplier = data.crashPoint;
    phaseEndsAt = startAt + data.cycleMs;
  }

  return { ...data, startAt, phase, multiplier, phaseEndsAt, serverTime: now };
}

function deterministicBots(roundNumber) {
  const hash = sha256(`${SECRET}:bots:${roundNumber}`);
  const count = 5 + (Number.parseInt(hash.slice(0, 2), 16) % 5);
  return BOT_NAMES.slice(0, count).map((name, index) => {
    const offset = 2 + index * 6;
    const chunk = Number.parseInt(hash.slice(offset, offset + 6), 16);
    const bet = Math.round((20_000 + (chunk % 1_480_000)) / 1000) * 1000;
    const target = 1.08 + ((chunk % 10_000) / 10_000) ** 2.2 * 10;
    return { name, bet, target: Math.floor(target * 100) / 100 };
  });
}

function historyBefore(roundNumber, limit = 18) {
  const history = [];
  for (let current = roundNumber - 1; current >= 1 && history.length < limit; current -= 1) {
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
      number: current.roundNumber,
      phase: current.phase,
      multiplier: Math.floor(current.multiplier * 100) / 100,
      crashPoint: revealSeed ? current.crashPoint : null,
      commitment: current.commitment,
      seed: revealSeed ? current.seed : null,
      startAt: current.startAt,
      phaseEndsAt: current.phaseEndsAt
    },
    bots: deterministicBots(current.roundNumber),
    history: historyBefore(current.roundNumber)
  };
}

app.disable("x-powered-by");
app.get("/api/crash/state", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(publicState());
});
app.get("/api/crash/health", (_req, res) => res.json({ ok: true, version: 2, round: locateRound().roundNumber }));
app.use(websiteApp);

if (require.main === module) {
  app.listen(port, () => console.log(`MATT website with shared Crash rounds listening on ${port}`));
}

module.exports = { app, crashFromSeed, locateRound, publicState };
