const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const BETTING_MS = 15_000;
const CRASHED_MS = 6_000;
const CHAIN_ID = 2020n;
const BPS = 10_000;
const DEFAULT_VAULT = "0x2b7d130Bb4B026B9EAF045AcAc4E69238f2d2Fd3";
const DEFAULT_TOKEN = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";

const VAULT_ABI = [
  "function paused() view returns (bool)",
  "function minWager() view returns (uint256)",
  "function maxWager() view returns (uint256)",
  "function maxCashoutBps() view returns (uint256)",
  "function availableBankroll() view returns (uint256)",
  "function unreservedBankroll() view returns (uint256)",
  "function isSolvent() view returns (bool)",
  "function claimable(address) view returns (uint256)",
  "function rounds(bytes32) view returns (bytes32 commitment,uint64 bettingClosesAt,uint32 crashPointBps,bool revealed)",
  "function wagers(bytes32) view returns (address player,bytes32 roundId,uint128 amount,uint64 openedAt,bool settled)",
  "function commitRound(bytes32 roundId,bytes32 commitment,uint256 bettingClosesAt)",
  "function revealRound(bytes32 roundId,bytes32 seed) returns (uint256)",
  "function settleWagers(bytes32[] wagerIds,uint256[] cashoutBpsValues)",
  "event WagerOpened(bytes32 indexed wagerId,bytes32 indexed roundId,address indexed player,uint256 amount)",
  "event WagerSettled(bytes32 indexed wagerId,address indexed player,uint256 cashoutBps,uint256 payout,uint256 burned,uint256 rewards)"
];
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)"
];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function atomicWrite(filename, value) {
  if (!filename) return;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filename);
}
function defaultState() { return { counter: 0, current: null, history: [], cashouts: {} }; }
function loadState(filename) {
  if (!filename || !fs.existsSync(filename)) return defaultState();
  try { return { ...defaultState(), ...JSON.parse(fs.readFileSync(filename, "utf8")) }; }
  catch (error) { console.error("Crash state load failed:", error); return defaultState(); }
}
function multiplierToElapsed(multiplier) {
  const target = Math.log(Math.max(1, multiplier));
  const a = 0.0028, b = 0.055;
  return Math.max(700, ((-b + Math.sqrt(b * b + 4 * a * target)) / (2 * a)) * 1000);
}
function elapsedToMultiplier(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  return Math.exp(0.055 * seconds + 0.0028 * seconds * seconds);
}
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch { return null; } }
function cashoutMessage({ vault, roundId, wallet, timestamp }) {
  return `MATT SPACE FLIGHT CASHOUT\nVault:${ethers.getAddress(vault)}\nRound:${roundId}\nWallet:${ethers.getAddress(wallet)}\nTimestamp:${timestamp}`;
}
function asString(value) { return typeof value === "bigint" ? value.toString() : String(value); }

