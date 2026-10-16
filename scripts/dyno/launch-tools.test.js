"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface, id } = require("ethers");
const { preflightNetwork, rpcErrorCode } = require("./preflight-network");
const { buildPlan } = require("./prepare-deployment");
const { APPROVED_TERMS_HASH, currentTermsHash, validateApprovedTerms } = require("./terms-approval");
const local = require("../../config/project-dyno.local.json");
const pending = require("../../config/project-dyno.ronin.example.json");
const vrf = new Interface(["function estimateRequestRandomFee(uint256,uint256) view returns(uint256)"]);
test("approved participant text and manifest hash stay bound to the no-sale terms", () => {
  assert.equal(currentTermsHash(), APPROVED_TERMS_HASH);
  assert.deepEqual(validateApprovedTerms(APPROVED_TERMS_HASH), []);
  assert.ok(validateApprovedTerms(id("different terms")).some(error => error.includes("manifest termsHash")));
});
function rpcFixture({ chain = "0x31769", finality = true, reorg = false, feeFailure = false, feeStale = false } = {}) {
  let currentReads = 0;
  return async (method, params) => {
    if (method === "eth_chainId") return chain;
    if (method === "eth_blockNumber") return "0x100";
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_call") {
      assert.equal(params[1], "0x100");
      const args = vrf.decodeFunctionData("estimateRequestRandomFee", params[0].data);
      assert.equal(args[0], 250000n); assert.equal(args[1], 22000000000n);
      if (feeStale) throw new Error("VRF_PRICE_FEED_STALE");
      if (feeFailure) throw new Error("PRIVATE_PROVIDER_SECRET_MUST_NOT_ESCAPE");
      return vrf.encodeFunctionResult("estimateRequestRandomFee", [123456789012345678n]);
    }
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized" && !finality) throw new Error("unsupported");
      const finalized = params[0] !== "0x100";
      if (!finalized) currentReads++;
      return { number: finalized ? "0xf0" : "0x100", hash: reorg && currentReads > 1 ? id("changed") : id(finalized ? "finalized" : "block"), timestamp: "0x1000", baseFeePerGas: "0x3b9aca00" };
    }
    throw new Error("UNEXPECTED_RPC");
  };
}
test("VRF evidence uses exact fees, pinned reads and never equates a quote with live integration", async () => {
  const result = await preflightNetwork({ rpc: rpcFixture() });
  assert.equal(result.vrf.fee, "123456789012345678");
  assert.equal(result.vrf.budgetCoversOneQuotedRequest, true);
  assert.equal(result.productionReady, false);
  assert.ok(result.blockers.includes("REAL_TESTNET_REQUEST_AND_CALLBACK_PENDING"));
  assert.equal(result.finalized.number, "240");
});
test("network preflight fails closed for wrong chain/reorg/VRF and reports missing finality without latest substitution", async () => {
  assert.equal(rpcErrorCode({ data: "0xff68e149" + "00".repeat(128) }), "VRF_PRICE_FEED_STALE");
  await assert.rejects(preflightNetwork({ rpc: rpcFixture({ chain: "0x1" }) }), /CHAIN_MISMATCH/);
  await assert.rejects(preflightNetwork({ rpc: rpcFixture({ reorg: true }) }), /PREFLIGHT_BLOCK_REORGED/);
  await assert.rejects(preflightNetwork({ rpc: rpcFixture({ feeFailure: true }) }), /^Error: VRF_FEE_READ_UNAVAILABLE$/);
  await assert.rejects(preflightNetwork({ rpc: rpcFixture({ feeStale: true }) }), /^Error: VRF_PRICE_FEED_STALE$/);
  const result = await preflightNetwork({ rpc: rpcFixture({ finality: false }) });
  assert.equal(result.finalized, null); assert.ok(result.blockers.includes("FINALIZED_TAG_NOT_VERIFIED"));
});
test("deployment planner refuses pending production inputs without emitting executable transactions", () => {
  const result = buildPlan(pending, local.nftDepositor, 0);
  assert.equal(result.broadcast, false); assert.equal(result.targetChainId, 2020);
  assert.equal(result.readyForReview, false); assert.equal(result.transactions.length, 0);
  assert.ok(result.blockers.some(x => x.includes("required") || x.includes("nonzero")));
  assert.throws(() => buildPlan(pending, local.nftDepositor, -1));
});
test("complete synthetic no-sale plan binds proxy initialization, nonce order and treasury without network writes", () => {
  const synthetic = { ...local, emergencyAdmin: local.nftDepositor, factory: local.pool, poolFee: 10000, routerIntegration: "katana-aggregate-v3-exact-input", reviewer: local.keeper, backupKeeper: local.identitySigner, operatorApprovalStatus: "approved", marketVerificationStatus: "fork-verified-and-reviewed", vrfCallbackGasLimit: 250000, vrfGasPrice: "22000000000", termsHash: id("LOCAL_TEST_TERMS") };
  const result = buildPlan(synthetic, local.nftDepositor, 42);
  assert.deepEqual(result.blockers, []); assert.equal(result.transactions.length, 5);
  assert.deepEqual(result.transactions.map(t => t.nonce), [42, 43, 44, 45, 46]);
  assert.ok(result.transactions.every(t => t.to === null && t.value === "0"));
  const manager = new Interface(require("../../artifacts/contracts/dyno/ProjectDynoRaffleManager.sol/ProjectDynoRaffleManager.json").abi);
  const decoded = manager.decodeFunctionData("createRound", result.safeActions.at(-1).data);
  assert.equal(manager.decodeFunctionData("setEmergencyAdmin", result.safeActions[1].data)[0].toLowerCase(), local.nftDepositor.toLowerCase());
  assert.equal(manager.decodeFunctionData("setVrfRefundReceiver", result.safeActions[0].data)[0].toLowerCase(), result.transactions[4].predictedAddress.toLowerCase());
  assert.equal(decoded[0].swapAdapter, "0x0000000000000000000000000000000000000000");
  assert.equal(decoded[0].priceGuard, "0x0000000000000000000000000000000000000000");
  assert.equal(decoded[0].treasury.toLowerCase(), local.multisig.toLowerCase());
  assert.equal(decoded[0].ronPrizes.reduce((a,b) => a+b, 0n), 12148876400000000000000n);
  assert.ok(!result.safeActions.some(t => t.data.startsWith(manager.getFunction("openRound").selector)));
  const proxy = new Interface(require("../../artifacts/contracts/dyno/ProjectDynoProxy.sol/ProjectDynoProxy.json").abi);
  assert.equal(proxy.deploy.inputs.length, 2);
  assert.equal(result.proposedManifest.raffleProxy, result.transactions[3].predictedAddress);
});
