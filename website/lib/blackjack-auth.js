const crypto = require("crypto");
const { verifyMessage } = require("@ethersproject/wallet");

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;

function createBlackjackAuth() {
  const challenges = new Map();
  const sessions = new Map();

  function normalizeWallet(value) {
    const wallet = String(value || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error("A valid Ronin wallet address is required.");
    return wallet;
  }

  function issueChallenge(walletValue) {
    const wallet = normalizeWallet(walletValue);
    const nonce = crypto.randomBytes(24).toString("hex");
    const issuedAt = new Date().toISOString();
    const message = [
      "MATT Live Blackjack login",
      "",
      `Wallet: ${wallet}`,
      `Nonce: ${nonce}`,
      `Issued at: ${issuedAt}`,
      "",
      "Signing proves wallet ownership. It does not approve or move tokens."
    ].join("\n");
    challenges.set(wallet, { nonce, message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { wallet, message, expiresAt: Date.now() + CHALLENGE_TTL_MS };
  }

  function verify(walletValue, signatureValue) {
    const wallet = normalizeWallet(walletValue);
    const challenge = challenges.get(wallet);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      challenges.delete(wallet);
      throw new Error("Login challenge expired. Request a new one.");
    }
    const recovered = verifyMessage(challenge.message, String(signatureValue || "")).toLowerCase();
    if (recovered !== wallet) throw new Error("Wallet signature did not match the requested address.");
    challenges.delete(wallet);
    revokeWallet(wallet);
    const token = crypto.randomBytes(32).toString("base64url");
    const session = { wallet, expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(token, session);
    return { token, wallet, expiresAt: session.expiresAt };
  }

  function authenticate(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      throw new Error("Wallet session is missing or expired. Sign in again.");
    }
    return session;
  }

  function revoke(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) sessions.delete(token);
  }

  function revokeWallet(wallet) {
    for (const [token, session] of sessions) {
      if (session.wallet === wallet) sessions.delete(token);
    }
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [wallet, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(wallet);
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  }, 60_000);
  cleanup.unref?.();

  return { issueChallenge, verify, authenticate, revoke };
}

module.exports = { createBlackjackAuth };
