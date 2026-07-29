const express = require("express");

const POOL = "0xa517e05e96728e80284f2ae157ddf309449d7ce8";
const MATT = "0xa5450417bdca0bdfb058ffe41205400ffda1174d";
const WRON = "0xe514d9deb7966c8be0ca922de8a064264ea6bcd4";
const POOL_URL = `https://api.geckoterminal.com/api/v2/networks/ronin/pools/${POOL}`;
const OHLCV_URL = `${POOL_URL}/ohlcv/day?aggregate=1&limit=8&currency=usd&token=base`;
const FEE_RATE = 0.01;

function createLiquidityMarketRouter(options = {}) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl || global.fetch;
  const cacheMs = Number(options.cacheMs ?? 60_000);
  let cached = null;
  let pending = null;

  async function load() {
    if (typeof fetchImpl !== "function") throw new Error("Market data is unavailable.");
    const [poolResponse, ohlcvResponse] = await Promise.all([
      fetchImpl(POOL_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) }),
      fetchImpl(OHLCV_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) })
    ]);
    if (!poolResponse.ok || !ohlcvResponse.ok) {
      throw new Error(`Market feed returned HTTP ${poolResponse.ok ? ohlcvResponse.status : poolResponse.status}.`);
    }
    const [poolPayload, ohlcvPayload] = await Promise.all([poolResponse.json(), ohlcvResponse.json()]);
    const data = poolPayload?.data;
    const attributes = data?.attributes;
    const relationships = data?.relationships;
    if (
      String(data?.id || "").toLowerCase() !== `ronin_${POOL}`
      || relationAddress(relationships?.base_token?.data?.id) !== MATT
      || relationAddress(relationships?.quote_token?.data?.id) !== WRON
      || String(relationships?.dex?.data?.id || "") !== "katana-v3"
    ) {
      throw new Error("Market feed returned the wrong pool.");
    }

    const tvlUsd = positiveNumber(attributes?.reserve_in_usd);
    const volume24hUsd = positiveNumber(attributes?.volume_usd?.h24, true);
    const rows = Array.isArray(ohlcvPayload?.data?.attributes?.ohlcv_list)
      ? ohlcvPayload.data.attributes.ohlcv_list
      : [];
    const dailyVolumes = rows
      .map(row => Number(row?.[5]))
      .filter(value => Number.isFinite(value) && value >= 0)
      .slice(0, 7);
    const sevenDayVolumeUsd = dailyVolumes.reduce((sum, value) => sum + value, 0);
    const averageDailyVolumeUsd = dailyVolumes.length ? sevenDayVolumeUsd / dailyVolumes.length : volume24hUsd;
    const fees24hUsd = volume24hUsd * FEE_RATE;
    const averageDailyFees7dUsd = averageDailyVolumeUsd * FEE_RATE;

    return {
      pool: POOL,
      source: "GeckoTerminal / Katana V3",
      mattPerRon: positiveNumber(attributes?.quote_token_price_base_token),
      tvlUsd,
      volume24hUsd,
      fees24hUsd,
      apr24h: tvlUsd ? fees24hUsd * 365 / tvlUsd * 100 : 0,
      apr7d: tvlUsd ? averageDailyFees7dUsd * 365 / tvlUsd * 100 : 0,
      dailySamples: dailyVolumes.length,
      transactions24h: {
        buys: nonNegativeInteger(attributes?.transactions?.h24?.buys),
        sells: nonNegativeInteger(attributes?.transactions?.h24?.sells)
      },
      checkedAt: new Date().toISOString()
    };
  }

  router.get("/", async (_req, res) => {
    try {
      if (!cached || Date.now() - cached.loadedAt >= cacheMs) {
        if (!pending) {
          pending = load()
            .then(data => {
              cached = { loadedAt: Date.now(), data };
              return data;
            })
            .finally(() => { pending = null; });
        }
        await pending;
      }
      res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
      return res.json(cached.data);
    } catch (error) {
      console.error("Liquidity market feed failed:", String(error?.message || error).slice(0, 220));
      if (cached) return res.json({ ...cached.data, stale: true });
      return res.status(502).json({
        error: "MARKET_DATA_UNAVAILABLE",
        message: "Live pool analytics are temporarily unavailable."
      });
    }
  });

  return router;
}

function relationAddress(value) {
  const address = String(value || "").replace(/^ronin_/i, "").toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : "";
}

function positiveNumber(value, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error("Market feed returned an invalid number.");
  }
  return parsed;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

module.exports = {
  FEE_RATE,
  MATT,
  OHLCV_URL,
  POOL,
  POOL_URL,
  WRON,
  createLiquidityMarketRouter
};
