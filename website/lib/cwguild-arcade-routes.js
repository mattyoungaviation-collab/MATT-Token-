const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const CHAIN_ID = 2020;
const TOKEN_ADDRESS = "0x58DB02f56D53De7ee816904aA205D222b242F7b4";
const TOKEN_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address recipient,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"
];
const TOKEN_INTERFACE = new ethers.Interface(TOKEN_ABI);
const SYMBOLS = ["ember", "tide", "leaf", "bolt"];
const ROUND_RULES = [
  { round: 1, length: 6, inputMs: 8_000, multiplier: 1n },
  { round: 2, length: 7, inputMs: 7_000, multiplier: 3n },
  { round: 3, length: 8, inputMs: 6_000, multiplier: 7n },
  { round: 4, length: 9, inputMs: 5_000, multiplier: 15n },
  { round: 5, length: 10, inputMs: 4_000, multiplier: 20n }
];
const TOP_REWARD_MULTIPLIER = 20n;
const MAX_DAILY_ATTEMPTS = 5;
const AUTH_TTL_MS = 5 * 60 * 1000;
const ENTRY_CONFIRMATIONS = 2;
const ENTRY_TX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SUBMISSION_GRACE_MS = 1_500;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 40;

function tokenAmount(value, fallback) {
  try {
    const amount = ethers.parseUnits(String(value || fallback), 18);
    if (amount <= 0n) throw new Error("amount must be positive");
    return amount;
  } catch {
    throw new Error(`Invalid CWGUILD token amount: ${value}`);
  }
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function safeWallet(value) {
  if (!ethers.isAddress(value)) throw Object.assign(new Error("A valid Ronin wallet address is required."), { status: 400 });
  return ethers.getAddress(value);
}

function readState(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) return { version: 1, claims: {}, runs: {}, entries: {}, entryTransactions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.claims !== "object") throw new Error("invalid state shape");
    if (!parsed.runs || typeof parsed.runs !== "object") parsed.runs = {};
    if (!parsed.entries || typeof parsed.entries !== "object") parsed.entries = {};
    if (!parsed.entryTransactions || typeof parsed.entryTransactions !== "object") parsed.entryTransactions = {};
    return parsed;
  } catch (error) {
    throw new Error(`CWGUILD arcade state could not be loaded: ${error.message}`);
  }
}

