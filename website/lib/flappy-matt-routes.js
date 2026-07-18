const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createFlappyMattAuth } = require("./flappy-matt-auth");
const { simulateRun } = require("../public/flappy-matt-engine");
const { newRound, leaderboardRows, finalizeRound, publicRound, parseTokenAmount, formatUnits } = require("./flappy-matt-rounds");

const MATT_ADDRESS = String(process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d").toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RUN_MAX_MS = 120_000;
const RUN_MIN_TIME_LEFT_MS = 15_000;
const HISTORY_LIMIT = 14;
const USED_TX_LIMIT = 25_000;

function createFlappyMattRouter(options = {}) {
  const router = express.Router();
  const auth = createFlappyMattAuth();
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("Flappy MATT requires rpcRequest");

  const stateFile = String(options.stateFile || process.env.FLAPPY_MATT_STATE_FILE || "").trim();
  const entryRaw = parseTokenAmount(process.env.FLAPPY_MATT_ENTRY_MATT || "100000");
  const potAddress = normalizeOptionalAddress(process.env.FLAPPY_MATT_POT_ADDRESS);
  const paidMode = Boolean(potAddress && entryRaw > 0n);
  const state = loadState(stateFile) || freshState(Date.now());
  const requestTimes = new Map();

  router.use(express.json({ limit: "32kb", strict: true }));

  router.get("/config", (_req, res) => {
    rolloverIfNeeded();
    res.set("Cache-Control", "no-store");
    res.json({
      mode: paidMode ? "PAID" : "PRACTICE",
      mattAddress: MATT_ADDRESS,
      potAddress,
      entryRaw: entryRaw.toString(),
      entryMatt: formatUnits(entryRaw),
      payoutSplit: { first: 50, second: 35, third: 15 },
      round: publicRound(state.round),
      notice: paidMode
        ? "Each verified play adds its MATT entry to the current 24 hour prize pot. Payouts are recorded for manual treasury settlement until the dedicated payout contract is deployed."
        : "Practice mode is active. Set FLAPPY_MATT_POT_ADDRESS to enable paid entries and the prize leaderboard."
    });
  });

  router.get("/leaderboard", (_req, res) => {
    rolloverIfNeeded();
    res.set("Cache-Control", "no-store");
    res.json({ round: publicRound(state.round), leaders: leaderboardRows(state.round), previous: state.history[0] || null });
  });

  router.get("/history", (_req, res) => {
    rolloverIfNeeded();
    res.set("Cache-Control", "no-store");
    res.json({ rounds: state.history.slice(0, HISTORY_LIMIT) });
  });

  router.post("/auth/challenge", (req, res) => {
    try { res.json(auth.issueChallenge(req.body.wallet)); }
    catch (error) { authError(res, error); }
  });

  router.post("/auth/verify", (req, res) => {
    try { res.json(auth.verify(req.body.wallet, req.body.signature)); }
    catch (error) { authError(res, error); }
  });

  router.post("/auth/logout", (req, res) => {
    auth.revoke(req);
    res.json({ ok: true });
  });

  router.post("/run/start", async (req, res) => {
    try {
      rolloverIfNeeded();
      const { wallet } = auth.authenticate(req);
      enforceCooldown(wallet);
      const timeLeft = state.round.endsAt - Date.now();
      if (timeLeft < RUN_MIN_TIME_LEFT_MS) throw new Error("This round is closing. Start again after the leaderboard resets.");

      removeExpiredRuns();
      const existing = Object.values(state.activeRuns).find(run => run.wallet === wallet && run.expiresAt > Date.now());
      if (existing) throw new Error("Finish your current Flappy MATT run before starting another.");

      let paidRaw = 0n;
      let txHash = null;
      if (paidMode) {
        txHash = normalizeTxHash(req.body.txHash);
        if (state.usedTransactions[txHash]) throw new Error("That payment transaction has already been used for a Flappy MATT run.");
        const payment = await verifyEntryPayment({ rpcRequest, txHash, wallet, potAddress, minimumRaw: entryRaw, round: state.round });
        paidRaw = payment.amountRaw;
        state.usedTransactions[txHash] = { wallet, amountRaw: paidRaw.toString(), acceptedAt: Date.now(), roundId: state.round.id };
        trimUsedTransactions();
        state.round.potRaw = (BigInt(state.round.potRaw) + paidRaw).toString();
        state.round.entries += 1;
      }

      const now = Date.now();
      const runId = crypto.randomUUID();
      const expiresAt = Math.min(now + RUN_MAX_MS + 15_000, state.round.endsAt);
      const run = {
        id: runId,
        wallet,
        roundId: state.round.id,
        seed: crypto.randomBytes(4).readUInt32BE(0),
        createdAt: now,
        expiresAt,
        paidRaw: paidRaw.toString(),
        txHash,
        eligible: paidMode
      };
      state.activeRuns[runId] = run;
      saveState(stateFile, state);
      res.json({
        runId,
        seed: run.seed,
        createdAt: run.createdAt,
        expiresAt: run.expiresAt,
        roundId: run.roundId,
        eligible: run.eligible,
        potRaw: state.round.potRaw
      });
    } catch (error) {
      actionError(res, error);
    }
  });

  router.post("/run/finish", (req, res) => {
    try {
      rolloverIfNeeded();
      const { wallet } = auth.authenticate(req);
      const runId = String(req.body.runId || "");
      const run = state.activeRuns[runId];
      if (!run || run.wallet !== wallet) throw new Error("This Flappy MATT run was not found.");
      if (run.expiresAt < Date.now()) {
        delete state.activeRuns[runId];
        saveState(stateFile, state);
        throw new Error("This run expired before it was submitted.");
      }
      if (run.roundId !== state.round.id) throw new Error("The leaderboard reset before this run finished.");

      const durationMs = Number(req.body.durationMs);
      const result = simulateRun(run.seed, req.body.events, durationMs);
      if (result.alive) throw new Error("The submitted run did not end in a collision.");
      if (result.totalFlaps !== result.consumedFlaps) throw new Error("The submitted run contains flap events after the collision.");

      delete state.activeRuns[runId];
      let rank = null;
      let personalBest = null;
      let improved = false;
      if (run.eligible) {
        const previous = state.round.players[wallet];
        const attempts = Number(previous?.attempts || 0) + 1;
        const achievedAt = Date.now();
        if (!previous || result.score > previous.score) {
          state.round.players[wallet] = {
            wallet,
            score: result.score,
            attempts,
            achievedAt,
            lastPlayedAt: achievedAt,
            totalPaidRaw: (BigInt(previous?.totalPaidRaw || "0") + BigInt(run.paidRaw)).toString()
          };
          improved = true;
        } else {
          previous.attempts = attempts;
          previous.lastPlayedAt = achievedAt;
          previous.totalPaidRaw = (BigInt(previous.totalPaidRaw || "0") + BigInt(run.paidRaw)).toString();
        }
        const leaders = leaderboardRows(state.round);
        const mine = leaders.find(row => row.wallet === wallet);
        rank = mine?.rank || null;
        personalBest = state.round.players[wallet]?.score ?? null;
      }

      saveState(stateFile, state);
      res.json({
        ok: true,
        eligible: run.eligible,
        score: result.score,
        durationMs: result.durationMs,
        collision: result.collision,
        improved,
        personalBest,
        rank,
        round: publicRound(state.round),
        leaders: leaderboardRows(state.round).slice(0, 10)
      });
    } catch (error) {
      actionError(res, error);
    }
  });

  function rolloverIfNeeded(now = Date.now()) {
    if (state.round && now < state.round.endsAt) return;
    if (state.round) state.history.unshift(finalizeRound(state.round));
    state.history = state.history.slice(0, HISTORY_LIMIT);
    state.round = newRound(now);
    state.activeRuns = {};
    saveState(stateFile, state);
  }

  function enforceCooldown(wallet) {
    const now = Date.now();
    const previous = requestTimes.get(wallet) || 0;
    if (now - previous < 1_200) throw new Error("Please wait a moment before starting another run.");
    requestTimes.set(wallet, now);
  }

  function removeExpiredRuns() {
    const now = Date.now();
    for (const [runId, run] of Object.entries(state.activeRuns)) if (run.expiresAt <= now) delete state.activeRuns[runId];
  }

  function trimUsedTransactions() {
    const rows = Object.entries(state.usedTransactions);
    if (rows.length <= USED_TX_LIMIT) return;
    rows.sort((a, b) => Number(a[1].acceptedAt || 0) - Number(b[1].acceptedAt || 0));
    for (const [txHash] of rows.slice(0, rows.length - USED_TX_LIMIT)) delete state.usedTransactions[txHash];
  }

  return router;
}

async function verifyEntryPayment({ rpcRequest, txHash, wallet, potAddress, minimumRaw, round }) {
  const receipt = await rpcRequest("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("The MATT entry transaction is not confirmed yet.");
  if (BigInt(receipt.status || "0x0") !== 1n) throw new Error("The MATT entry transaction failed on Ronin.");
  const block = await rpcRequest("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const paidAt = Number(BigInt(block?.timestamp || "0x0")) * 1000;
  if (!paidAt || paidAt < round.startsAt || paidAt >= round.endsAt) throw new Error("The MATT entry payment must be confirmed during the current leaderboard round.");

  let amountRaw = 0n;
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== MATT_ADDRESS) continue;
    if (String(log.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(log.topics?.[1]);
    const to = topicAddress(log.topics?.[2]);
    if (from === wallet && to === potAddress) amountRaw += BigInt(log.data || "0x0");
  }
  if (amountRaw < minimumRaw) throw new Error(`Send at least ${formatUnits(minimumRaw)} MATT to enter this run.`);
  return { amountRaw, paidAt };
}

function freshState(now) {
  return { version: 1, round: newRound(now), history: [], activeRuns: {}, usedTransactions: {} };
}

function normalizeOptionalAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

function normalizeTxHash(value) {
  const txHash = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error("A valid Ronin transaction hash is required for this run.");
  return txHash;
}

function topicAddress(topic) {
  const value = String(topic || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) return "";
  return `0x${value.slice(-40)}`;
}

function loadState(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state?.version !== 1 || !state.round) return null;
    state.history = Array.isArray(state.history) ? state.history : [];
    state.activeRuns = state.activeRuns && typeof state.activeRuns === "object" ? state.activeRuns : {};
    state.usedTransactions = state.usedTransactions && typeof state.usedTransactions === "object" ? state.usedTransactions : {};
    state.round.players = state.round.players && typeof state.round.players === "object" ? state.round.players : {};
    return state;
  } catch (error) {
    console.warn("Ignoring invalid Flappy MATT state:", String(error?.message || error).slice(0, 220));
    return null;
  }
}

function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn("Flappy MATT state checkpoint failed:", String(error?.message || error).slice(0, 220));
  }
}

function actionError(res, error) {
  const message = String(error?.shortMessage || error?.reason || error?.message || error).slice(0, 240);
  const unauthorized = /session|sign in|expired/i.test(message);
  res.status(unauthorized ? 401 : 400).json({ error: unauthorized ? "FLAPPY_AUTH_REQUIRED" : "FLAPPY_RUN_REJECTED", message });
}

function authError(res, error) {
  res.status(401).json({ error: "FLAPPY_AUTH_FAILED", message: String(error?.message || error).slice(0, 240) });
}

module.exports = { createFlappyMattRouter, topicAddress };
