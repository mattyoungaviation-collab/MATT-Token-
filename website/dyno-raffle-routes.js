const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { verifyMessage, getAddress, zeroPadValue, toBeHex } = require("ethers");
const { getXSession } = require("./x-follow-verifier-v2");

const TOKEN = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF = "0x70a08231";
const ONE_MATT = 10n ** 18n;
const DAY_MS = 86_400_000;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const nonces = new Map();

function installDynoRaffle(app, options = {}) {
  const express = require("express");
  app.use("/api/dyno-raffle", express.json({ limit: "24kb" }));

  const stateFile = options.stateFile || path.join(__dirname, ".dyno-raffle.json");
  const rpcRequest = options.rpcRequest;
  const startAt = Date.parse(process.env.DYNO_RAFFLE_START_AT || "2026-07-22T00:00:00Z");
  const endAt = Date.parse(process.env.DYNO_RAFFLE_END_AT || new Date(startAt + 30 * DAY_MS).toISOString());
  const wagerContracts = String(process.env.DYNO_RAFFLE_WAGER_CONTRACTS || "")
    .split(",").map(value => value.trim().toLowerCase()).filter(value => addressPattern.test(value));
  const burnTargets = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    TOKEN.toLowerCase(),
  ]);
  const state = loadState(stateFile);

  app.get("/api/dyno-raffle/config", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      prize: "Water Dyno #1154",
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      thresholds: { one: "10000000", two: "20000000", three: "50000000", bonus: "1000000" },
      xRequired: true,
      wagerBonusEnabled: wagerContracts.length > 0,
    });
  });

  app.get("/api/dyno-raffle/entries", (_req, res) => {
    const entries = [...state.entries].sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));
    res.set("Cache-Control", "no-store").json({
      entries: entries.slice(0, 250),
      summary: {
        entryCount: entries.length,
        totalTickets: entries.reduce((sum, entry) => sum + entry.tickets, 0),
        uniqueEntrants: new Set(entries.map(entry => entry.xUserHash)).size,
      },
    });
  });

  app.post("/api/dyno-raffle/nonce", (req, res) => {
    const wallet = normalizeAddress(req.body?.wallet);
    if (!wallet) return res.status(400).json({ error: "A valid Ronin wallet is required." });
    const nonce = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 10 * 60_000;
    nonces.set(wallet, { nonce, expiresAt });
    res.json({ nonce, expiresAt, message: signatureMessage(wallet, nonce) });
  });

  app.post("/api/dyno-raffle/enter", async (req, res) => {
    try {
      if (Date.now() < startAt || Date.now() >= endAt) return res.status(403).json({ error: "The Water Dyno raffle is not currently open." });
      const wallet = normalizeAddress(req.body?.wallet);
      const signature = String(req.body?.signature || "");
      if (!wallet || !signature) return res.status(400).json({ error: "Wallet and signature are required." });

      const session = getXSession(req);
      if (!session?.verified || !session.xUserId) return res.status(401).json({ error: "Verify your X account before entering." });
      if (session.wallet !== wallet) return res.status(400).json({ error: "The verified X session belongs to a different wallet." });

      const nonceRecord = nonces.get(wallet);
      nonces.delete(wallet);
      if (!nonceRecord || nonceRecord.expiresAt < Date.now()) return res.status(400).json({ error: "Your signing request expired. Try again." });
      const recovered = verifyMessage(signatureMessage(wallet, nonceRecord.nonce), signature).toLowerCase();
      if (recovered !== wallet) return res.status(403).json({ error: "Wallet signature did not match the connected wallet." });

      const day = new Date().toISOString().slice(0, 10);
      const xUserHash = crypto.createHash("sha256").update(String(session.xUserId)).digest("hex");
      if (state.entries.some(entry => entry.day === day && entry.xUserHash === xUserHash)) return res.status(409).json({ error: "This X account has already entered today." });
      if (state.entries.some(entry => entry.day === day && entry.wallet === wallet)) return res.status(409).json({ error: "This wallet has already entered today." });

      const balanceRaw = await tokenBalance(rpcRequest, wallet);
      const baseTickets = balanceRaw >= 50_000_000n * ONE_MATT ? 3 : balanceRaw >= 20_000_000n * ONE_MATT ? 2 : balanceRaw >= 10_000_000n * ONE_MATT ? 1 : 0;
      if (!baseTickets) return res.status(403).json({ error: "You need at least 10,000,000 MATT in this wallet to enter." });

      const fromBlock = await utcDayStartBlock(rpcRequest);
      const burnedRaw = await transferredToTargets(rpcRequest, wallet, [...burnTargets], fromBlock);
      const wageredRaw = wagerContracts.length ? await transferredToTargets(rpcRequest, wallet, wagerContracts, fromBlock) : 0n;
      const burnBonus = burnedRaw >= 1_000_000n * ONE_MATT ? 1 : 0;
      const wagerBonus = wageredRaw >= 1_000_000n * ONE_MATT ? 1 : 0;
      const tickets = baseTickets + burnBonus + wagerBonus;
      const entry = {
        id: crypto.randomUUID(), day, wallet, username: session.username || "verified",
        xUserHash, balanceRaw: balanceRaw.toString(), baseTickets, burnBonus, wagerBonus, tickets,
        burnedRaw: burnedRaw.toString(), wageredRaw: wageredRaw.toString(), enteredAt: new Date().toISOString(),
      };
      state.entries.push(entry);
      saveState(stateFile, state);
      res.json({ ok: true, entry: publicEntry(entry) });
    } catch (error) {
      console.error("Dyno raffle entry failed:", error);
      res.status(502).json({ error: String(error?.message || error).slice(0, 220) });
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [wallet, record] of nonces) if (record.expiresAt < now) nonces.delete(wallet);
  }, 60_000).unref();
}