function saveState(stateFile, state) {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

function publicClaim(claim) {
  if (!claim) return null;
  return {
    status: claim.status,
    amount: claim.amount,
    txHash: claim.txHash || null,
    createdAt: claim.createdAt,
    confirmedAt: claim.confirmedAt || null
  };
}

function publicEntry(entry) {
  if (!entry) return null;
  return {
    status: entry.consumedAt ? "consumed" : "verified",
    amount: entry.amount,
    txHash: entry.txHash,
    verifiedAt: entry.verifiedAt,
    consumedAt: entry.consumedAt || null
  };
}

function publicRun(run) {
  if (!run) return null;
  return {
    status: run.status,
    attempt: run.attempt || 1,
    round: run.round,
    pendingAmount: run.pendingAmount || "0",
    atRisk: run.status === "active" && BigInt(run.pendingAmount || 0) > 0n,
    canRisk: run.status === "decision" && run.round < ROUND_RULES.length,
    canCashOut: run.status === "decision",
    maxRounds: ROUND_RULES.length,
    updatedAt: run.updatedAt
  };
}

function inFlightPayout(state) {
  return Object.values(state.claims).reduce((total, claim) => {
    if (!claim || !["sending", "submitted"].includes(claim.status)) return total;
    try { return total + BigInt(claim.amount); } catch { return total; }
  }, 0n);
}

function availablePoolBalance(poolBalance, state) {
  const reserved = inFlightPayout(state);
  return reserved >= poolBalance ? 0n : poolBalance - reserved;
}

function recallSequence(sequence, recall) {
  return Array.from({ length: sequence.length }, (_, offset) => {
    const step = recall.direction === "forward" ? offset : -offset;
    const index = (recall.startIndex + step + sequence.length) % sequence.length;
    return sequence[index];
  });
}

function createCWGuildArcadeRouter(options = {}) {
  const router = express.Router();
  const now = options.now || Date.now;
  const randomInt = options.randomInt || crypto.randomInt;
  const live = options.live ?? process.env.CWGUILD_LIVE_ENABLED === "true";
  const rpcUrl = options.rpcUrl || process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";
  const stateFile = options.stateFile ?? String(process.env.CWGUILD_STATE_FILE || "").trim();
  const minimumBalance = tokenAmount(options.minimumBalance ?? process.env.CWGUILD_MIN_BALANCE, "1");
  const entryAmount = tokenAmount(options.entryAmount ?? process.env.CWGUILD_ENTRY_AMOUNT, "500000");
  const topCashOut = tokenAmount(options.topCashOut ?? process.env.CWGUILD_TOP_CASH_OUT, "2000000");
  const privateKey = options.privateKey ?? String(process.env.CWGUILD_OPERATOR_PRIVATE_KEY || "").trim();
  const provider = options.provider || new ethers.JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "ronin" }, { staticNetwork: true });
  const signer = options.signer || (privateKey ? new ethers.NonceManager(new ethers.Wallet(privateKey, provider)) : null);
  const token = options.token || new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);
  const payoutToken = options.payoutToken || (signer ? new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer) : null);
  const getBalance = options.getBalance || (wallet => token.balanceOf(wallet));
  const getPoolBalance = options.getPoolBalance || (async () => signer ? token.balanceOf(await signer.getAddress()) : 0n);
  const getOperatorAddress = options.getOperatorAddress || (async () => signer ? signer.getAddress() : null);
  const verifyEntryTransfer = options.verifyEntryTransfer || (async ({ wallet, operatorAddress, txHash }) => {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw Object.assign(new Error("The CWGUILD entry transaction is not confirmed yet."), { status: 409 });
    if (Number(receipt.status) !== 1) throw Object.assign(new Error("The CWGUILD entry transaction failed on Ronin."), { status: 422 });
    if (!receipt.to || ethers.getAddress(receipt.to) !== ethers.getAddress(TOKEN_ADDRESS)) {
      throw Object.assign(new Error("The entry transaction was not sent through the verified CWGUILD token."), { status: 422 });
    }
    const latestBlock = await provider.getBlockNumber();
    const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
    if (confirmations < ENTRY_CONFIRMATIONS) {
      throw Object.assign(new Error(`Wait for ${ENTRY_CONFIRMATIONS} Ronin confirmations before verifying the entry fee.`), { status: 409 });
    }
    const block = await provider.getBlock(receipt.blockNumber);
    const blockTimestampMs = Number(block?.timestamp || 0) * 1000;
    if (!blockTimestampMs || now() - blockTimestampMs > ENTRY_TX_MAX_AGE_MS || blockTimestampMs > now() + 60_000) {
      throw Object.assign(new Error("The entry transaction must be a recent transfer made for this attempt."), { status: 422 });
    }
    const transfer = receipt.logs.map(log => {
      if (!log.address || ethers.getAddress(log.address) !== ethers.getAddress(TOKEN_ADDRESS)) return null;
      try { return TOKEN_INTERFACE.parseLog(log); } catch { return null; }
    }).find(event => event?.name === "Transfer"
      && ethers.getAddress(event.args.from) === wallet
      && ethers.getAddress(event.args.to) === ethers.getAddress(operatorAddress)
      && BigInt(event.args.value) === entryAmount);
    if (!transfer) {
      throw Object.assign(new Error(`The transaction must transfer exactly ${ethers.formatUnits(entryAmount, 18)} CWGUILD from this wallet to the reward wallet.`), { status: 422 });
    }
    return { blockNumber: Number(receipt.blockNumber), blockTimestampMs, confirmations };
  });
  const payPrize = options.payPrize || (async (wallet, amount) => {
    if (!payoutToken) throw new Error("CWGUILD payout signer is unavailable.");
    const transaction = await payoutToken.transfer(wallet, amount);
    return { hash: transaction.hash, wait: () => transaction.wait(1) };
  });

  if (live && !stateFile) throw new Error("CWGUILD live mode requires CWGUILD_STATE_FILE on persistent private storage.");
  if (live && !signer && !options.payPrize) throw new Error("CWGUILD live mode requires CWGUILD_OPERATOR_PRIVATE_KEY.");
  if (live && options.minimumBalance == null && !process.env.CWGUILD_MIN_BALANCE) throw new Error("CWGUILD live mode requires an explicit CWGUILD_MIN_BALANCE.");

  const state = readState(stateFile);
  const authChallenges = new Map();
  const payoutLocks = new Set();
  const clientWindows = new Map();

  router.use(express.json({ limit: "16kb", strict: true }));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const client = req.ip || req.socket?.remoteAddress || "unknown";
    const timestamp = now();
    const current = clientWindows.get(client);
    if (!current || timestamp - current.startedAt >= RATE_WINDOW_MS) {
      clientWindows.set(client, { startedAt: timestamp, count: 1 });
      return next();
    }
    current.count += 1;
    if (current.count > RATE_LIMIT) return res.status(429).json({ error: "Too many game requests. Try again in a minute." });
    return next();
  });

  function recordKey(wallet, timestamp = now()) {
    return `${dateKey(timestamp)}:${wallet.toLowerCase()}`;
  }

  function entryKey(wallet) {
    return wallet.toLowerCase();
  }

  function dailyRunEntries(wallet, timestamp = now()) {
    const base = recordKey(wallet, timestamp);
    return Object.entries(state.runs)
      .filter(([key, run]) => (key === base || key.startsWith(`${base}:`)) && run?.wallet === wallet)
      .sort((left, right) => Number(left[1].createdAt || 0) - Number(right[1].createdAt || 0));
  }

  function latestRun(wallet, timestamp = now()) {
    return dailyRunEntries(wallet, timestamp).at(-1)?.[1] || null;
  }

  function runStorageKey(wallet, attempt, timestamp = now()) {
    return `${recordKey(wallet, timestamp)}:${attempt}`;
  }

  function claimForRun(wallet, run) {
    if (!run) return null;
    return state.claims[run.id] || (!run.attempt ? state.claims[recordKey(wallet)] : null) || null;
  }

  function roundRule(round) {
    return ROUND_RULES[round - 1];
  }

  function roundAmount(round) {
    return topCashOut * roundRule(round).multiplier / TOP_REWARD_MULTIPLIER;
  }

  function ladderRules() {
    return ROUND_RULES.map(rule => ({
      round: rule.round,
      sequenceLength: rule.length,
      playMs: rule.inputMs,
      rewardAmount: roundAmount(rule.round).toString()
    }));
  }

  function previewMs(rule) {
    return 300 + rule.length * 390;
  }

  function loseRun(run, reason) {
    const forfeitedAmount = run.pendingAmount || "0";
    run.status = "lost";
    run.pendingAmount = "0";
    run.currentGame = null;
    run.lossReason = reason;
    run.updatedAt = now();
    saveState(stateFile, state);
    return forfeitedAmount;
  }

  function cleanupExpired() {
    const timestamp = now();
    for (const [nonce, challenge] of authChallenges) if (challenge.expiresAt < timestamp) authChallenges.delete(nonce);
    let changed = false;
    for (const run of Object.values(state.runs)) {
      if (run?.status !== "active" || !run.currentGame || run.currentGame.expiresAt >= timestamp) continue;
      run.status = "lost";
      run.pendingAmount = "0";
      run.currentGame = null;
      run.lossReason = "expired";
      run.updatedAt = timestamp;
      changed = true;
    }
    if (changed) saveState(stateFile, state);
    if (clientWindows.size > 2_000) {
      for (const [client, window] of clientWindows) if (timestamp - window.startedAt > RATE_WINDOW_MS * 2) clientWindows.delete(client);
    }
  }

  function authMessage(wallet, nonce, expiresAt) {
    return [
      "CWGUILD Rune Run",
      `Sign in to start or resume one of today's ${MAX_DAILY_ATTEMPTS} paid reward ladders.`,
      "This is not a token approval and cannot move funds.",
      `Wallet: ${wallet}`,
      `Chain: Ronin (${CHAIN_ID})`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiresAt).toISOString()}`
    ].join("\n");
  }

  function requireRun(body) {
    const wallet = safeWallet(body?.wallet);
    const runId = String(body?.runId || "");
    const run = dailyRunEntries(wallet).map(([, candidate]) => candidate).find(candidate => candidate.id === runId);
    if (!run || !runId || run.id !== runId || run.wallet !== wallet) {
      throw Object.assign(new Error("That reward ladder was not found."), { status: 404 });
    }
    return { wallet, run };
  }

  function requireGame(body) {
    const { wallet, run } = requireRun(body);
    const gameId = String(body?.gameId || "");
    if (run.status !== "active" || !run.currentGame || run.currentGame.id !== gameId) {
      throw Object.assign(new Error("That Rune Run round was not found."), { status: 404 });
    }
    return { wallet, run, game: run.currentGame };
  }

  function issueGame(run) {
    const rule = roundRule(run.round);
    const createdAt = now();
    const readyMs = previewMs(rule);
    const game = {
      id: crypto.randomBytes(18).toString("hex"),
      sequence: Array.from({ length: rule.length }, () => SYMBOLS[randomInt(0, SYMBOLS.length)]),
      createdAt,
      expiresAt: createdAt + readyMs + rule.inputMs + 5_000,
      recall: null,
      finished: false
    };
    run.currentGame = game;
    run.status = "active";
    run.updatedAt = createdAt;
    return game;
  }

  function gameResponse(run, resumed = false) {
    const game = run.currentGame;
    const rule = roundRule(run.round);
    const recall = game.recall ? {
      direction: game.recall.direction,
      startPosition: game.recall.startIndex + 1,
      inputMs: rule.inputMs,
      expiresAt: game.recall.expiresAt,
      round: run.round
    } : null;
    return {
      resumed,
      runId: run.id,
      gameId: game.id,
      sequence: game.sequence,
      createdAt: game.createdAt,
      expiresAt: game.expiresAt,
      previewMs: previewMs(rule),
      round: run.round,
      attempt: run.attempt || 1,
      sequenceLength: rule.length,
      inputMs: rule.inputMs,
      pendingAmount: run.pendingAmount || "0",
      recall
    };
  }

  async function statusFor(walletValue) {
    cleanupExpired();
    const operatorAddress = await getOperatorAddress().catch(() => null);
    const poolBalance = await getPoolBalance().catch(() => 0n);
    let wallet = null;
    let balance = null;
    let claim = null;
    let run = null;
    let entry = null;
    if (walletValue) {
      wallet = safeWallet(walletValue);
      balance = await getBalance(wallet);
      run = latestRun(wallet);
      claim = claimForRun(wallet, run);
      entry = state.entries[entryKey(wallet)] || null;
    }
    const attemptsUsed = wallet ? dailyRunEntries(wallet).length : 0;
    const normalizedPoolBalance = BigInt(poolBalance);
    const reservedPayout = inFlightPayout(state);
    const remainingPayout = availablePoolBalance(normalizedPoolBalance, state);
    return {
      live,
      chainId: CHAIN_ID,
      token: { address: TOKEN_ADDRESS, name: "CW GUILD TOKEN", symbol: "CWGUILD", decimals: 18 },
      minimumBalance: minimumBalance.toString(),
      prizeAmount: roundAmount(1).toString(),
      topCashOut: topCashOut.toString(),
      entryAmount: entryAmount.toString(),
      recommendedStartingBalance: (entryAmount + minimumBalance).toString(),
      maxPayout: normalizedPoolBalance.toString(),
      committedPayout: reservedPayout.toString(),
      reservedPayout: reservedPayout.toString(),
      remainingPayout: remainingPayout.toString(),
      operatorAddress,
      poolBalance: normalizedPoolBalance.toString(),
      wallet,
      balance: balance === null ? null : BigInt(balance).toString(),
      eligible: balance === null ? null : BigInt(balance) >= minimumBalance,
      canAffordEntry: balance === null ? null : BigInt(balance) >= entryAmount + minimumBalance,
      attemptsUsed,
      attemptsRemaining: Math.max(0, MAX_DAILY_ATTEMPTS - attemptsUsed),
      claim: publicClaim(claim),
      run: publicRun(run),
      entry: publicEntry(entry),
      rules: {
        ladder: ladderRules(),
        randomizedRecall: true,
        attemptsPerWalletUtcDay: MAX_DAILY_ATTEMPTS,
        rewardIsProvisionalUntilCashOut: true,
        lossForfeitsPendingReward: true,
        wagerRequired: true,
        entryFeeNonRefundable: true,
        approvalRequired: false
      }
    };
  }

  router.get("/status", async (req, res) => {
    try {
      return res.json(await statusFor(req.query.wallet));
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message });
    }
  });

  router.post("/auth/challenge", (req, res) => {
    try {
      cleanupExpired();
      const wallet = safeWallet(req.body?.wallet);
      const nonce = crypto.randomBytes(18).toString("hex");
      const expiresAt = now() + AUTH_TTL_MS;
      const message = authMessage(wallet, nonce, expiresAt);
      authChallenges.set(nonce, { wallet, message, expiresAt });
      return res.json({ nonce, message, expiresAt });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  });

  router.post("/entry/verify", async (req, res) => {
    try {
      cleanupExpired();
      if (!live) return res.status(503).json({ error: "Paid entry is locked while real CWGUILD payouts are disabled." });
      const wallet = safeWallet(req.body?.wallet);
      const txHash = String(req.body?.txHash || "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) return res.status(400).json({ error: "A valid Ronin entry transaction hash is required." });
      const runs = dailyRunEntries(wallet);
      const run = runs.at(-1)?.[1] || null;
      if (run && ["active", "decision", "cashing"].includes(run.status)) {
        return res.status(409).json({ error: "Finish the current ladder attempt before paying for another one." });
      }
      if (runs.length >= MAX_DAILY_ATTEMPTS) {
        return res.status(409).json({ error: `This wallet already used all ${MAX_DAILY_ATTEMPTS} paid attempts for today. Do not send another entry fee.` });
      }
      const current = state.entries[entryKey(wallet)];
      if (current && !current.consumedAt) {
        if (current.txHash !== txHash) return res.status(409).json({ error: "This wallet already has a verified, unused entry fee." });
        return res.json({ entry: publicEntry(current) });
      }
      if (state.entryTransactions[txHash]) return res.status(409).json({ error: "That entry transaction has already been used." });
      const operatorAddress = await getOperatorAddress();
      if (!operatorAddress) return res.status(503).json({ error: "The CWGUILD reward wallet is unavailable." });
      const proof = await verifyEntryTransfer({ wallet, operatorAddress, txHash, amount: entryAmount });
      const entry = {
        wallet,
        amount: entryAmount.toString(),
        txHash,
        blockNumber: Number(proof.blockNumber),
        blockTimestampMs: Number(proof.blockTimestampMs),
        verifiedAt: now(),
        consumedAt: null
      };
      state.entries[entryKey(wallet)] = entry;
      state.entryTransactions[txHash] = wallet.toLowerCase();
      saveState(stateFile, state);
      return res.status(201).json({ entry: publicEntry(entry) });
    } catch (error) {
      return res.status(error.status || 503).json({ error: String(error.message || error).slice(0, 240) });
    }
  });

  router.post("/game/start", async (req, res) => {
    try {
      cleanupExpired();
      if (!live) return res.status(503).json({ error: "Paid play is locked while real CWGUILD payouts are disabled." });
      const wallet = safeWallet(req.body?.wallet);
      const nonce = String(req.body?.nonce || "");
      const signature = String(req.body?.signature || "");
      const challenge = authChallenges.get(nonce);
      authChallenges.delete(nonce);
      if (!challenge || challenge.wallet !== wallet || challenge.expiresAt < now()) {
        return res.status(401).json({ error: "The wallet sign-in challenge is invalid or expired." });
      }
      let recovered;
      try { recovered = ethers.verifyMessage(challenge.message, signature); } catch { recovered = null; }
      if (!recovered || recovered.toLowerCase() !== wallet.toLowerCase()) {
        return res.status(401).json({ error: "The wallet signature did not match the connected account." });
      }
      const runs = dailyRunEntries(wallet);
      const existing = runs.at(-1)?.[1] || null;
      if (existing) {
        if (existing.status === "decision") return res.json({ resumed: true, runId: existing.id, run: publicRun(existing) });
        if (existing.status === "active" && existing.currentGame) return res.json(gameResponse(existing, true));
        if (existing.status === "cashing") return res.status(409).json({ error: "The current attempt's cash out is still processing.", run: publicRun(existing), claim: publicClaim(claimForRun(wallet, existing)) });
      }
      if (runs.length >= MAX_DAILY_ATTEMPTS) {
        return res.status(409).json({ error: `This wallet already used all ${MAX_DAILY_ATTEMPTS} paid attempts for today.`, run: publicRun(existing), claim: publicClaim(claimForRun(wallet, existing)) });
      }
      const entry = state.entries[entryKey(wallet)];
      if (!entry || entry.consumedAt) {
        return res.status(402).json({ error: `A verified, non-refundable ${ethers.formatUnits(entryAmount, 18)} CWGUILD entry fee is required before starting.` });
      }
      const availablePayout = availablePoolBalance(BigInt(await getPoolBalance()), state);
      if (availablePayout < roundAmount(1)) {
        return res.status(503).json({ error: "The reward wallet cannot currently cover the first-round cash out." });
      }
      const balance = BigInt(await getBalance(wallet));
      if (balance < minimumBalance) {
        return res.status(403).json({ error: `Hold at least ${ethers.formatUnits(minimumBalance, 18)} CWGUILD to play.`, balance: balance.toString() });
      }
      const run = {
        id: crypto.randomBytes(18).toString("hex"),
        wallet,
        status: "active",
        attempt: runs.length + 1,
        round: 1,
        pendingAmount: "0",
        createdAt: now(),
        updatedAt: now(),
        currentGame: null
      };
      const key = runStorageKey(wallet, run.attempt);
      state.runs[key] = run;
      entry.consumedAt = now();
      entry.runKey = key;
      issueGame(run);
      saveState(stateFile, state);
      return res.status(201).json(gameResponse(run));
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message });
    }
  });

  router.post("/game/recall", (req, res) => {
    try {
      cleanupExpired();
      const { run, game } = requireGame(req.body);
      if (game.finished) return res.status(409).json({ error: "That Rune Run round has already been submitted." });
      if (game.recall) return res.status(409).json({ error: "The recall round has already started." });
      const rule = roundRule(run.round);
      const elapsed = now() - game.createdAt;
      const readyMs = previewMs(rule);
      if (elapsed < readyMs - 250) return res.status(422).json({ error: "The recall round cannot start before the pattern finishes." });
      if (elapsed > readyMs + 3_000) {
        const forfeitedAmount = loseRun(run, "recall-not-started");
        return res.status(410).json({ error: "The recall round was not started in time.", lost: true, forfeitedAmount });
      }
      const startedAt = now();
      game.recall = {
        direction: randomInt(0, 2) === 0 ? "forward" : "backward",
        startIndex: randomInt(0, game.sequence.length),
        startedAt,
        expiresAt: startedAt + rule.inputMs
      };
      saveState(stateFile, state);
      return res.json({
        direction: game.recall.direction,
        startPosition: game.recall.startIndex + 1,
        inputMs: rule.inputMs,
        expiresAt: game.recall.expiresAt,
        round: run.round
      });
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message });
    }
  });

  router.post("/game/finish", (req, res) => {
    try {
      cleanupExpired();
      const { run, game } = requireGame(req.body);
      if (game.finished) return res.status(409).json({ error: "That Rune Run round has already been submitted." });
      if (!game.recall) return res.status(422).json({ error: "Start the timed recall round before submitting runes." });
      game.finished = true;
      const expired = now() > game.recall.expiresAt + SUBMISSION_GRACE_MS || game.expiresAt < now();
      const moves = Array.isArray(req.body?.moves) ? req.body.moves.map(value => String(value)) : [];
      const expected = recallSequence(game.sequence, game.recall);
      const won = !expired && moves.length === expected.length && moves.every((value, index) => value === expected[index]);
      if (!won) {
        const forfeitedAmount = loseRun(run, expired ? "timeout" : "incorrect");
        return res.json({
          won: false,
          lost: true,
          timedOut: expired,
          forfeitedAmount,
          message: expired ? "Time expired. The entire provisional reward was forfeited." : "Wrong signal. The entire provisional reward was forfeited."
        });
      }
      run.pendingAmount = roundAmount(run.round).toString();
      run.status = "decision";
      run.currentGame = null;
      run.updatedAt = now();
      saveState(stateFile, state);
      return res.json({
        won: true,
        paid: false,
        pending: true,
        round: run.round,
        pendingAmount: run.pendingAmount,
        canRisk: run.round < ROUND_RULES.length,
        nextRound: run.round < ROUND_RULES.length ? ladderRules()[run.round] : null,
        message: "Round won. Cash out now, or explicitly accept the next round and risk the entire provisional reward."
      });
    } catch (error) {
      return res.status(error.status || 503).json({ error: String(error.message || error).slice(0, 240) });
    }
  });

  router.post("/game/next", (req, res) => {
    try {
      cleanupExpired();
      if (!live) return res.status(503).json({ error: "The next round is locked while real CWGUILD payouts are disabled. Your cash-out decision remains saved." });
      const { run } = requireRun(req.body);
      if (run.status !== "decision") return res.status(409).json({ error: "There is no completed round waiting for a risk decision." });
      if (run.round >= ROUND_RULES.length) return res.status(409).json({ error: "The final round is complete. Cash out the top reward." });
      run.round += 1;
      issueGame(run);
      saveState(stateFile, state);
      return res.status(201).json(gameResponse(run));
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message });
    }
  });

  router.post("/game/cashout", async (req, res) => {
    let wallet;
    let run;
    let claim;
    let key;
    try {
      cleanupExpired();
      if (!live) return res.status(503).json({ error: "Cash out is paused while real CWGUILD payouts are disabled. Your provisional reward remains saved." });
      ({ wallet, run } = requireRun(req.body));
      if (run.status !== "decision" || BigInt(run.pendingAmount || 0) <= 0n) {
        return res.status(409).json({ error: "There is no provisional reward available to cash out." });
      }
      key = run.id;
      if (state.claims[key]) return res.status(409).json({ error: "This ladder attempt already cashed out its CWGUILD reward.", claim: publicClaim(state.claims[key]) });
      if (payoutLocks.has(wallet.toLowerCase())) return res.status(409).json({ error: "A payout for this wallet is already processing." });
      const amount = BigInt(run.pendingAmount);
      payoutLocks.add(wallet.toLowerCase());
      const poolBalance = BigInt(await getPoolBalance());
      const availablePayout = availablePoolBalance(poolBalance, state);
      if (availablePayout < amount) {
        throw Object.assign(new Error("The reward wallet's current CWGUILD balance cannot cover this cash out."), { status: 503 });
      }
      claim = { status: "sending", wallet, amount: amount.toString(), createdAt: now(), txHash: null };
      state.claims[key] = claim;
      run.status = "cashing";
      run.updatedAt = now();
      saveState(stateFile, state);
      const transaction = await payPrize(wallet, amount);
      claim.status = "submitted";
      claim.txHash = transaction.hash;
      run.status = "cashed";
      run.updatedAt = now();
      saveState(stateFile, state);
      const receipt = await transaction.wait();
      if (receipt && Number(receipt.status ?? 1) !== 1) throw new Error("The CWGUILD payout transaction reverted.");
      claim.status = "confirmed";
      claim.confirmedAt = now();
      saveState(stateFile, state);
      return res.json({ paid: true, claim: publicClaim(claim) });
    } catch (error) {
      if (claim && !claim.txHash) {
        delete state.claims[key];
        if (run) {
          run.status = "decision";
          run.updatedAt = now();
        }
        saveState(stateFile, state);
      } else if (claim) {
        claim.status = "submitted";
        claim.error = String(error.message || error).slice(0, 200);
        saveState(stateFile, state);
      }
      return res.status(error.status || 503).json({ error: String(error.message || error).slice(0, 240) });
    } finally {
      if (wallet) payoutLocks.delete(wallet.toLowerCase());
    }
  });

  router.get("/claim/:wallet", (req, res) => {
    try {
      const wallet = safeWallet(req.params.wallet);
      const run = latestRun(wallet);
      return res.json({
        claim: publicClaim(claimForRun(wallet, run)),
        run: publicRun(run),
        entry: publicEntry(state.entries[entryKey(wallet)])
      });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { CHAIN_ID, TOKEN_ADDRESS, createCWGuildArcadeRouter };
