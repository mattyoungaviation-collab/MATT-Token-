const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "slots.html"), "utf8");
const js = fs.readFileSync(path.join(publicDir, "slots.js"), "utf8");
const config = fs.readFileSync(path.join(publicDir, "slots-config.js"), "utf8");

test("slots page exposes the agreed 5x3, twenty-line, 1-25 purchase experience", () => {
  assert.match(html, /MATT'S MILLION/);
  assert.match(html, /20 PAYLINES/);
  assert.match(html, /type="range" min="1" max="25"/);
  assert.match(html, /ONE VERIFIED RESULT/);
  assert.match(html, /slots-math-v1\.js/);
});

test("live interface consumes one onchain credit per click and never creates a live result locally", () => {
  assert.match(js, /playPaid\(state\.selected\.index/);
  assert.match(js, /playBonus\(state\.selected\.id/);
  assert.match(js, /getSpinGrid\(spinId\)/);
  assert.match(js, /RONIN IS VERIFYING/);
  assert.doesNotMatch(js, /buySpins\([^)]*random/i);
});

test("undeployed addresses keep live MATT locked while preserving explicit practice mode", () => {
  assert.match(config, /slotsAddress: null/);
  assert.match(config, /rewardVaultAddress: null/);
  assert.match(config, /converterAddress: null/);
  assert.match(config, /vrfCoordinatorAddress: "0x16a62a921e7fec5bf867ff5c805b662db757b778"/);
  assert.match(config, /practiceEnabled: true/);
});

test("players can restore stale VRF spins and claim or refund while game play is paused", () => {
  assert.match(html, /id="stale-refund-button"/);
  assert.match(js, /refundStaleSpin\(spinId\)/);
  assert.match(js, /const walletReady = state\.live && state\.account && !state\.busy/);
  assert.match(js, /claim-button"\)\.disabled = !walletReady/);
  assert.match(js, /refund-button"\)\.disabled = !walletReady/);
});

test("live mode verifies the linked token vault converter and treasury identities", () => {
  assert.match(js, /configured Slots contracts are not linked to the official MATT deployment/);
  assert.match(js, /state\.readSlots\.rewardVault\(\)/);
  assert.match(js, /state\.readSlots\.vrfCoordinator\(\)/);
  assert.match(js, /getMathConfiguration\(activeMathVersion\)/);
  assert.match(js, /state\.readConverter\.treasury\(\)/);
});
