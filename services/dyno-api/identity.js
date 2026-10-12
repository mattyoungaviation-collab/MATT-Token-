"use strict";

const crypto = require("crypto");
const { Wallet, verifyMessage } = require("ethers");

const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
function identityCommitment(discordUserId, secret) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("DYNO_IDENTITY_SECRET must contain at least 32 bytes");
  return `0x${crypto.createHmac("sha256", secret).update(`discord:v1:${discordUserId}`).digest("hex")}`;
}
function walletChallenge({ wallet, domain, uri, chainId, ttlSeconds = 300, now = Date.now() }) {
  const nonce = random(24);
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
  const message = `${domain} wants you to sign in with your Ronin account:\n${wallet}\n\nProject DYNO authentication. This does not authorize a transaction.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  return { nonce, issuedAt, expiresAt, message };
}
function verifyWalletChallenge(challenge, signature, expectedWallet, now = Date.now()) {
  if (!challenge || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= now) return false;
  try { return verifyMessage(challenge.message, signature).toLowerCase() === expectedWallet.toLowerCase(); }
  catch { return false; }
}
function voucherExpiry(nowSeconds = Math.floor(Date.now() / 1000)) {
  const dayIndex = Math.floor(nowSeconds / 86400);
  return { dayIndex, expiry: Math.min(nowSeconds + 300, (dayIndex + 1) * 86400 - 1) };
}
async function signPurchaseVoucher({ privateKey, chainId, manager, roundId, commitment, wallet, quantity, identityVersion, nonce, nowSeconds }) {
  if (!privateKey) throw new Error("DYNO_IDENTITY_SIGNER_PRIVATE_KEY is not configured");
  const signer = new Wallet(privateKey);
  const { dayIndex, expiry } = voucherExpiry(nowSeconds);
  const voucher = { roundId, accountCommitment: commitment, wallet, quantity, identityVersion, nonce, dayIndex, expiry };
  const domain = { name: "Project DYNO", version: "1", chainId, verifyingContract: manager };
  const types = { PurchaseVoucher: [
    { name: "roundId", type: "uint256" }, { name: "accountCommitment", type: "bytes32" }, { name: "wallet", type: "address" },
    { name: "quantity", type: "uint8" }, { name: "identityVersion", type: "uint32" }, { name: "nonce", type: "bytes32" },
    { name: "dayIndex", type: "uint64" }, { name: "expiry", type: "uint64" },
  ] };
  return { voucher, signature: await signer.signTypedData(domain, types, voucher), signer: signer.address };
}
module.exports = { identityCommitment, walletChallenge, verifyWalletChallenge, voucherExpiry, signPurchaseVoucher, random };
