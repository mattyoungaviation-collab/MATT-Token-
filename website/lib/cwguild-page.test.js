const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDirectory = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDirectory, "cwguild.html"), "utf8");
const script = fs.readFileSync(path.join(publicDirectory, "cwguild.js"), "utf8");

test("CWGUILD game identifies the verified token and contractless trust model", () => {
  assert.match(html, /0x58DB02f56D53De7ee816904aA205D222b242F7b4/);
  assert.match(html, /0 CWGUILD wager/i);
  assert.match(html, /No token approval/i);
  assert.match(html, /CENTRALIZED PAYOUT DISCLOSURE/i);
  assert.match(html, /project-controlled operator wallet/i);
});

test("CWGUILD game uses wallet signatures and never requests an ERC-20 approval", () => {
  assert.match(script, /signMessage\(challenge\.message\)/);
  assert.doesNotMatch(script, /\.approve\s*\(/);
  assert.doesNotMatch(script, /eth_sendTransaction/);
  assert.match(script, /wallet_switchEthereumChain/);
});
