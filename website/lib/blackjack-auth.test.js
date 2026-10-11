const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("ethers");
const { createBlackjackAuth } = require("./blackjack-auth");

test("accepts an ethers v6 wallet signature and prevents challenge replay", async () => {
  const auth = createBlackjackAuth();
  const wallet = Wallet.createRandom();
  const challenge = auth.issueChallenge(wallet.address);
  const signature = await wallet.signMessage(challenge.message);
  const session = auth.verify(wallet.address, signature);
  const req = { headers: { authorization: `Bearer ${session.token}` } };
  assert.equal(auth.authenticate(req).wallet, wallet.address.toLowerCase());
  assert.throws(() => auth.verify(wallet.address, signature), /challenge expired/i);
  auth.revoke(req);
  assert.throws(() => auth.authenticate(req), /missing or expired/i);
});

test("rejects a signature from a different wallet", async () => {
  const auth = createBlackjackAuth();
  const wallet = Wallet.createRandom();
  const otherWallet = Wallet.createRandom();
  const challenge = auth.issueChallenge(wallet.address);
  const signature = await otherWallet.signMessage(challenge.message);
  assert.throws(() => auth.verify(wallet.address, signature), /did not match/i);
});
