"use strict";

const { ZeroAddress, ZeroHash, getAddress } = require("ethers");

class PurchaseStateError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const reject = (code, status) => { throw new PurchaseStateError(code, status); };

// These are advisory reads, not reservations. The purchase transaction repeats every
// check on chain, so two outstanding vouchers cannot bypass quotas or capacity.
async function readPurchaseState({ provider, manager, chainId, roundId, commitment, wallet, nowSeconds, maximumAgeSeconds = 120 }) {
  if (!provider || !manager) reject("CHAIN_STATE_UNAVAILABLE", 503);
  if (!/^[1-9][0-9]{0,77}$/.test(String(roundId)) || BigInt(roundId) >= 2n ** 256n) reject("INVALID_ROUND", 400);
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId)) reject("CHAIN_MISMATCH", 503);
  const block = await provider.getBlock("latest");
  if (!block?.hash || !Number.isSafeInteger(block.timestamp) || block.timestamp > nowSeconds + 30 || nowSeconds - block.timestamp > maximumAgeSeconds) reject("STALE_CHAIN_STATE", 503);
  const dayIndex = Math.floor(nowSeconds / 86400);
  // Do not sign for yesterday just because a node has not served today's block yet.
  if (Math.floor(block.timestamp / 86400) !== dayIndex) reject("STALE_CHAIN_STATE", 503);
  const at = { blockTag: block.number };
  const [activeRoundId, round, heldMatt, paused, suspended, version, boundWallet, boundAccount, accountUsed, walletUsed, signer] = await Promise.all([
    manager.activeRoundId(at), manager.getRoundStatus(roundId, at), manager.mattActive(roundId, at), manager.checkoutPaused(at),
    manager.accountSuspended(commitment, at), manager.identityVersion(commitment, at),
    manager.walletForAccount(commitment, at), manager.accountForWallet(wallet, at),
    manager.accountDayCount(commitment, dayIndex, at), manager.walletDayCount(wallet, dayIndex, at), manager.identitySigner(at),
  ]);
  const confirmation = await provider.getBlock(block.number);
  if (!confirmation || confirmation.hash !== block.hash) reject("CHAIN_STATE_CHANGED", 503);
  const accountCount = Number(accountUsed), walletCount = Number(walletUsed), identityVersion = Number(version);
  const eligibleCount = Number(round.eligibleCount), phase = Number(round.phase);
  if (typeof heldMatt !== "bigint" || heldMatt < 0n || ![accountCount, walletCount].every(n => Number.isInteger(n) && n >= 0 && n <= 3) ||
      !Number.isInteger(identityVersion) || identityVersion < 0 || identityVersion > 0xffffffff ||
      !Number.isInteger(eligibleCount) || eligibleCount < 0 || eligibleCount > 1000 || !Number.isInteger(phase)) reject("MALFORMED_CHAIN_STATE", 503);
  const walletMatches = getAddress(boundWallet) === getAddress(wallet);
  const accountMatches = boundAccount.toLowerCase() === commitment.toLowerCase();
  let blockedReason = null;
  if (String(activeRoundId) !== String(roundId)) blockedReason = "WRONG_ROUND";
  else if (phase !== 2) blockedReason = "ROUND_NOT_OPEN";
  else if (paused) blockedReason = "CHECKOUT_PAUSED";
  else if (suspended) blockedReason = "ACCOUNT_SUSPENDED";
  else if (identityVersion === 0 && getAddress(boundWallet) !== ZeroAddress) blockedReason = "RELINK_REQUIRED";
  else if (identityVersion === 0 && boundAccount !== ZeroHash) blockedReason = "WALLET_ALREADY_LINKED";
  else if (identityVersion !== 0 && (!walletMatches || !accountMatches)) blockedReason = "RELINK_REQUIRED";
  const remaining = Math.min(3 - accountCount, 3 - walletCount);
  if (!blockedReason && remaining === 0) blockedReason = "DAILY_LIMIT";
  if (!blockedReason && eligibleCount === 1000) blockedReason = "CAPACITY";
  return {
    roundId: String(roundId), wallet: getAddress(wallet), dayIndex, resetAt: (dayIndex + 1) * 86400,
    identityVersion: identityVersion || 1, accountUsed: accountCount, walletUsed: walletCount, remaining,
    bindingConfirmed: identityVersion > 0,
    capacityRemaining: 1000 - eligibleCount, blockedReason, signer: getAddress(signer),
    blockNumber: String(block.number), blockHash: block.hash, chainTimestamp: block.timestamp,
    freshness: "chain-read", advisory: true,
  };
}

function requirePurchasable(state, quantity, signerAddress) {
  if (state.blockedReason) reject(state.blockedReason);
  if (![1, 2, 3].includes(quantity)) reject("INVALID_QUANTITY", 400);
  if (quantity > state.remaining) reject("DAILY_LIMIT");
  if (quantity > state.capacityRemaining) reject("CAPACITY");
  if (getAddress(signerAddress) !== state.signer) reject("SIGNER_MISMATCH", 503);
}

module.exports = { readPurchaseState, requirePurchasable, PurchaseStateError };