function createCrashContractRouter(options = {}) {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  const rpcUrl = options.rpcUrl || process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc";
  const vaultAddress = normalizeAddress(options.vaultAddress || process.env.CRASH_VAULT_ADDRESS || DEFAULT_VAULT);
  const tokenAddress = normalizeAddress(options.tokenAddress || process.env.CRASH_TOKEN_ADDRESS || DEFAULT_TOKEN);
  const privateKey = String(options.operatorPrivateKey || process.env.CRASH_OPERATOR_PRIVATE_KEY || "").trim();
  const liveEnabled = String(options.liveEnabled ?? process.env.CRASH_LIVE_ENABLED ?? "false").toLowerCase() === "true";
  const stateFile = options.stateFile || process.env.CRASH_STATE_FILE || "";
  const configured = Boolean(vaultAddress && tokenAddress && privateKey);

  const provider = new ethers.JsonRpcProvider(rpcUrl, Number(CHAIN_ID), { staticNetwork: true });
  const operator = configured ? new ethers.Wallet(privateKey, provider) : null;
  const vaultRead = vaultAddress ? new ethers.Contract(vaultAddress, VAULT_ABI, provider) : null;
  const vaultWrite = operator && vaultAddress ? vaultRead.connect(operator) : null;
  const token = tokenAddress ? new ethers.Contract(tokenAddress, TOKEN_ABI, provider) : null;
  const state = loadState(stateFile);

  let ticking = false;
  let contractStatus = { checkedAt: 0, paused: true, minWager: 0n, maxWager: 0n, maxCashoutBps: 0n, bankroll: 0n, unreserved: 0n, solvent: false };
  let wagerCache = { roundId: null, checkedAt: 0, entries: [] };

  function persist() { atomicWrite(stateFile, state); }
  async function refreshStatus(force = false) {
    if (!vaultRead) return contractStatus;
    if (!force && Date.now() - contractStatus.checkedAt < 3_000) return contractStatus;
    const [paused, minWager, maxWager, maxCashoutBps, bankroll, unreserved, solvent] = await Promise.all([
      vaultRead.paused(), vaultRead.minWager(), vaultRead.maxWager(), vaultRead.maxCashoutBps(),
      vaultRead.availableBankroll(), vaultRead.unreservedBankroll(), vaultRead.isSolvent()
    ]);
    contractStatus = { checkedAt: Date.now(), paused, minWager, maxWager, maxCashoutBps, bankroll, unreserved, solvent };
    return contractStatus;
  }
  function newRoundRecord() {
    const counter = ++state.counter;
    const seed = ethers.hexlify(crypto.randomBytes(32));
    const roundId = ethers.keccak256(ethers.solidityPacked(["string", "uint256", "uint256", "bytes32"], ["MATT-CRASH-MAINNET", counter, Date.now(), seed]));
    const commitment = ethers.keccak256(seed);
    return { counter, roundId, seed, commitment, bettingClosesAt: Math.floor((Date.now() + BETTING_MS) / 1000), commitBlock: 0, stage: "committing", flightStartedAt: 0, crashPointBps: 0, crashedAt: 0, settled: false };
  }
  async function ensureCommitted() {
    if (state.current) return;
    state.current = newRoundRecord();
    state.cashouts = {};
    wagerCache = { roundId: state.current.roundId, checkedAt: 0, entries: [] };
    persist();
  }
  async function commitCurrent() {
    const r = state.current;
    const chainRound = await vaultRead.rounds(r.roundId);
    if (chainRound.commitment !== ethers.ZeroHash) {
      r.stage = "betting";
      r.bettingClosesAt = Number(chainRound.bettingClosesAt);
      persist();
      return;
    }
    const tx = await vaultWrite.commitRound(r.roundId, r.commitment, r.bettingClosesAt);
    const receipt = await tx.wait();
    r.commitBlock = receipt.blockNumber;
    r.stage = "betting";
    persist();
    console.log(`Crash round ${r.counter} committed: ${r.roundId}`);
  }
  async function revealCurrent() {
    const r = state.current;
    const chainRound = await vaultRead.rounds(r.roundId);
    if (!chainRound.revealed) {
      r.stage = "revealing";
      persist();
      const tx = await vaultWrite.revealRound(r.roundId, r.seed);
      await tx.wait();
    }
    const revealed = await vaultRead.rounds(r.roundId);
    r.crashPointBps = Number(revealed.crashPointBps);
    r.flightStartedAt = Date.now();
    r.stage = "flying";
    persist();
    console.log(`Crash round ${r.counter} revealed at ${(r.crashPointBps / BPS).toFixed(2)}x`);
  }
  function crashAt(r) {
    if (!r?.flightStartedAt || !r?.crashPointBps) return Number.POSITIVE_INFINITY;
    return r.flightStartedAt + multiplierToElapsed(r.crashPointBps / BPS);
  }
  function observedMultiplierBps(r, now = Date.now()) {
    if (!r || r.stage !== "flying" || !r.flightStartedAt) return BPS;
    const raw = Math.floor(elapsedToMultiplier(now - r.flightStartedAt) * BPS);
    return Math.max(BPS, Math.min(raw, r.crashPointBps || raw));
  }
  async function wagerEventsForRound(r, force = false) {
    if (!r || !vaultRead) return [];
    if (wagerCache.roundId !== r.roundId) wagerCache = { roundId: r.roundId, checkedAt: 0, entries: [] };
    if (!force && Date.now() - wagerCache.checkedAt < 1_000) return wagerCache.entries;
    const filter = vaultRead.filters.WagerOpened(null, r.roundId);
    const logs = await vaultRead.queryFilter(filter, r.commitBlock || 0, "latest");
    const deduped = new Map();
    for (const log of logs) {
      const wagerId = String(log.args.wagerId);
      deduped.set(wagerId, {
        wagerId,
        wallet: normalizeAddress(log.args.player) || String(log.args.player),
        amount: BigInt(log.args.amount),
        blockNumber: Number(log.blockNumber || 0),
        transactionHash: log.transactionHash || null
      });
    }
    wagerCache = { roundId: r.roundId, checkedAt: Date.now(), entries: [...deduped.values()] };
    return wagerCache.entries;
  }
  async function openWagersForRound(r) {
    const events = await wagerEventsForRound(r, true);
    const wagers = [];
    for (const event of events) {
      const data = await vaultRead.wagers(event.wagerId);
      if (!data.settled) wagers.push({ wagerId: event.wagerId, player: data.player, amount: data.amount });
    }
    return wagers;
  }
  async function settleCurrent() {
    const r = state.current;
    if (!r.crashedAt) r.crashedAt = Date.now();
    r.stage = "settling";
    persist();
    const wagers = await openWagersForRound(r);
    for (let offset = 0; offset < wagers.length; offset += 100) {
      const batch = wagers.slice(offset, offset + 100);
      const ids = batch.map(item => item.wagerId);
      const values = batch.map(item => {
        const saved = state.cashouts[item.wagerId];
        return saved && saved.cashoutBps < r.crashPointBps ? saved.cashoutBps : 0;
      });
      if (ids.length) await (await vaultWrite.settleWagers(ids, values)).wait();
    }
    r.settled = true;
    r.stage = "crashed";
    state.history.unshift({ roundNumber: r.counter, roundId: r.roundId, crashPoint: r.crashPointBps / BPS, commitment: r.commitment, seed: r.seed });
    state.history = state.history.slice(0, 30);
    persist();
    console.log(`Crash round ${r.counter} settled (${wagers.length} wagers).`);
  }
  async function tick() {
    if (ticking || !configured || !liveEnabled) return;
    ticking = true;
    try {
      const status = await refreshStatus();
      if (status.paused || !status.solvent) return;
      await ensureCommitted();
      const r = state.current;
      if (r.stage === "committing") await commitCurrent();
      else if ((r.stage === "betting" || r.stage === "revealing") && Date.now() >= r.bettingClosesAt * 1000) await revealCurrent();
      else if (r.stage === "flying" && Date.now() >= crashAt(r)) await settleCurrent();
      else if (r.stage === "settling") await settleCurrent();
      else if (r.stage === "crashed" && Date.now() >= r.crashedAt + CRASHED_MS) {
        state.current = null;
        state.cashouts = {};
        wagerCache = { roundId: null, checkedAt: 0, entries: [] };
        persist();
      }
    } catch (error) {
      console.error("Crash keeper tick failed:", error?.shortMessage || error?.message || error);
      await delay(1_000);
    } finally { ticking = false; }
  }

  const timer = setInterval(tick, 500);
  timer.unref();
  tick();

  function phaseView(now = Date.now()) {
    const r = state.current;
    if (!r) return null;
    const bettingStart = r.bettingClosesAt * 1000 - BETTING_MS;
    if (r.stage === "committing") return { phase: "preparing", multiplier: 1, phaseEndsAt: r.bettingClosesAt * 1000, startAt: bettingStart };
    if (r.stage === "betting") return { phase: "betting", multiplier: 1, phaseEndsAt: r.bettingClosesAt * 1000, startAt: bettingStart };
    if (r.stage === "revealing") return { phase: "launching", multiplier: 1, phaseEndsAt: now + 1_500, startAt: bettingStart };
    if (r.stage === "flying" && now < crashAt(r)) return { phase: "flying", multiplier: observedMultiplierBps(r, now) / BPS, phaseEndsAt: crashAt(r), startAt: r.flightStartedAt - BETTING_MS };
    const impactAt = r.crashedAt || (Number.isFinite(crashAt(r)) ? crashAt(r) : now);
    return { phase: "crashed", multiplier: r.crashPointBps ? r.crashPointBps / BPS : 1, phaseEndsAt: impactAt + CRASHED_MS, startAt: r.flightStartedAt ? r.flightStartedAt - BETTING_MS : bettingStart };
  }
  function playerView(event, r, view) {
    const saved = state.cashouts[event.wagerId];
    const validCashout = saved && r.crashPointBps && saved.cashoutBps < r.crashPointBps;
    let status = "queued";
    if (view.phase === "flying") status = validCashout ? "won" : "playing";
    else if (view.phase === "crashed") status = validCashout ? "won" : "lost";
    else if (view.phase === "launching") status = "locked";
    const cashoutBps = validCashout ? Number(saved.cashoutBps) : 0;
    const payout = validCashout ? (event.amount * BigInt(cashoutBps)) / BigInt(BPS) : 0n;
    return {
      wallet: event.wallet,
      wagerId: event.wagerId,
      amount: event.amount.toString(),
      status,
      cashoutBps,
      cashout: cashoutBps ? cashoutBps / BPS : null,
      payout: payout.toString(),
      transactionHash: event.transactionHash
    };
  }
  async function publicState() {
    const status = await refreshStatus();
    const r = state.current;
    const view = phaseView();
    const events = r && view ? await wagerEventsForRound(r) : [];
    const players = r && view ? events.map(event => playerView(event, r, view)) : [];
    const total = events.reduce((sum, event) => sum + event.amount, 0n);
    const largest = events.reduce((max, event) => event.amount > max ? event.amount : max, 0n);
    return {
      version: 5,
      mode: liveEnabled && configured ? (status.paused ? "LIVE_PAUSED" : "LIVE_MAINNET") : "LIVE_LOCKED",
      serverTime: Date.now(),
      chainId: Number(CHAIN_ID),
      vaultAddress,
      tokenAddress,
      limits: { minWager: asString(status.minWager), maxWager: asString(status.maxWager), maxCashoutBps: asString(status.maxCashoutBps) },
      bankroll: { available: asString(status.bankroll), unreserved: asString(status.unreserved), solvent: status.solvent },
      paused: status.paused,
      round: r && view ? {
        number: r.counter,
        roundId: r.roundId,
        phase: view.phase,
        multiplier: Math.floor(view.multiplier * 10_000) / 10_000,
        crashPoint: view.phase === "crashed" ? r.crashPointBps / BPS : null,
        commitment: r.commitment,
        seed: view.phase === "crashed" ? r.seed : null,
        startAt: view.startAt,
        phaseEndsAt: view.phaseEndsAt
      } : null,
      players,
      summary: { playerCount: players.length, roundTotal: total.toString(), largestBet: largest.toString() },
      bots: [],
      history: state.history.slice(0, 18)
    };
  }

  router.get("/state", async (_req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json(await publicState()); }
    catch (error) { res.status(503).json({ error: "CRASH_STATE_UNAVAILABLE", message: String(error.message || error) }); }
  });
  router.get("/health", async (_req, res) => {
    try {
      const status = await refreshStatus(true);
      const players = state.current ? await wagerEventsForRound(state.current, true) : [];
      res.json({ ok: configured && liveEnabled && status.solvent, configured, liveEnabled, paused: status.paused, solvent: status.solvent, operator: operator?.address || null, vaultAddress, round: state.current?.counter || null, stage: state.current?.stage || "idle", players: players.length });
    } catch (error) { res.status(503).json({ ok: false, error: String(error.message || error) }); }
  });
  router.get("/account/:wallet", async (req, res) => {
    const wallet = normalizeAddress(req.params.wallet);
    if (!wallet) return res.status(400).json({ error: "INVALID_WALLET" });
    try {
      const [balance, allowance, claimable] = await Promise.all([token.balanceOf(wallet), token.allowance(wallet, vaultAddress), vaultRead.claimable(wallet)]);
      res.json({ wallet, balance: balance.toString(), allowance: allowance.toString(), claimable: claimable.toString() });
    } catch (error) { res.status(503).json({ error: "ACCOUNT_UNAVAILABLE", message: String(error.message || error) }); }
  });
  router.post("/cashout", async (req, res) => {
    try {
      const r = state.current;
      const view = phaseView();
      const wallet = normalizeAddress(req.body?.wallet);
      const roundId = String(req.body?.roundId || "");
      const timestamp = Number(req.body?.timestamp || 0);
      const signature = String(req.body?.signature || "");
      if (!wallet || !r || !view || view.phase !== "flying" || roundId !== r.roundId) return res.status(409).json({ error: "ROUND_NOT_FLYING" });
      if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 20_000) return res.status(400).json({ error: "STALE_CASHOUT" });
      const recovered = normalizeAddress(ethers.verifyMessage(cashoutMessage({ vault: vaultAddress, roundId, wallet, timestamp }), signature));
      if (recovered !== wallet) return res.status(401).json({ error: "INVALID_SIGNATURE" });
      const wagerId = ethers.keccak256(ethers.solidityPacked(["uint256", "address", "bytes32", "address"], [CHAIN_ID, vaultAddress, roundId, wallet]));
      const wager = await vaultRead.wagers(wagerId);
      if (normalizeAddress(wager.player) !== wallet || wager.settled) return res.status(409).json({ error: "NO_OPEN_WAGER" });
      if (state.cashouts[wagerId]) return res.json({ ok: true, wagerId, ...state.cashouts[wagerId], duplicate: true });
      const status = await refreshStatus();
      const cashoutBps = Math.min(observedMultiplierBps(r), Number(status.maxCashoutBps));
      if (cashoutBps >= r.crashPointBps) return res.status(409).json({ error: "TOO_LATE" });
      state.cashouts[wagerId] = { wallet, cashoutBps, receivedAt: Date.now() };
      persist();
      wagerCache.checkedAt = 0;
      res.json({ ok: true, wagerId, cashoutBps, multiplier: cashoutBps / BPS });
    } catch (error) { res.status(400).json({ error: "CASHOUT_REJECTED", message: String(error.shortMessage || error.message || error) }); }
  });

  return router;
}

module.exports = { createCrashContractRouter, cashoutMessage };
