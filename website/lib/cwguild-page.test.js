const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDirectory = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDirectory, "cwguild.html"), "utf8");
const script = fs.readFileSync(path.join(publicDirectory, "cwguild.js"), "utf8");

test("CWGUILD game identifies the verified token and paid-entry trust model", () => {
  assert.match(html, /0x58DB02f56D53De7ee816904aA205D222b242F7b4/);
  assert.match(html, /500,000 CWGUILD per attempt/i);
  assert.match(html, /2,000,000 CWGUILD top cash out/i);
  assert.match(html, /No token approval/i);
  assert.match(html, /CENTRALIZED PAYOUT DISCLOSURE/i);
  assert.match(html, /project-controlled reward wallet/i);
});

test("CWGUILD game uses wallet signatures and never requests an ERC-20 approval", () => {
  assert.match(script, /signMessage\(challenge\.message\)/);
  assert.doesNotMatch(script, /\.approve\s*\(/);
  assert.doesNotMatch(script, /eth_sendTransaction/);
  assert.match(script, /wallet_switchEthereumChain/);
  assert.match(script, /token\.transfer\(state\.config\.operatorAddress/);
  assert.match(script, /transaction\.wait\(2\)/);
  assert.match(script, /\/entry\/verify/);
});

test("CWGUILD game uses a timed post-pattern recall rule and publishes the dynamic payout ceiling", () => {
  assert.match(html, /shrinking timer/i);
  assert.match(html, /PAYOUT CEILING/i);
  assert.match(html, /2,000,000 CWGUILD/i);
  assert.match(html, /payout ceiling is the reward wallet's current CWGUILD balance/i);
  assert.match(script, /\/game\/recall/);
  assert.match(script, /START AT SIGNAL/);
});

test("paid entry requires explicit acknowledgment and discloses that rewards are not guaranteed", () => {
  assert.match(html, /I understand the 500,000 CWGUILD fee is non-refundable/i);
  assert.match(html, /does not guarantee any reward/i);
  assert.match(html, /entry fee is not escrowed and is not returned/i);
  assert.match(html, /id="entry-ack"/);
  assert.match(html, /id="pay-entry"/);
});

test("CWGUILD ladder requires an explicit risk decision and discloses forfeiture", () => {
  assert.match(html, /I ACCEPT THE RISK/i);
  assert.match(html, /provisional and unpaid until Cash Out/i);
  assert.match(html, /loss or timeout forfeits it/i);
  assert.match(html, /5 attempts \/ UTC day/i);
  assert.match(script, /\/game\/next/);
  assert.match(script, /\/game\/cashout/);
  assert.match(script, /state\.game\.sequenceLength/);
});
