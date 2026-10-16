"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest } = require("../../scripts/dyno/validate-manifest");
const { id } = require("ethers");
const local = require("../../config/project-dyno.local.json");
test("Explicit manual delivery supports the Ethereum NFT and rejects implicit escrow or missing receipt finality", () => {
  const draft = { ...structuredClone(local), environment: "production", mock: false, chainId: 2020, nftChainId: 1, nftFinalityBlocks: 12, multisigThreshold: 2, multisigOwnerCount: 3, indexerFinalityMode: "rpc-finalized", emergencyAdmin: local.nftDepositor, emergencyAdminMode: "full-unilateral-contract-admin", termsHash: id("APPROVED_NO_SALE_TERMS"), vrfCallbackGasLimit: 250000, vrfGasPrice: "22000000000" };
  assert.deepEqual(validateManifest(draft), []);
  assert.ok(validateManifest({ ...draft, prizeDelivery: "escrow" }).some(error => error.includes("prizeDelivery")));
  assert.ok(validateManifest({ ...draft, nftFinalityBlocks: 0 }).some(error => error.includes("nftFinalityBlocks")));
  assert.ok(validateManifest({ ...draft, emergencyAdmin: null }).some(error => error.includes("emergencyAdmin")));
  assert.ok(validateManifest({ ...draft, termsHash: null }).some(error => error.includes("termsHash")));
  assert.ok(validateManifest({ ...draft, paymentModel: "ATOMIC_MATT_SALE" }).some(error => error.includes("payment model")));
});
test("production cannot claim finality from a confirmation-count fallback", () => {
  const draft = { ...structuredClone(local), environment: "production", mock: false, nftFinalityBlocks: 12, multisigThreshold: 2, multisigOwnerCount: 3 };
  assert.ok(validateManifest(draft).some(error => error.includes("indexerFinalityMode")));
  assert.ok(validateManifest({ ...draft, indexerFinalityMode: "confirmations" }).some(error => error.includes("indexerFinalityMode")));
});
test("Selected multisig threshold mismatch is rejected without affecting local mock configuration", () => {
  assert.deepEqual(validateManifest(local), []);
  const draft = { ...structuredClone(local), environment: "production", mock: false, nftChainId: local.chainId, multisigThreshold: 1, multisigOwnerCount: 3 };
  assert.ok(validateManifest(draft).some(error => error.includes("2-of-3")));
});
test("five RON prizes can be revised before opening while draw order, reserve and solvency stay enforced", () => {
  const draft = structuredClone(local);
  draft.round.ronPrizes = [100n, 200n, 300n, 400n, 500n].map(value => String(value * 10n ** 18n));
  assert.deepEqual(validateManifest(draft), []);
  assert.ok(validateManifest({ ...draft, round: { ...draft.round, ronPrizes: [draft.round.ronPrizes[1], ...draft.round.ronPrizes.slice(1)] } }).some(error => error.includes("strictly ascending")));
  assert.ok(validateManifest({ ...draft, round: { ...draft.round, nextDynoReserve: "0" } }).some(error => error.includes("exactly 10,000")));
  assert.ok(validateManifest({ ...draft, round: { ...draft.round, ronPrizes: [10000n, 10001n, 10002n, 10003n, 10004n].map(value => String(value * 10n ** 18n)) } }).some(error => error.includes("exceed direct receipts")));
  assert.ok(validateManifest({ ...draft, round: { ...draft.round, ronPrizes: [100e18, ...draft.round.ronPrizes.slice(1)] } }).some(error => error.includes("exact decimal base-unit strings")));
});
