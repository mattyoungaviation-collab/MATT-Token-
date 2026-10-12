"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ZeroAddress, ZeroHash, Wallet } = require("ethers");
const { readPurchaseState, requirePurchasable } = require("./purchase-state");
const wallet = Wallet.createRandom().address, signer = Wallet.createRandom().address;
const commitment = "0x" + "ab".repeat(32), hash = "0x" + "12".repeat(32);
function fixture(overrides = {}) {
  const nowSeconds = 86400 * 20000 + 1000;
  const calls = [];
  const values = { activeRoundId: 1n, getRoundStatus: { phase: 2n, eligibleCount: 998n }, checkoutPaused: false,
    accountSuspended: false, identityVersion: 0n, walletForAccount: ZeroAddress, accountForWallet: ZeroHash,
    accountDayCount: 0n, walletDayCount: 0n, identitySigner: signer, ...overrides };
  const manager = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, async (...args) => { calls.push({ name, args }); return value; }]));
  const block = { number: 100, hash, timestamp: nowSeconds };
  const provider = { send: async () => "0x7a69", getBlock: async () => block };
  const input = { provider, manager, chainId: 31337, roundId: "1", commitment, wallet, nowSeconds };
  return { input, block, calls };
}
test("all eligibility and global daily counters are read at one hashed block; first binding uses version one", async () => {
  const f = fixture(), state = await readPurchaseState(f.input);
  assert.equal(state.remaining, 3); assert.equal(state.capacityRemaining, 2); assert.equal(state.identityVersion, 1);
  assert.equal(state.blockHash, hash); assert.equal(state.blockNumber, "100"); assert.equal(state.advisory, true);
  assert.equal(f.calls.length, 10);
  for (const call of f.calls) assert.deepEqual(call.args.at(-1), { blockTag: 100 });
  assert.equal(f.calls.find(c => c.name === "accountDayCount").args[1], 20000);
  assert.throws(() => requirePurchasable(state, 3, signer), { code: "CAPACITY" });
  assert.doesNotThrow(() => requirePurchasable(state, 2, signer));
});
test("wallet and account limits both apply, and a relink retains the account's used allowance/version", async () => {
  let state = await readPurchaseState(fixture({ accountDayCount: 2n, walletDayCount: 1n, identityVersion: 4n, walletForAccount: wallet, accountForWallet: commitment }).input);
  assert.equal(state.remaining, 1); assert.equal(state.identityVersion, 4);
  assert.throws(() => requirePurchasable(state, 2, signer), { code: "DAILY_LIMIT" });
  state = await readPurchaseState(fixture({ walletDayCount: 3n }).input);
  assert.equal(state.remaining, 0); assert.equal(state.blockedReason, "DAILY_LIMIT");
});
test("mismatched links, suspended accounts, paused checkout and non-open rounds cannot get vouchers", async () => {
  for (const [overrides, reason] of [
    [{ identityVersion: 2n, walletForAccount: Wallet.createRandom().address, accountForWallet: commitment }, "RELINK_REQUIRED"],
    [{ accountForWallet: commitment }, "WALLET_ALREADY_LINKED"], [{ accountSuspended: true }, "ACCOUNT_SUSPENDED"],
    [{ checkoutPaused: true }, "CHECKOUT_PAUSED"], [{ getRoundStatus: { phase: 3n, eligibleCount: 1000n } }, "ROUND_NOT_OPEN"],
    [{ activeRoundId: 2n }, "WRONG_ROUND"],
  ]) {
    const state = await readPurchaseState(fixture(overrides).input);
    assert.equal(state.blockedReason, reason); assert.throws(() => requirePurchasable(state, 1, signer), { code: reason });
  }
});
test("signer rotation fails closed until the service uses the accepted on-chain signer", async () => {
  const state = await readPurchaseState(fixture().input);
  assert.throws(() => requirePurchasable(state, 1, Wallet.createRandom().address), { code: "SIGNER_MISMATCH" });
});
test("chain mismatch, stale/future blocks, reorgs and malformed counters are rejected", async () => {
  const mismatch = fixture(); mismatch.input.provider.send = async () => "0x1";
  await assert.rejects(readPurchaseState(mismatch.input), { code: "CHAIN_MISMATCH" });
  for (const offset of [-121, 31]) {
    const f = fixture(); f.block.timestamp += offset;
    await assert.rejects(readPurchaseState(f.input), { code: "STALE_CHAIN_STATE" });
  }
  const reorg = fixture(); reorg.input.provider.getBlock = async tag => tag === "latest" ? reorg.block : { ...reorg.block, hash: ZeroHash };
  await assert.rejects(readPurchaseState(reorg.input), { code: "CHAIN_STATE_CHANGED" });
  await assert.rejects(readPurchaseState(fixture({ walletDayCount: 4n }).input), { code: "MALFORMED_CHAIN_STATE" });
});
test("UTC midnight never uses the previous day's counters, and the new day reads fresh counters", async () => {
  const f = fixture(); f.input.nowSeconds = 86400 * 20001; f.block.timestamp = f.input.nowSeconds - 1;
  await assert.rejects(readPurchaseState(f.input), { code: "STALE_CHAIN_STATE" });
  f.block.timestamp += 1;
  const state = await readPurchaseState(f.input);
  assert.equal(state.dayIndex, 20001); assert.equal(state.resetAt, 86400 * 20002);
  assert.equal(f.calls.find(c => c.name === "walletDayCount").args[1], 20001);
});
test("invalid round IDs and unavailable RPC never fall back to database quotas", async () => {
  for (const roundId of ["0", "-1", "1.5", "1e3", (2n ** 256n).toString()]) {
    await assert.rejects(readPurchaseState({ ...fixture().input, roundId }), { code: "INVALID_ROUND" });
  }
  await assert.rejects(readPurchaseState({ ...fixture().input, provider: null }), { code: "CHAIN_STATE_UNAVAILABLE" });
});
