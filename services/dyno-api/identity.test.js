"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const { identityCommitment, walletChallenge, verifyWalletChallenge, voucherExpiry } = require("./identity");

test("identity commitments are stable and secret-keyed", () => {
  const secret = "x".repeat(32);
  assert.equal(identityCommitment("123", secret), identityCommitment("123", secret));
  assert.notEqual(identityCommitment("123", secret), identityCommitment("124", secret));
  assert.throws(() => identityCommitment("123", "short"));
});
test("wallet challenge expires and verifies its exact wallet", async () => {
  const wallet = Wallet.createRandom(); const now = 1_700_000_000_000;
  const challenge = walletChallenge({ wallet: wallet.address, domain: "localhost", uri: "http://localhost/dyno", chainId: 31337, now });
  const signature = await wallet.signMessage(challenge.message);
  assert.equal(verifyWalletChallenge(challenge, signature, wallet.address, now + 1000), true);
  assert.equal(verifyWalletChallenge(challenge, signature, Wallet.createRandom().address, now + 1000), false);
  assert.equal(verifyWalletChallenge(challenge, signature, wallet.address, now + 301000), false);
  assert.equal(verifyWalletChallenge(challenge, signature, wallet.address, now + 300000), false);
  assert.equal(verifyWalletChallenge(challenge, "broken", wallet.address, now), false);
  assert.equal(verifyWalletChallenge({ ...challenge, expiresAt: "invalid" }, signature, wallet.address, now), false);
});
test("voucher never crosses a UTC day boundary", () => {
  assert.deepEqual(voucherExpiry(86390), { dayIndex: 0, expiry: 86399 });
});
