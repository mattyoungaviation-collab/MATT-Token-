const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const CHAIN_ID = 2020;
const TOKEN_ADDRESS = "0x58DB02f56D53De7ee816904aA205D222b242F7b4";
const TOKEN_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address recipient,uint256 amount) returns (bool)"
];
const SYMBOLS = ["ember", "tide", "leaf", "bolt"];
const AUTH_TTL_MS = 5 * 60 * 1000;
const GAME_TTL_MS = 30 * 1000;
const MIN_COMPLETION_MS = 2_500;
const MAX_COMPLETION_MS = 24_000;
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
  if (!stateFile || !fs.existsSync(stateFile)) return { version: 1, claims: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.claims !== "object") throw new Error("invalid state shape");
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

function createCWGuildArcadeRouter(options = {}) {
  const router = express.Router();
  const now = options.now || Date.now;
  const randomInt = options.randomInt || crypto.randomInt;
  const live = options.live ?? process.env.CWGUILD_LIVE_ENABLED === "true";
  const rpcUrl = options.rpcUrl || process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";
  const stateFile = options.stateFile ?? String(process.env.CWGUILD_STATE_FILE || "").trim();
  const minimumBalance = tokenAmount(options.minimumBalance ?? process.env.CWGUILD_MIN_BALANCE, "1");
  const prizeAmount = tokenAmount(options.prizeAmount ?? process.env.CWGUILD_PRIZE_AMOUNT, "100");
  const privateKey = options.privateKey ?? String(process.env.CWGUILD_OPERATOR_PRIVATE_KEY || "").trim();
  const provider = options.provider || new ethers.JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "ronin" }, { staticNetwork: true });
  const signer = options.signer || (privateKey ? new ethers.NonceManager(new ethers.Wallet(privateKey, provider)) : null);
  const token = options.token || new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);
  const payoutToken = options.payoutToken || (signer ? new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer) : null);
  const getBalance = options.getBalance || (wallet => token.balanceOf(wallet));
  const getPoolBalance = options.getPoolBalance || (async () => signer ? token.balanceOf(await signer.getAddress()) : 0n);
  const getOperatorAddress = options.getOperatorAddress || (async () => signer ? signer.getAddress() : null);
  const payPrize = options.payPrize || (async wallet => {
    if (!payoutToken) throw new Error("CWGUILD payout signer is unavailable.");
    const transaction = await payoutToken.transfer(wallet, prizeAmount);
    return { hash: transaction.hash, wait: () => transaction.wait(1) };
  });

  if (live && !stateFile) throw new Error("CWGUILD live mode requires CWGUILD_STATE_FILE on persistent private storage.");
  if (live && !signer && !options.payPrize) throw new Error("CWGUILD live mode requires CWGUILD_OPERATOR_PRIVATE_KEY.");
  if (live && options.minimumBalance == null && !process.env.CWGUILD_MIN_BALANCE) throw new Error("CWGUILD live mode requires an explicit CWGUILD_MIN_BALANCE.");
  if (live && options.prizeAmount == null && !process.env.CWGUILD_PRIZE_AMOUNT) throw new Error("CWGUILD live mode requires an explicit CWGUILD_PRIZE_AMOUNT.");

  const state = readState(stateFile);
  const authChallenges = new Map();
  const games = new Map();
  const activeGameByWallet = new Map();
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

  function claimKey(wallet, timestamp = now()) {
    return `${dateKey(timestamp)}:${wallet.toLowerCase()}`;
  }

  function cleanupExpired() {
    const timestamp = now();
    for (const [nonce, challenge] of authChallenges) if (challenge.expiresAt < timestamp) authChallenges.delete(nonce);
    for (const [id, game] of games) {
      if (game.expiresAt >= timestamp) continue;
      games.delete(id);
      if (activeGameByWallet.get(game.wallet.toLowerCase()) === id) activeGameByWallet.delete(game.wallet.toLowerCase());
    }
    if (clientWindows.size > 2_000) {
      for (const [client, window] of clientWindows) if (timestamp - window.startedAt > RATE_WINDOW_MS * 2) clientWindows.delete(client);
    }
  }

  function authMessage(wallet, nonce, expiresAt) {
    return [
      "CWGUILD Rune Run",
      "Sign in to start one server-issued skill run.",
      "This is not a token approval and cannot move funds.",
      `Wallet: ${wallet}`,
      `Chain: Ronin (${CHAIN_ID})`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiresAt).toISOString()}`
    ].join("\n");
  }

  async function statusFor(walletValue) {
    const operatorAddress = await getOperatorAddress().catch(() => null);
    const poolBalance = await getPoolBalance().catch(() => 0n);
    let wallet = null;
    let balance = null;
    let claim = null;
    if (walletValue) {
      wallet = safeWallet(walletValue);
      balance = await getBalance(wallet);
      claim = state.claims[claimKey(wallet)] || null;
    }
    return {
      live,
      chainId: CHAIN_ID,
      token: { address: TOKEN_ADDRESS, name: "CW GUILD TOKEN", symbol: "CWGUILD", decimals: 18 },
      minimumBalance: minimumBalance.toString(),
      prizeAmount: prizeAmount.toString(),
      operatorAddress,
      poolBalance: BigInt(poolBalance).toString(),
      wallet,
      balance: balance === null ? null : BigInt(balance).toString(),
      eligible: balance === null ? null : BigInt(balance) >= minimumBalance,
      claim: publicClaim(claim),
      rules: {
        sequenceLength: 6,
        previewMs: 2600,
        playMs: MAX_COMPLETION_MS - MIN_COMPLETION_MS,
        onePrizePerWalletUtcDay: true,
        wagerRequired: false,
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

  router.post("/game/start", async (req, res) => {
    try {
      cleanupExpired();
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
      if (state.claims[claimKey(wallet)]) {
        return res.status(409).json({ error: "This wallet already earned today's CWGUILD prize.", claim: publicClaim(state.claims[claimKey(wallet)]) });
      }
      if (activeGameByWallet.has(wallet.toLowerCase())) {
        return res.status(409).json({ error: "This wallet already has an active run." });
      }
      const balance = BigInt(await getBalance(wallet));
      if (balance < minimumBalance) {
        return res.status(403).json({ error: `Hold at least ${ethers.formatUnits(minimumBalance, 18)} CWGUILD to play.`, balance: balance.toString() });
      }
      const id = crypto.randomBytes(18).toString("hex");
      const createdAt = now();
      const sequence = Array.from({ length: 6 }, () => SYMBOLS[randomInt(0, SYMBOLS.length)]);
      games.set(id, { id, wallet, sequence, createdAt, expiresAt: createdAt + GAME_TTL_MS, finished: false });
      activeGameByWallet.set(wallet.toLowerCase(), id);
      return res.status(201).json({ gameId: id, sequence, createdAt, expiresAt: createdAt + GAME_TTL_MS, previewMs: 2600 });
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message });
    }
  });

  router.post("/game/finish", async (req, res) => {
    let wallet;
    let game;
    try {
      wallet = safeWallet(req.body?.wallet);
      const gameId = String(req.body?.gameId || "");
      game = games.get(gameId);
      if (!game || game.wallet !== wallet) return res.status(404).json({ error: "That Rune Run was not found." });
      if (game.finished) return res.status(409).json({ error: "That Rune Run has already been submitted." });
      game.finished = true;
      activeGameByWallet.delete(wallet.toLowerCase());
      const elapsed = now() - game.createdAt;
      if (elapsed < MIN_COMPLETION_MS) return res.status(422).json({ error: "The sequence was submitted before the playable window." });
      if (elapsed > MAX_COMPLETION_MS || game.expiresAt < now()) return res.status(410).json({ error: "Time expired. Start a new Rune Run." });
      const moves = Array.isArray(req.body?.moves) ? req.body.moves.map(value => String(value)) : [];
      const won = moves.length === game.sequence.length && moves.every((value, index) => value === game.sequence[index]);
      if (!won) return res.json({ won: false, message: "The rune order did not match. Sign in and try a fresh run." });
      if (!live) {
        return res.json({ won: true, paid: false, preview: true, message: "Practice run complete. Prize mode is not funded and enabled yet." });
      }
      const key = claimKey(wallet);
      if (state.claims[key]) return res.status(409).json({ error: "This wallet already earned today's CWGUILD prize.", claim: publicClaim(state.claims[key]) });
      if (payoutLocks.has(wallet.toLowerCase())) return res.status(409).json({ error: "A payout for this wallet is already processing." });
      payoutLocks.add(wallet.toLowerCase());
      const claim = { status: "sending", wallet, amount: prizeAmount.toString(), createdAt: now(), txHash: null };
      state.claims[key] = claim;
      saveState(stateFile, state);
      try {
        const poolBalance = BigInt(await getPoolBalance());
        if (poolBalance < prizeAmount) throw new Error("The CWGUILD reward wallet needs more tokens.");
        const transaction = await payPrize(wallet);
        claim.status = "submitted";
        claim.txHash = transaction.hash;
        saveState(stateFile, state);
        const receipt = await transaction.wait();
        if (receipt && Number(receipt.status ?? 1) !== 1) throw new Error("The CWGUILD payout transaction reverted.");
        claim.status = "confirmed";
        claim.confirmedAt = now();
        saveState(stateFile, state);
        return res.json({ won: true, paid: true, claim: publicClaim(claim) });
      } catch (error) {
        if (!claim.txHash) {
          delete state.claims[key];
          saveState(stateFile, state);
        } else {
          claim.status = "submitted";
          claim.error = String(error.message || error).slice(0, 200);
          saveState(stateFile, state);
        }
        throw error;
      } finally {
        payoutLocks.delete(wallet.toLowerCase());
      }
    } catch (error) {
      return res.status(error.status || 503).json({ error: String(error.message || error).slice(0, 240) });
    } finally {
      if (game) games.delete(game.id);
    }
  });

  router.get("/claim/:wallet", (req, res) => {
    try {
      const wallet = safeWallet(req.params.wallet);
      return res.json({ claim: publicClaim(state.claims[claimKey(wallet)]) });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { CHAIN_ID, TOKEN_ADDRESS, createCWGuildArcadeRouter };
