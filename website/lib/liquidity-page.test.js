const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Interface, parseEther } = require("ethers");
const math = require("../public/liquidity-math");

const publicDir = path.resolve(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "liquidity.html"), "utf8");
const script = fs.readFileSync(path.join(publicDir, "liquidity.js"), "utf8");
const home = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const hub = fs.readFileSync(path.join(publicDir, "hub.html"), "utf8");

test("implements exact V3 tick math and valid full-range ticks", () => {
  assert.equal(math.tickToSqrtPriceX96(0), 2n ** 96n);
  assert.deepEqual(math.fullRangeTicks(200), { tickLower: -887_200, tickUpper: 887_200 });
  assert.ok(math.tickToSqrtPriceX96(-887_200) < math.tickToSqrtPriceX96(0));
  assert.ok(math.tickToSqrtPriceX96(887_200) > math.tickToSqrtPriceX96(0));
  assert.equal(math.parsePercentToBps("1.25"), 125n);
  assert.equal(math.minimumAmount(0n, 100n), 0n);
  assert.equal(math.minimumAmount(10_000n, 100n), 9_900n);
});

test("converts human price ranges to outward-rounded Katana ticks", () => {
  const range = math.rangeFromPrices(8_000, 12_000, 200);
  const prices = math.pricesFromRange(range.tickLower, range.tickUpper);
  assert.equal(Math.abs(range.tickLower % 200), 0);
  assert.equal(Math.abs(range.tickUpper % 200), 0);
  assert.ok(prices.minMattPerRon <= 8_000);
  assert.ok(prices.maxMattPerRon >= 12_000);
  assert.throws(() => math.rangeFromPrices(12_000, 8_000, 200), /maximum price/i);
});

test("quotes balanced and one-sided concentrated-liquidity positions", () => {
  const current = math.tickToSqrtPriceX96(0);
  const ron = parseEther("10");
  const balanced = math.quotePairFromPrimary("RON", ron, current, -200, 200);
  assert.equal(balanced.amount1Desired, ron);
  assert.ok(balanced.amount0Desired > 0n);
  assert.ok(balanced.liquidity > 0n);

  const principal = math.amountsForLiquidity(balanced.liquidity, current, -200, 200);
  assert.equal(principal.amount0, balanced.amount0Desired);
  assert.ok(principal.amount1 <= balanced.amount1Desired);
  assert.ok(balanced.amount1Desired - principal.amount1 <= 1n);

  const mattOnly = math.quotePairFromPrimary("MATT", parseEther("100"), current, 200, 400);
  assert.equal(mattOnly.amount0Desired, parseEther("100"));
  assert.equal(mattOnly.amount1Desired, 0n);
  assert.throws(
    () => math.quotePairFromPrimary("RON", ron, current, 200, 400),
    /MATT-only/
  );
});

test("calculates removal shares and position value in RON", () => {
  assert.equal(math.liquidityShare(1_000n, 2_500n), 250n);
  assert.equal(math.liquidityShare(999n, 10_000n), 999n);
  const current = math.tickToSqrtPriceX96(0);
  assert.equal(math.mattToRon(parseEther("5"), current), parseEther("5"));
  assert.equal(
    math.positionValueInRon(parseEther("5"), parseEther("2"), current),
    parseEther("7")
  );
});

test("every JavaScript ID hook exists in the pool-manager page", () => {
  const usedIds = [...script.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map(match => match[1]);
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const generatedIds = new Set([...script.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const missing = [...new Set(usedIds.filter(id => !htmlIds.has(id) && !generatedIds.has(id)))];
  assert.deepEqual(missing, []);
});

test("locks every action to the verified MATT Katana deployment", () => {
  assert.match(script, /const CHAIN_ID = 2020;/);
  assert.match(script, /0xa5450417BDCa0BDfB058ffE41205400FfDA1174d/);
  assert.match(script, /0xa517E05e96728E80284F2aE157dDF309449D7cE8/);
  assert.match(script, /0x7cF0fb64d72b733695d77d197c664e90D07cF45A/);
  assert.match(script, /0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c/);
  assert.match(script, /const FEE = 10_000;/);
  assert.match(script, /const TICK_SPACING = 200;/);
  assert.match(script, /readManager\.WETH9\(\)/);
  assert.match(script, /official MATT\/WRON pool/);
});

test("supports mint, add, remove, exact fees, collection, and native RON payout", () => {
  assert.match(script, /encodeFunctionData\("mint"/);
  assert.match(script, /encodeFunctionData\("increaseLiquidity"/);
  assert.match(script, /encodeFunctionData\("decreaseLiquidity"/);
  assert.match(script, /collectedFees\(tokenId\)/);
  assert.match(script, /collect\.staticCall/);
  assert.match(script, /encodeFunctionData\("collect"/);
  assert.match(script, /encodeFunctionData\("sweepToken"/);
  assert.match(script, /encodeFunctionData\("unwrapWETH9"/);
  assert.match(script, /encodeFunctionData\("refundETH"/);
  assert.match(script, /allowance >= amount/);
  assert.match(script, /approve\(POSITION_MANAGER, amount/);
  assert.doesNotMatch(script, /PRIVATE_KEY|privateKey|secretKey/);
});

test("uses the verified Katana position-manager selectors", () => {
  const manager = new Interface([
    "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable",
    "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable",
    "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable",
    "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable",
    "function multicall(bytes[] data) payable",
    "function refundETH() payable",
    "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
    "function sweepToken(address token,uint256 amountMinimum,address recipient) payable"
  ]);
  assert.equal(manager.getFunction("mint").selector, "0x88316456");
  assert.equal(manager.getFunction("increaseLiquidity").selector, "0x219f5d17");
  assert.equal(manager.getFunction("decreaseLiquidity").selector, "0x0c49ccbe");
  assert.equal(manager.getFunction("collect").selector, "0xfc6f7865");
  assert.equal(manager.getFunction("multicall").selector, "0xac9650d8");
  assert.equal(manager.getFunction("refundETH").selector, "0x12210e8a");
  assert.equal(manager.getFunction("unwrapWETH9").selector, "0x49404b7c");
  assert.equal(manager.getFunction("sweepToken").selector, "0xdf2ab5bb");
});

test("loads dependencies in order and links the full manager from home and hub", () => {
  const ethersIndex = html.indexOf("/vendor/ethers.umd.min.js");
  const mathIndex = html.indexOf("/liquidity-math.js?v=2");
  const appIndex = html.indexOf("/liquidity.js?v=2");
  assert.ok(ethersIndex >= 0 && mathIndex > ethersIndex && appIndex > mathIndex);
  assert.match(home, /<h3>POOL MANAGER<\/h3>/);
  assert.match(hub, /<span>Pool Manager<\/span>/);
  assert.match(html, /24H FEE APR/);
  assert.match(html, /LIFETIME FEES/);
});
