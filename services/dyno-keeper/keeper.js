"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const Phase = { FROZEN: 4n, RANDOMNESS_READY: 6n, WINNERS_ASSIGNED: 7n, SETTLED: 8n };
const Schedule = { ACTIVE: 1n, CLOSED: 2n };
const SAFE_ERROR_CODES = new Set(["CHAIN_MISMATCH", "NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "CALL_EXCEPTION", "INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED", "TRANSACTION_REPLACED", "PENDING_TRANSACTION", "CHAIN_DATA_CHANGED", "UNRESOLVED_INTENT", "JOURNAL_UNAVAILABLE"]);
function safeKeeperError(error) {
  return SAFE_ERROR_CODES.has(error?.code) ? error.code : "KEEPER_TICK_FAILED";
}
function hasExpiredPendingSlots(currentSlot, currentStatus, terminalCount) {
  const currentTerminal = currentStatus === 0n ? 0n : 1n;
  return BigInt(terminalCount) - currentTerminal < BigInt(currentSlot);
}
function planActions({ phase, scheduleState, now, endTime, slotStatus, expiredPending }) {
  const actions = [];
  if (phase === Phase.FROZEN) actions.push({ contract: "manager", method: "requestDraw", args: [] });
  if (phase === Phase.RANDOMNESS_READY) actions.push({ contract: "manager", method: "finalizeWinners", args: [] });
  if (phase === Phase.WINNERS_ASSIGNED) actions.push({ contract: "manager", method: "settleRound", args: [] });
  // Prize delivery is manually initiated by the multisig; keeper never sends prizes.
  if (scheduleState === Schedule.ACTIVE) {
    if (now >= endTime) actions.push({ contract: "vault", method: "closeBuyback", args: [] });
    else {
      if (slotStatus === 0n) actions.push({ contract: "vault", method: "executeCurrentSlot", args: [] });
      if (expiredPending) actions.push({ contract: "vault", method: "markExpiredSlots", args: [168] });
    }
  }
  return actions;
}

class DynoKeeper {
  constructor({ rpcUrl, chainId, managerAddress, vaultAddress, privateKey, dryRun = true, roundId = "auto", receiptTimeoutMs = 45_000, journalPath }) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("INVALID_CHAIN_ID");
    if (roundId !== "auto" && (!/^[1-9][0-9]*$/.test(String(roundId)) || BigInt(roundId) >= 2n ** 256n)) throw new Error("INVALID_ROUND_ID");
    if (!Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 5_000 || receiptTimeoutMs > 300_000) throw new Error("INVALID_RECEIPT_TIMEOUT");
    if (!dryRun && !privateKey) throw new Error("KEEPER_SIGNER_REQUIRED");
    if (!dryRun && (!journalPath || !path.isAbsolute(journalPath))) throw new Error("KEEPER_JOURNAL_REQUIRED");
    this.provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }); this.chainId = BigInt(chainId); this.dryRun = dryRun; this.roundId = roundId === "auto" ? null : BigInt(roundId); this.receiptTimeoutMs = receiptTimeoutMs;
    // Production-only installs intentionally omit Hardhat artifacts.
    const managerAbi = require("../../packages/abis/ProjectDynoRaffleManager.json").abi;
    const vaultAbi = require("../../packages/abis/ProjectDynoBuybackVault.json").abi;
    const runner = privateKey ? new Wallet(privateKey, this.provider) : this.provider;
    this.signerAddress = privateKey ? runner.address : null;
    this.manager = new Contract(managerAddress, managerAbi, runner); this.vault = new Contract(vaultAddress, vaultAbi, runner);
    this.journalPath = journalPath || null;
    this.journalIdentity = { chainId: String(chainId), signer: this.signerAddress?.toLowerCase(), manager: managerAddress.toLowerCase(), vault: vaultAddress.toLowerCase() };
    this.last = { ok: false, message: "not started", checkedAt: null };
  }
  readJournal() {
    if (!this.journalPath || !fs.existsSync(this.journalPath)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.journalPath, "utf8"));
      if (!value || Object.keys(this.journalIdentity).some(key => value[key] !== this.journalIdentity[key]) || !["PREPARED", "SUBMITTED", "CONFIRMED", "REVERTED"].includes(value.state)) throw new Error("INVALID_JOURNAL");
      return value;
    } catch { throw Object.assign(new Error("JOURNAL_UNAVAILABLE"), { code: "JOURNAL_UNAVAILABLE" }); }
  }
  writeJournal(intent) {
    const value = { ...this.journalIdentity, ...intent, updatedAt: new Date().toISOString() };
    const directory = path.dirname(this.journalPath);
    const temporary = `${this.journalPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      const descriptor = fs.openSync(temporary, "r+");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.journalPath);
    } catch {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* retain the original failure */ }
      throw Object.assign(new Error("JOURNAL_UNAVAILABLE"), { code: "JOURNAL_UNAVAILABLE" });
    }
    return value;
  }
  async reconcileJournal() {
    const intent = this.readJournal();
    if (!intent || intent.state === "CONFIRMED" || intent.state === "REVERTED") return;
    if (intent.state === "SUBMITTED" && /^0x[0-9a-fA-F]{64}$/.test(intent.hash || "")) {
      const receipt = await this.provider.getTransactionReceipt(intent.hash);
      if (receipt) {
        this.writeJournal({ ...intent, state: receipt.status === 1 ? "CONFIRMED" : "REVERTED", receiptBlock: receipt.blockNumber });
      }
    }
    // A PREPARED intent may have broadcast before a crash but lost its hash.
    // Never guess that it is safe to resend or use a later hourly slot.
    throw Object.assign(new Error("UNRESOLVED_INTENT"), { code: "UNRESOLVED_INTENT" });
  }
  async tick() {
    const reportedChainId = await this.provider.send("eth_chainId", []);
    if (BigInt(reportedChainId) !== this.chainId) throw Object.assign(new Error("CHAIN_MISMATCH"), { code: "CHAIN_MISMATCH" });
    if (!this.dryRun) await this.reconcileJournal();
    const block = await this.provider.getBlock("latest");
    const at = { blockTag: block.number };
    const roundId = this.roundId ?? BigInt(await this.manager.activeRoundId(at));
    const round = roundId ? await this.manager.getRoundStatus(roundId, at) : { phase: 0n };
    const schedule = await this.vault.getSchedule(at);
    let slotStatus = -1n;
    let expiredPending = false;
    if (schedule.state === Schedule.ACTIVE && BigInt(block.timestamp) < schedule.endsAt && BigInt(block.timestamp) >= schedule.startsAt) {
      const slot = Number((BigInt(block.timestamp) - schedule.startsAt) / 3600n);
      slotStatus = await this.vault.getSlotStatus(slot, at);
      if (slot > 0) {
        const terminalCount = await this.vault.terminalSlotCount(at);
        expiredPending = hasExpiredPendingSlots(slot, slotStatus, terminalCount);
      }
    }
    const actions = planActions({ phase: round.phase, scheduleState: schedule.state, now: BigInt(block.timestamp), endTime: schedule.endsAt, slotStatus, expiredPending });
    const results = [];
    // Only one live action per tick: after it lands, re-read chain time/state before
    // deciding which slot or phase transition is next.
    for (const action of this.dryRun ? actions : actions.slice(0, 1)) {
      const args = action.contract === "manager" ? [roundId] : action.args;
      if (this.dryRun) { results.push({ ...action, args: args.map(String), dryRun: true }); continue; }
      const canonical = await this.provider.getBlock(block.number);
      if (!block.hash || canonical?.hash !== block.hash) throw Object.assign(new Error("CHAIN_DATA_CHANGED"), { code: "CHAIN_DATA_CHANGED" });
      const [latestNonce, pendingNonce] = await Promise.all([
        this.provider.getTransactionCount(this.signerAddress, "latest"),
        this.provider.getTransactionCount(this.signerAddress, "pending"),
      ]);
      if (!Number.isSafeInteger(latestNonce) || !Number.isSafeInteger(pendingNonce) || pendingNonce < latestNonce) throw Object.assign(new Error("KEEPER_NONCE_UNAVAILABLE"), { code: "KEEPER_NONCE_UNAVAILABLE" });
      if (pendingNonce !== latestNonce) throw Object.assign(new Error("PENDING_TRANSACTION"), { code: "PENDING_TRANSACTION" });
      const contract = action.contract === "manager" ? this.manager : this.vault;
      const intent = this.writeJournal({ state: "PREPARED", roundId: roundId.toString(), contract: action.contract, method: action.method, args: args.map(String), nonce: pendingNonce, plannedBlockHash: block.hash });
      const tx = await contract[action.method](...args, { nonce: pendingNonce });
      this.writeJournal({ ...intent, state: "SUBMITTED", hash: tx.hash });
      let timer;
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("PENDING_TRANSACTION"), { code: "PENDING_TRANSACTION" })), this.receiptTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (!receipt || receipt.status !== 1) throw Object.assign(new Error("CALL_EXCEPTION"), { code: "CALL_EXCEPTION" });
      this.writeJournal({ ...intent, state: "CONFIRMED", hash: receipt.hash, receiptBlock: receipt.blockNumber });
      results.push({ ...action, transactionHash: receipt.hash, blockNumber: receipt.blockNumber });
    }
    this.last = { ok: true, blockNumber: block.number, roundId: roundId.toString(), checkedAt: new Date().toISOString(), actions: results };
    return this.last;
  }
}

async function main() {
  for (const name of ["DYNO_RPC_URL", "DYNO_CHAIN_ID", "DYNO_RAFFLE_ADDRESS", "DYNO_BUYBACK_ADDRESS"]) if (!process.env[name]) throw new Error(`${name} is required`);
  if (process.env.DYNO_KEEPER_LIVE === "true" && !process.env.DYNO_KEEPER_PRIVATE_KEY) throw new Error("KEEPER_SIGNER_REQUIRED");
  const keeper = new DynoKeeper({ rpcUrl: process.env.DYNO_RPC_URL, chainId: Number(process.env.DYNO_CHAIN_ID), managerAddress: process.env.DYNO_RAFFLE_ADDRESS, vaultAddress: process.env.DYNO_BUYBACK_ADDRESS, privateKey: process.env.DYNO_KEEPER_PRIVATE_KEY, dryRun: process.env.DYNO_KEEPER_LIVE !== "true", roundId: process.env.DYNO_ROUND_ID || "auto", journalPath: process.env.DYNO_KEEPER_JOURNAL_PATH });
  const port = Number(process.env.DYNO_KEEPER_HEALTH_PORT || 9464);
  http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(keeper.last)); }).listen(port, "127.0.0.1");
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { console.log(JSON.stringify(await keeper.tick())); }
    catch (error) { keeper.last = { ok: false, checkedAt: new Date().toISOString(), code: safeKeeperError(error) }; console.error(JSON.stringify(keeper.last)); }
    finally { running = false; }
  };
  await run(); setInterval(run, Number(process.env.DYNO_KEEPER_INTERVAL_MS || 30000));
}
if (require.main === module) main().catch(() => { console.error("DYNO keeper startup failed; credentials and provider details withheld."); process.exitCode = 1; });
module.exports = { DynoKeeper, planActions, hasExpiredPendingSlots, safeKeeperError, Phase, Schedule };
