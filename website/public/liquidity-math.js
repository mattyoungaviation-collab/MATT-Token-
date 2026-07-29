(function exposeLiquidityMath(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MattLiquidityMath = api;
})(typeof window === "undefined" ? globalThis : window, function createLiquidityMath() {
  "use strict";

  const Q192 = 2n ** 192n;
  const BPS = 10_000n;

  function positiveBigInt(value, name) {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error(`${name} must be positive.`);
    return parsed;
  }

  function divideRoundingUp(numerator, denominator) {
    if (denominator <= 0n) throw new Error("Division denominator must be positive.");
    return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  }

  function quoteMattForWron(amountWron, sqrtPriceX96) {
    const amount = positiveBigInt(amountWron, "WRON amount");
    const sqrtPrice = positiveBigInt(sqrtPriceX96, "Pool price");
    return divideRoundingUp(amount * Q192, sqrtPrice * sqrtPrice);
  }

  function minimumAmount(amount, slippageBps) {
    const parsedAmount = positiveBigInt(amount, "Amount");
    const parsedSlippage = BigInt(slippageBps);
    if (parsedSlippage < 1n || parsedSlippage > 1_000n) {
      throw new Error("Slippage must be between 0.01% and 10%.");
    }
    return parsedAmount * (BPS - parsedSlippage) / BPS;
  }

  function parsePercentToBps(value) {
    const normalized = String(value || "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
      throw new Error("Enter slippage as a percentage, such as 2.");
    }
    const [whole, fraction = ""] = normalized.split(".");
    const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (bps < 1n || bps > 1_000n) {
      throw new Error("Slippage must be between 0.01% and 10%.");
    }
    return bps;
  }

  return {
    BPS,
    Q192,
    divideRoundingUp,
    minimumAmount,
    parsePercentToBps,
    quoteMattForWron
  };
});
