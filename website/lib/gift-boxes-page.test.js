const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.resolve(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "gift-boxes.html"), "utf8");
const script = fs.readFileSync(path.join(publicDir, "gift-boxes.js"), "utf8");
const home = [
  "index.html",
  "home.js",
  "home.css"
].map(file => fs.readFileSync(path.join(publicDir, file), "utf8")).join("\n");

test("every gift-box JavaScript ID hook exists in the page", () => {
  const usedIds = [...script.matchAll(/\$\("#([^"]+)"\)/g)].map(match => match[1]);
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const missing = [...new Set(usedIds.filter(id => !htmlIds.has(id)))];
  assert.deepEqual(missing, []);
});

test("uses the verified Ronin mainnet contracts and owner", () => {
  assert.match(script, /const CHAIN_ID = 2020;/);
  assert.match(script, /0xF79913cB83Cc9CABD95D0ba9250103fbb939f984/);
  assert.match(script, /0x896862e8D9c8576fcb4418ba21b4F9033E7785f4/);
  assert.match(script, /0x0F4b0637D60Af8e3dfE8aF8d7C9448d34a969EcE/);
  assert.match(script, /0xa5450417BDCa0BDfB058ffE41205400FfDA1174d/);
});

test("keeps owner actions wallet-confirmed and safety gated", () => {
  assert.match(script, /signer\.signTypedData/);
  assert.match(script, /JsonRpcProvider\(RPC_URL, CHAIN_ID, \{\s*staticNetwork: true/);
  assert.match(script, /randomnessReserve >= state\.randomFee \* 3n/);
  assert.match(script, /selectedMaximumPayout/);
  assert.match(script, /value\.trim\(\)\.toUpperCase\(\) !== "UNPAUSE"/);
  assert.doesNotMatch(script, /PRIVATE_KEY|privateKey|secretKey/);
});

test("loads ethers before the integration and remains unlinked from home", () => {
  const ethersIndex = html.indexOf("/vendor/ethers.umd.min.js");
  const integrationIndex = html.indexOf("/gift-boxes.js?v=3");
  assert.ok(ethersIndex >= 0 && integrationIndex > ethersIndex);
  assert.match(html, /noindex,nofollow/);
  assert.doesNotMatch(home, /gift-box/i);
});
