const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { verifyMessage } = require("ethers");

const CHALLENGE_TTL_MS = 5 * 60_000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function installWalletProfiles(app, options = {}) {
  const stateFile = String(options.stateFile || process.env.WALLET_PROFILES_FILE || "").trim();
  const router = express.Router();
  const challenges = new Map();
  let state = loadState(stateFile);

  router.use(express.json({ limit: "16kb" }));

  router.get("/:wallet", (req, res) => {
    const wallet = normalizeWallet(req.params.wallet);
    if (!wallet) return res.status(400).json({ error: "INVALID_WALLET", message: "A valid Ronin wallet is required." });
    return res.json({ wallet, username: state.wallets[wallet]?.username || null });
  });

  router.post("/lookup", (req, res) => {
    const wallets = Array.isArray(req.body?.wallets) ? req.body.wallets.slice(0, 100) : [];
    const profiles = {};
    for (const value of wallets) {
      const wallet = normalizeWallet(value);
      if (wallet && state.wallets[wallet]) profiles[wallet] = state.wallets[wallet];
    }
    return res.json({ profiles });
  });

  router.post("/challenge", (req, res) => {
    const wallet = normalizeWallet(req.body?.wallet);
    const username = normalizeUsername(req.body?.username);
    if (!wallet) return res.status(400).json({ error: "INVALID_WALLET", message: "Connect a valid Ronin wallet first." });
    if (!username) return res.status(400).json({ error: "INVALID_USERNAME", message: "Use 3–20 letters, numbers, or underscores." });
    const key = username.toLowerCase();
    const owner = state.names[key];
    if (owner && owner !== wallet) return res.status(409).json({ error: "USERNAME_TAKEN", message: "That username is already taken." });
    const nonce = crypto.randomBytes(24).toString("hex");
    const issuedAt = new Date().toISOString();
    const message = [
      "MATT username update",
      "",
      `Wallet: ${wallet}`,
      `Username: ${username}`,
      `Nonce: ${nonce}`,
      `Issued at: ${issuedAt}`,
      "",
      "Signing proves wallet ownership. It does not approve or move tokens."
    ].join("\n");
    challenges.set(wallet, { wallet, username, message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return res.json({ wallet, username, message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  });

  router.post("/verify", (req, res) => {
    const wallet = normalizeWallet(req.body?.wallet);
    const signature = String(req.body?.signature || "");
    const challenge = wallet ? challenges.get(wallet) : null;
    if (!challenge || challenge.expiresAt <= Date.now()) {
      if (wallet) challenges.delete(wallet);
      return res.status(400).json({ error: "CHALLENGE_EXPIRED", message: "Username request expired. Try again." });
    }
    let recovered;
    try { recovered = verifyMessage(challenge.message, signature).toLowerCase(); }
    catch { return res.status(400).json({ error: "INVALID_SIGNATURE", message: "The wallet signature could not be verified." }); }
    if (recovered !== wallet) return res.status(403).json({ error: "WALLET_MISMATCH", message: "The signature does not match this wallet." });

    const key = challenge.username.toLowerCase();
    const existingOwner = state.names[key];
    if (existingOwner && existingOwner !== wallet) return res.status(409).json({ error: "USERNAME_TAKEN", message: "That username was just claimed by another wallet." });
    const previous = state.wallets[wallet]?.username;
    if (previous) delete state.names[previous.toLowerCase()];
    const profile = { wallet, username: challenge.username, updatedAt: new Date().toISOString() };
    state.wallets[wallet] = profile;
    state.names[key] = wallet;
    challenges.delete(wallet);
    saveState(stateFile, state);
    return res.json(profile);
  });

  app.use("/api/profiles", router);
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [wallet, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(wallet);
  }, 60_000);
  cleanup.unref?.();

  return {
    getUsername(walletValue) {
      const wallet = normalizeWallet(walletValue);
      return wallet ? state.wallets[wallet]?.username || null : null;
    },
    getProfiles(walletValues) {
      const output = {};
      for (const value of walletValues || []) {
        const wallet = normalizeWallet(value);
        if (wallet && state.wallets[wallet]) output[wallet] = state.wallets[wallet];
      }
      return output;
    }
  };
}

function normalizeWallet(value) {
  const wallet = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null;
}
function normalizeUsername(value) {
  const username = String(value || "").trim();
  return USERNAME_RE.test(username) ? username : null;
}
function loadState(file) {
  try {
    if (!file || !fs.existsSync(file)) return { version: 1, wallets: {}, names: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.version === 1 && parsed.wallets && parsed.names ? parsed : { version: 1, wallets: {}, names: {} };
  } catch { return { version: 1, wallets: {}, names: {} }; }
}
function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
}

module.exports = { installWalletProfiles };
