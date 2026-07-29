(function exposeLiquidityMath(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MattLiquidityMath = api;
})(typeof window === "undefined" ? globalThis : window, function createLiquidityMath() {
  "use strict";

  const Q96 = 2n ** 96n;
  const Q192 = 2n ** 192n;
  const BPS = 10_000n;
  const MIN_TICK = -887_272;
  const MAX_TICK = 887_272;
  const MAX_UINT256 = (2n ** 256n) - 1n;

  const TICK_MULTIPLIERS = [
    0xfffcb933bd6fad37aa2d162d1a594001n,
    0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n,
    0xff973b41fa98c081472e6896dfb254c0n,
    0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n,
    0xfcbe86c7900a88aedcffc83b479aa3a4n,
    0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n,
    0xe7159475a2c29b7443b29c7fa6e889d9n,
    0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n,
    0x70d869a156d2a1b890bb3df62baf32f7n,
    0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n,
    0x5d6af8dedb81196699c329225ee604n,
    0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n
  ];

  function toBigInt(value, name, allowZero = false) {
    const parsed = BigInt(value);
    if (allowZero ? parsed < 0n : parsed <= 0n) {
      throw new Error(`${name} must be ${allowZero ? "zero or positive" : "positive"}.`);
    }
    return parsed;
  }

  function divideRoundingUp(numerator, denominator) {
    if (denominator <= 0n) throw new Error("Division denominator must be positive.");
    return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  }

  function tickToSqrtPriceX96(tick) {
    const parsedTick = Number(tick);
    if (!Number.isInteger(parsedTick) || parsedTick < MIN_TICK || parsedTick > MAX_TICK) {
      throw new Error("Tick is outside the supported V3 range.");
    }
    const absoluteTick = Math.abs(parsedTick);
    let ratio = absoluteTick & 1 ? TICK_MULTIPLIERS[0] : 1n << 128n;
    for (let bit = 1; bit < TICK_MULTIPLIERS.length; bit += 1) {
      if (absoluteTick & (1 << bit)) ratio = (ratio * TICK_MULTIPLIERS[bit]) >> 128n;
    }
    if (parsedTick > 0) ratio = MAX_UINT256 / ratio;
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
  }

  function tickToMattPerRon(tick) {
    const result = Math.pow(1.0001, -Number(tick));
    if (!Number.isFinite(result) || result <= 0) throw new Error("Tick price is unavailable.");
    return result;
  }

  function usableTickFloor(tick, spacing) {
    const parsedSpacing = Number(spacing);
    if (!Number.isInteger(parsedSpacing) || parsedSpacing <= 0) throw new Error("Tick spacing is invalid.");
    return Math.floor(Number(tick) / parsedSpacing) * parsedSpacing;
  }

  function usableTickCeil(tick, spacing) {
    const parsedSpacing = Number(spacing);
    if (!Number.isInteger(parsedSpacing) || parsedSpacing <= 0) throw new Error("Tick spacing is invalid.");
    return Math.ceil(Number(tick) / parsedSpacing) * parsedSpacing;
  }

  function fullRangeTicks(spacing) {
    return {
      tickLower: usableTickCeil(MIN_TICK, spacing),
      tickUpper: usableTickFloor(MAX_TICK, spacing)
    };
  }

  function priceToRawTick(mattPerRon) {
    const price = Number(mattPerRon);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Range prices must be positive.");
    return Math.log(1 / price) / Math.log(1.0001);
  }

  function rangeFromPrices(minMattPerRon, maxMattPerRon, spacing) {
    const minimum = Number(minMattPerRon);
    const maximum = Number(maxMattPerRon);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum <= minimum) {
      throw new Error("The maximum price must be greater than the minimum price.");
    }
    const full = fullRangeTicks(spacing);
    const tickLower = Math.max(full.tickLower, usableTickFloor(priceToRawTick(maximum), spacing));
    const tickUpper = Math.min(full.tickUpper, usableTickCeil(priceToRawTick(minimum), spacing));
    if (tickLower >= tickUpper) throw new Error("The selected price range is too narrow for this pool.");
    return { tickLower, tickUpper };
  }

  function pricesFromRange(tickLower, tickUpper) {
    return {
      minMattPerRon: tickToMattPerRon(tickUpper),
      maxMattPerRon: tickToMattPerRon(tickLower)
    };
  }

  function amount0ForLiquidity(sqrtA, sqrtB, liquidity) {
    const a = toBigInt(sqrtA, "Lower price");
    const b = toBigInt(sqrtB, "Upper price");
    const value = toBigInt(liquidity, "Liquidity", true);
    if (a >= b) throw new Error("Lower price must be below upper price.");
    return ((value << 96n) * (b - a) / b) / a;
  }

  function amount1ForLiquidity(sqrtA, sqrtB, liquidity) {
    const a = toBigInt(sqrtA, "Lower price");
    const b = toBigInt(sqrtB, "Upper price");
    const value = toBigInt(liquidity, "Liquidity", true);
    if (a >= b) throw new Error("Lower price must be below upper price.");
    return value * (b - a) / Q96;
  }

  function liquidityForAmount0(sqrtA, sqrtB, amount0) {
    const a = toBigInt(sqrtA, "Lower price");
    const b = toBigInt(sqrtB, "Upper price");
    const amount = toBigInt(amount0, "MATT amount");
    if (a >= b) throw new Error("Lower price must be below upper price.");
    return (amount * a * b / Q96) / (b - a);
  }

  function liquidityForAmount1(sqrtA, sqrtB, amount1) {
    const a = toBigInt(sqrtA, "Lower price");
    const b = toBigInt(sqrtB, "Upper price");
    const amount = toBigInt(amount1, "RON amount");
    if (a >= b) throw new Error("Lower price must be below upper price.");
    return amount * Q96 / (b - a);
  }

  function amountsForLiquidity(liquidity, sqrtPriceX96, tickLower, tickUpper) {
    const current = toBigInt(sqrtPriceX96, "Current pool price");
    const sqrtA = tickToSqrtPriceX96(tickLower);
    const sqrtB = tickToSqrtPriceX96(tickUpper);
    const value = toBigInt(liquidity, "Liquidity", true);
    if (current <= sqrtA) {
      return { amount0: amount0ForLiquidity(sqrtA, sqrtB, value), amount1: 0n };
    }
    if (current < sqrtB) {
      return {
        amount0: amount0ForLiquidity(current, sqrtB, value),
        amount1: amount1ForLiquidity(sqrtA, current, value)
      };
    }
    return { amount0: 0n, amount1: amount1ForLiquidity(sqrtA, sqrtB, value) };
  }

  function quotePairFromPrimary(primary, amount, sqrtPriceX96, tickLower, tickUpper) {
    const token = String(primary || "").toUpperCase();
    const desired = toBigInt(amount, `${token} amount`);
    const current = toBigInt(sqrtPriceX96, "Current pool price");
    const sqrtA = tickToSqrtPriceX96(tickLower);
    const sqrtB = tickToSqrtPriceX96(tickUpper);
    let liquidity;
    let amount0;
    let amount1;

    if (token === "MATT") {
      if (current >= sqrtB) throw new Error("This range is RON-only at the current price. Choose RON.");
      liquidity = liquidityForAmount0(current <= sqrtA ? sqrtA : current, sqrtB, desired);
      ({ amount0, amount1 } = amountsForLiquidity(liquidity, current, tickLower, tickUpper));
      amount0 = desired;
    } else if (token === "RON") {
      if (current <= sqrtA) throw new Error("This range is MATT-only at the current price. Choose MATT.");
      liquidity = liquidityForAmount1(sqrtA, current >= sqrtB ? sqrtB : current, desired);
      ({ amount0, amount1 } = amountsForLiquidity(liquidity, current, tickLower, tickUpper));
      amount1 = desired;
    } else {
      throw new Error("Choose MATT or RON as the starting token.");
    }

    if (liquidity <= 0n) throw new Error("The amount is too small for this range.");
    return { amount0Desired: amount0, amount1Desired: amount1, liquidity };
  }

  function minimumAmount(amount, slippageBps) {
    const parsedAmount = toBigInt(amount, "Amount", true);
    const parsedSlippage = BigInt(slippageBps);
    if (parsedSlippage < 1n || parsedSlippage > 1_000n) {
      throw new Error("Slippage must be between 0.01% and 10%.");
    }
    return parsedAmount * (BPS - parsedSlippage) / BPS;
  }

  function parsePercentToBps(value) {
    const normalized = String(value || "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
      throw new Error("Enter slippage as a percentage, such as 1.");
    }
    const [whole, fraction = ""] = normalized.split(".");
    const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (bps < 1n || bps > 1_000n) {
      throw new Error("Slippage must be between 0.01% and 10%.");
    }
    return bps;
  }

  function liquidityShare(liquidity, percentBps) {
    const value = toBigInt(liquidity, "Liquidity");
    const share = BigInt(percentBps);
    if (share <= 0n || share > BPS) throw new Error("Removal must be between 0.01% and 100%.");
    return share === BPS ? value : value * share / BPS;
  }

  function mattToRon(amountMatt, sqrtPriceX96) {
    const amount = toBigInt(amountMatt, "MATT amount", true);
    const sqrtPrice = toBigInt(sqrtPriceX96, "Pool price");
    return amount * sqrtPrice * sqrtPrice / Q192;
  }

  function positionValueInRon(amountMatt, amountWron, sqrtPriceX96) {
    return mattToRon(amountMatt, sqrtPriceX96) + toBigInt(amountWron, "RON amount", true);
  }

  return {
    BPS,
    MAX_TICK,
    MIN_TICK,
    Q96,
    Q192,
    amount0ForLiquidity,
    amount1ForLiquidity,
    amountsForLiquidity,
    divideRoundingUp,
    fullRangeTicks,
    liquidityForAmount0,
    liquidityForAmount1,
    liquidityShare,
    mattToRon,
    minimumAmount,
    parsePercentToBps,
    positionValueInRon,
    pricesFromRange,
    quotePairFromPrimary,
    rangeFromPrices,
    tickToMattPerRon,
    tickToSqrtPriceX96,
    usableTickCeil,
    usableTickFloor
  };
});
