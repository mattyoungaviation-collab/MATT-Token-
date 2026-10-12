"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest } = require("../../scripts/dyno/validate-manifest");
const local = require("../../config/project-dyno.local.json");
test("Explicit manual delivery supports the Ethereum NFT and rejects implicit escrow or missing receipt finality", () => {
  const draft = { ...structuredClone(local), environment: "production", mock: false, chainId: 2020, nftChainId: 1, nftFinalityBlocks: 12, multisigThreshold: 2, multisigOwnerCount: 3 };
  assert.deepEqual(validateManifest(draft), []);
  assert.ok(validateManifest({ ...draft, prizeDelivery: "escrow" }).some(error => error.includes("prizeDelivery")));
  assert.ok(validateManifest({ ...draft, nftFinalityBlocks: 0 }).some(error => error.includes("nftFinalityBlocks")));
});
test("Selected multisig threshold mismatch is rejected without affecting local mock configuration", () => {
  assert.deepEqual(validateManifest(local), []);
  const draft = { ...structuredClone(local), environment: "production", mock: false, nftChainId: local.chainId, multisigThreshold: 1, multisigOwnerCount: 3 };
  assert.ok(validateManifest(draft).some(error => error.includes("2-of-3")));
});