function normalizeAddress(value) {
  try { return getAddress(String(value || "")).toLowerCase(); } catch { return ""; }
}
function signatureMessage(wallet, nonce) { return `MATT Water Dyno #1154 daily raffle\nWallet: ${wallet}\nNonce: ${nonce}\nThis signature does not authorize a transaction.`; }
function loadState(file) {
  try { const value = JSON.parse(fs.readFileSync(file, "utf8")); return { entries: Array.isArray(value.entries) ? value.entries : [] }; }
  catch { return { entries: [] }; }
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file);
}
function publicEntry(entry) {
  return { id: entry.id, day: entry.day, wallet: entry.wallet, username: entry.username, baseTickets: entry.baseTickets, burnBonus: entry.burnBonus, wagerBonus: entry.wagerBonus, tickets: entry.tickets, enteredAt: entry.enteredAt };
}
async function tokenBalance(rpcRequest, wallet) {
  if (typeof rpcRequest !== "function") throw new Error("Raffle RPC is unavailable.");
  const data = `${BALANCE_OF}${wallet.slice(2).padStart(64, "0")}`;
  return BigInt(await rpcRequest("eth_call", [{ to: TOKEN, data }, "latest"]));
}
async function utcDayStartBlock(rpcRequest) {
  const latest = Number.parseInt(await rpcRequest("eth_blockNumber", []), 16);
  const target = Math.floor(Date.now() / 1000 / 86400) * 86400;
  let low = Math.max(0, latest - 200_000), high = latest;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const block = await rpcRequest("eth_getBlockByNumber", [toBeHex(mid), false]);
    const timestamp = Number.parseInt(block.timestamp, 16);
    if (timestamp < target) low = mid + 1; else high = mid;
  }
  return low;
}
async function transferredToTargets(rpcRequest, wallet, targets, fromBlock) {
  let total = 0n;
  const fromTopic = zeroPadValue(wallet, 32);
  for (const target of targets) {
    const toTopic = zeroPadValue(target, 32);
    const logs = await rpcRequest("eth_getLogs", [{ address: TOKEN, fromBlock: toBeHex(fromBlock), toBlock: "latest", topics: [TRANSFER_TOPIC, fromTopic, toTopic] }]);
    for (const log of logs || []) total += BigInt(log.data || "0x0");
  }
  return total;
}

module.exports = { installDynoRaffle };
