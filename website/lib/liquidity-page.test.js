const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Interface, parseEther } = require("ethers");
const {
  minimumAmount,
  parsePercentToBps,
  quoteMattForWron
} = require("../public/liquidity-math");

const publicDir = path.resolve(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "liquidity.html"), "utf8");
const script = fs.readFileSync(path.join(publicDir, "liquidity.js"), "utf8");
const home = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const hub = fs.readFileSync(path.join(publicDir, "hub.html"), "utf8");

test("quotes the known live MATT/WRON ratio with integer rounding", () => {
  const sqrtPriceX96 = 785548675438972979356627180n;
  const ron = 600n * 10n ** 18n;
  assert.equal(
    quoteMattForWron(ron, sqrtPriceX96),
    6103292957228410307349099n
  );
  assert.equal(parsePercentToBps("2"), 200n);
  assert.equal(
    minimumAmount(6103292957228410307349099n, 200n),
    5981227098083842101202117n
  );
});

test("every liquidity JavaScript ID hook exists in the page", () => {
  const usedIds = [...script.matchAll(/\$\("#([^"]+)"\)/g)].map(match => match[1]);
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const missing = [...new Set(usedIds.filter(id => !htmlIds.has(id)))];
  assert.deepEqual(missing, []);
});

test("locks the workflow to the verified Katana contracts and full-range ticks", () => {
  assert.match(script, /const CHAIN_ID = 2020;/);
  assert.match(script, /0xa517E05e96728E80284F2aE157dDF309449D7cE8/);
  assert.match(script, /0x7cF0fb64d72b733695d77d197c664e90D07cF45A/);
  assert.match(script, /0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c/);
  assert.match(script, /const FEE = 10_000;/);
  assert.match(script, /const TICK_LOWER = -887_200;/);
  assert.match(script, /const TICK_UPPER = 887_200;/);
  assert.match(script, /readManager\.WETH9\(\)/);
});

test("uses wallet-confirmed exact approval and atomic mint with refund", () => {
  assert.match(script, /allowance < quote\.mattDesired/);
  assert.match(script, /approve\(POSITION_MANAGER, quote\.mattDesired/);
  assert.match(script, /encodeFunctionData\("mint"/);
  assert.match(script, /encodeFunctionData\("refundETH"/);
  assert.match(script, /manager\.multicall/);
  assert.doesNotMatch(script, /PRIVATE_KEY|privateKey|secretKey/);
});

test("encodes the verified Katana mint and refund selectors", () => {
  const manager = new Interface([
    "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256,uint128,uint256,uint256)",
    "function multicall(bytes[] data) payable returns(bytes[] results)",
    "function refundETH() payable"
  ]);
  const mint = manager.encodeFunctionData("mint", [{
    token0: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
    token1: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
    fee: 10_000,
    tickLower: -887_200,
    tickUpper: 887_200,
    amount0Desired: parseEther("6103292.957228410307349099"),
    amount1Desired: parseEther("600"),
    amount0Min: parseEther("5981227.098083842101202117"),
    amount1Min: parseEther("588"),
    recipient: "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984",
    deadline: 2_000_000_000
  }]);
  const refund = manager.encodeFunctionData("refundETH");
  const multicall = manager.encodeFunctionData("multicall", [[mint, refund]]);
  assert.equal(mint.slice(0, 10), "0x88316456");
  assert.equal(refund, "0x12210e8a");
  assert.equal(multicall.slice(0, 10), "0xac9650d8");
});

test("loads dependencies in order and links the tool from home and hub", () => {
  const ethersIndex = html.indexOf("/vendor/ethers.umd.min.js");
  const mathIndex = html.indexOf("/liquidity-math.js?v=1");
  const appIndex = html.indexOf("/liquidity.js?v=1");
  assert.ok(ethersIndex >= 0 && mathIndex > ethersIndex && appIndex > mathIndex);
  assert.match(home, /href="\/liquidity"/);
  assert.match(hub, /href="\/liquidity"/);
});
