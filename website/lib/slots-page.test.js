const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "slots.html"), "utf8");
const js = fs.readFileSync(path.join(publicDir, "slots.js"), "utf8");
const gateJs = fs.readFileSync(path.join(publicDir, "slots-gate.js"), "utf8");
const config = fs.readFileSync(path.join(publicDir, "slots-config.js"), "utf8");

test("slots page exposes the agreed 5x3, twenty-line, 1-10 purchase experience", () => {
  assert.match(html, /MATT'S MILLION/);
  assert.match(html, /20 PAYLINES/);
  assert.match(html, /type="range" min="1" max="10"/);
  assert.match(html, /ONE VERIFIED RESULT/);
  assert.match(html, /slots-math-v1\.js/);
});

test("whole-MATT input accepts international thousands separators", () => {
  const start = js.indexOf("function normalizeWholeMattInput(value)");
  const end = js.indexOf("function betValue()", start);
  assert.ok(start >= 0 && end > start, "normalizer source is present");
  const normalize = Function(js.slice(start, end) + " return normalizeWholeMattInput;")();
  assert.equal(normalize("1000"), "1000");
  assert.equal(normalize("1,000"), "1000");
  assert.equal(normalize("1.000"), "1000");
  assert.equal(normalize("1 000"), "1000");
  assert.equal(normalize("1.5"), null);
});
test("live interface consumes one onchain credit per click and never creates a live result locally", () => {
  assert.match(js, /playPaid\(state\.selected\.index/);
  assert.match(js, /playBonus\(state\.selected\.id/);
  assert.match(js, /getSpinGrid\(spinId\)/);
  assert.match(js, /RONIN IS VERIFYING/);
  assert.doesNotMatch(js, /buySpins\([^)]*random/i);
});

test("production config points to the verified paused Ronin deployment", () => {
  assert.match(config, /"slotsAddress": "0x256D9950fC658043813f5a1B811F483269a4b197"/);
  assert.match(config, /"rewardVaultAddress": "0x0c9C78880D48d0ce93E52713DDDB7F25996D234A"/);
  assert.match(config, /"converterAddress": "0xCe4CBBD4d2Ee93a678297E3a27cb14Ece80A04a2"/);
  assert.match(config, /"vrfCoordinatorAddress": "0x572dCE9F1bC8A5E7346dAa1BeaafC56760cA5537"/);
  assert.match(config, /"vrfSponsored": true/);
  assert.match(config, /"practiceEnabled": true/);
});

test("risk and age acknowledgment blocks the game script until accepted", () => {
  assert.match(html, /id="access-gate"/);
  assert.match(html, /I confirm that I am 18 or older/);
  assert.match(html, /You may lose all funds you use/);
  assert.match(html, /slots-gate\.js/);
  assert.doesNotMatch(html, /<script src="\/slots\.js/);
  assert.match(gateJs, /localStorage\.setItem\(ACKNOWLEDGMENT_KEY, "accepted"\)/);
  assert.match(gateJs, /script\.src = "\/slots\.js\?v=7"/);
  assert.match(gateJs, /element\.inert = locked/);
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
