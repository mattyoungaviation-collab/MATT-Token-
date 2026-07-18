const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Interface } = require("ethers");
const { createFlappyMattAuth } = require("./flappy-matt-auth");
const { createFlappyMattSettlement } = require("./flappy-matt-settlement");
const { simulateRun } = require("../public/flappy-matt-engine");
const { newRound, leaderboardRows, finalizeRound, publicRound, parseTokenAmount, formatUnits } = require("./flappy-matt-rounds");

const MATT_ADDRESS = String(process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d").toLowerCase();
const MATT_TREASURY = String(process.env.MATT_TREASURY || "0xf79913cb83cc9cabd95d0ba9250103fbb939f984").toLowerCase();
const POOL_ABI = [
  "event EntryPaid(uint256 indexed roundId,address indexed player,uint256 entryNumber,uint256 treasuryFee,uint256 prizeAdded,uint256 potAfter)"
];
const poolInterface = new Interface(POOL_ABI);
const ENTRY_TOPIC = poolInterface.getEvent("EntryPaid").topicHash.toLowerCase();
const RUN_MAX_MS = 120_000;
const RUN_MIN_TIME_LEFT_MS = 15_000;
const HISTORY_LIMIT = 14;
const USED_TX_LIMIT = 25_000;
const SETTLEMENT_INTERVAL_MS = positiveInteger(process.env.FLAPPY_MATT_SETTLEMENT_INTERVAL_MS, 30_000);
const HEALTH_INTERVAL_MS = positiveInteger(process.env.FLAPPY_MATT_HEALTH_INTERVAL_MS, 60_000);

function createFlappyMattRouter(options = {}) {
  const router = express.Router();
  const auth = createFlappyMattAuth();
  const rpcRequest = options.rpcRequest;
  if (typeof rpcRequest !== "function") throw new Error("Flappy MATT requires rpcRequest");

  const stateFile = String(options.stateFile || process.env.FLAPPY_MATT_STATE_FILE || "").trim();
  const entryRaw = parseTokenAmount(process.env.FLAPPY_MATT_ENTRY_MATT || "50000");
  const treasuryFeeRaw = parseTokenAmount("1000");
  const prizeRaw = entryRaw - treasuryFeeRaw;
  const contractAddress = normalizeOptionalAddress(process.env.FLAPPY_MATT_POT_ADDRESS);
  const state = loadState(stateFile) || freshState(Date.now());
  const requestTimes = new Map();
  const settlement = createFlappyMattSettlement({
    rpcUrl: options.rpcUrl,
    contractAddress,
    privateKey: options.operatorPrivateKey,
    expectedMatt: MATT_ADDRESS,
    expectedTreasury: MATT_TREASURY
  });
  let settlementPromise = null;

  function isPaidMode() {
    return Boolean(contractAddress && entryRaw === parseTokenAmount("50000") && settlement.isReady());
  }

  router.use(express.json({ limit: "32kb", strict: true }));

  router.get("/config", async (_req, res) => {
    rolloverIfNeeded();
    const keeperStatus = settlement.status();
    if (keeperStatus.enabled && (!keeperStatus.lastCheckedAt || Date.now() - Date.parse(keeperStatus.lastCheckedAt) > HEALTH_INTERVAL_MS)) {
      await settlement.refreshHealth();
    }
    const paidMode = isPaidMode();
    const currentStatus = settlement.status();
    res.set("Cache-Control", "no-store");
    res.json({
      mode: paidMode ? "PAID" : "PRACTICE",
      mattAddress: MATT_ADDRESS,
      contractAddress,
      potAddress: contractAddress,
      entryRaw: entryRaw.toString(),
      entryMatt: formatUnits(entryRaw),
      treasuryFeeRaw: treasuryFeeRaw.toString(),
      treasuryFeeMatt: formatUnits(treasuryFeeRaw),
      prizeRaw: prizeRaw.toString(),
      prizeMatt: formatUnits(prizeRaw),
      payoutSplit: { first: 50, second: 35, third: 15 },
      round: publicRound(state.round),
      settlement: publicSettlementStatus(currentStatus),
      notice: paidMode
        ? "Each flight calls the prize contract: 1,000 MATT goes immediately to treasury and 49,000 MATT joins the UTC day prize pot. The backend keeper submits the verified leaders after the round closes."
        : practiceNotice(contractAddress, currentStatus)
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

  router.get("/settlement-status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      keeper: publicSettlementStatus(settlement.status()),
      pendingRounds: state.history.filter(isPendingSettlement).map(round => ({
        id: round.id,
        chainRoundId: round.chainRoundId,
        status: round.status,
        settlementStatus: round.settlementStatus || null,
        settlementError: round.settlementError || null
      }))
    });
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
      let eligible = false;
      const suppliedTxHash = String(req.body.txHash || "").trim();
      if (suppliedTxHash) {
        if (!contractAddress) throw new Error("The official Flappy MATT prize contract is not configured.");
        txHash = normalizeTxHash(suppliedTxHash);
        if (state.usedTransactions[txHash]) throw new Error("That payment transaction has already been used for a Flappy MATT run.");
        const payment = await verifyEntryPayment({ rpcRequest, txHash, wallet, contractAddress, entryRaw, prizeRaw, round: state.round });
        paidRaw = entryRaw;
        eligible = true;
        state.usedTransactions[txHash] = { wallet, amountRaw: paidRaw.toString(), acceptedAt: Date.now(), roundId: state.round.id };
        trimUsedTransactions();
        state.round.potRaw = payment.potAfterRaw.toString();
        state.round.entries = Number(payment.entryNumber);
      } else if (isPaidMode()) {
        throw new Error("A confirmed Flappy MATT contract entry is required for this paid run.");
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
        eligible
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
    if (state.round && now < state.round.endsAt) return false;
    if (state.round) state.history.unshift(finalizeRound(state.round));
    state.history = state.history.slice(0, HISTORY_LIMIT);
    state.round = newRound(now);
    state.activeRuns = {};
    saveState(stateFile, state);
    return true;
  }

  async function settlePendingRounds() {
    rolloverIfNeeded();
    if (!settlement.isReady()) await settlement.refreshHealth();
    if (!settlement.isReady()) return;

    const pending = state.history.filter(isPendingSettlement)
      .sort((left, right) => Number(left.chainRoundId) - Number(right.chainRoundId));

    for (const round of pending) {
      round.settlementStatus = "SUBMITTING";
      round.settlementAttemptedAt = new Date().toISOString();
      round.settlementError = null;
      saveState(stateFile, state);
      try {
        const result = await settlement.settle(round);
        const hasWinners = Array.isArray(round.winners) && round.winners.length > 0;
        round.status = result.noPrize ? "NO_ENTRIES" : hasWinners ? "PAID" : "CARRIED_FORWARD";
        round.settlementStatus = result.alreadySettled ? "ALREADY_SETTLED" : result.noPrize ? "NO_PRIZE" : "CONFIRMED";
        round.settlementTxHash = result.txHash || round.settlementTxHash || null;
        round.settledAt = new Date().toISOString();
        round.settlementError = null;
        for (const winner of round.winners || []) winner.payoutStatus = "PAID";
      } catch (error) {
        round.status = "PAYOUT_RETRY";
        round.settlementStatus = "RETRYING";
        round.settlementError = safe(error);
        console.warn(`Flappy MATT settlement ${round.chainRoundId} failed:`, round.settlementError);
      }
      saveState(stateFile, state);
    }
  }

  function triggerSettlement() {
    if (settlementPromise) return settlementPromise;
    settlementPromise = settlePendingRounds().finally(() => { settlementPromise = null; });
    return settlementPromise;
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

  const healthTimer = setInterval(() => settlement.refreshHealth().catch(error => console.warn("Flappy MATT keeper health check failed:", safe(error))), HEALTH_INTERVAL_MS);
  healthTimer.unref?.();
  const settlementTimer = setInterval(() => triggerSettlement().catch(error => console.warn("Flappy MATT settlement loop failed:", safe(error))), SETTLEMENT_INTERVAL_MS);
  settlementTimer.unref?.();
  const startupTimer = setTimeout(async () => {
    await settlement.refreshHealth();
    await triggerSettlement();
  }, 1_000);
  startupTimer.unref?.();

  return router;
}

async function verifyEntryPayment({ rpcRequest, txHash, wallet, contractAddress, entryRaw, prizeRaw, round }) {
  const receipt = await rpcRequest("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("The Flappy MATT entry transaction is not confirmed yet.");
  if (BigInt(receipt.status || "0x0") !== 1n) throw new Error("The Flappy MATT entry transaction failed on Ronin.");
  if (String(receipt.to || "").toLowerCase() !== contractAddress) throw new Error("This transaction did not call the official Flappy MATT prize contract.");

  const block = await rpcRequest("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const paidAt = Number(BigInt(block?.timestamp || "0x0")) * 1000;
  if (!paidAt || paidAt < round.startsAt || paidAt >= round.endsAt) throw new Error("The entry must be confirmed during the current leaderboard round.");

  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== contractAddress) continue;
    if (String(log.topics?.[0] || "").toLowerCase() !== ENTRY_TOPIC) continue;
    const parsed = poolInterface.parseLog(log);
    const eventRoundId = Number(parsed.args.roundId);
    const player = String(parsed.args.player).toLowerCase();
    const treasuryFeeRaw = BigInt(parsed.args.treasuryFee);
    const prizeAddedRaw = BigInt(parsed.args.prizeAdded);
    if (eventRoundId !== Number(round.chainRoundId)) throw new Error("The contract entry belongs to a different UTC round.");
    if (player !== wallet) throw new Error("The contract entry was paid by a different wallet.");
    if (treasuryFeeRaw + prizeAddedRaw !== entryRaw || prizeAddedRaw !== prizeRaw) throw new Error("The contract entry split does not match the official 50,000 MATT rules.");
    return {
      entryNumber: BigInt(parsed.args.entryNumber),
      prizeAddedRaw,
      potAfterRaw: BigInt(parsed.args.potAfter),
      paidAt
    };
  }
  throw new Error("The transaction did not emit a valid Flappy MATT entry event.");
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

function loadState(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
    if (loaded?.version !== 1 || !loaded.round) return null;
    loaded.history = Array.isArray(loaded.history) ? loaded.history : [];
    loaded.activeRuns = loaded.activeRuns && typeof loaded.activeRuns === "object" ? loaded.activeRuns : {};
    loaded.usedTransactions = loaded.usedTransactions && typeof loaded.usedTransactions === "object" ? loaded.usedTransactions : {};
    loaded.round.players = loaded.round.players && typeof loaded.round.players === "object" ? loaded.round.players : {};
    loaded.round.chainRoundId = Number(loaded.round.chainRoundId ?? Math.floor(Number(loaded.round.startsAt) / (24 * 60 * 60_000)));
    return loaded;
  } catch (error) {
    console.warn("Ignoring invalid Flappy MATT state:", safe(error));
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
    console.warn("Flappy MATT state checkpoint failed:", safe(error));
  }
}

function isPendingSettlement(round) {
  return ["PAYOUT_PENDING", "PAYOUT_RETRY", "CONTRACT_PAYOUT_PENDING"].includes(String(round?.status || ""));
}

function publicSettlementStatus(status) {
  return {
    enabled: Boolean(status?.enabled),
    ready: Boolean(status?.ready),
    contractAddress: status?.contractAddress || null,
    walletAddress: status?.walletAddress || null,
    operatorAddress: status?.operatorAddress || null,
    operatorMatches: Boolean(status?.operatorMatches),
    contractMatches: Boolean(status?.contractMatches),
    lastCheckedAt: status?.lastCheckedAt || null,
    lastSettlementAt: status?.lastSettlementAt || null,
    lastSettlementRoundId: status?.lastSettlementRoundId ?? null,
    lastTxHash: status?.lastTxHash || null,
    lastError: status?.lastError || null
  };
}

function practiceNotice(contractAddress, status) {
  if (!contractAddress) return "Practice mode is active. Configure the deployed Flappy MATT prize contract before accepting paid entries.";
  if (!status?.enabled) return "Practice mode is active. The prize contract is configured, but the dedicated backend keeper key is not configured.";
  return `Practice mode is active until the prize contract and keeper pass the safety check${status?.lastError ? `: ${status.lastError}` : "."}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safe(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || "Unknown error").slice(0, 240);
}

function actionError(res, error) {
  const message = safe(error);
  const unauthorized = /session|sign in|expired/i.test(message);
  res.status(unauthorized ? 401 : 400).json({ error: unauthorized ? "FLAPPY_AUTH_REQUIRED" : "FLAPPY_RUN_REJECTED", message });
}

function authError(res, error) {
  res.status(401).json({ error: "FLAPPY_AUTH_FAILED", message: safe(error) });
}

module.exports = {
  createFlappyMattRouter,
  verifyEntryPayment,
  isPendingSettlement,
  publicSettlementStatus
};
