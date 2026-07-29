const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const {
  MATT,
  POOL,
  WRON,
  createLiquidityMarketRouter
} = require("../liquidity-market-routes");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

function poolPayload(overrides = {}) {
  return {
    data: {
      id: `ronin_${POOL}`,
      attributes: {
        quote_token_price_base_token: "10000",
        reserve_in_usd: "1000000",
        volume_usd: { h24: "100000" },
        transactions: { h24: { buys: 12, sells: 8 } },
        ...overrides
      },
      relationships: {
        base_token: { data: { id: `ronin_${MATT}` } },
        quote_token: { data: { id: `ronin_${WRON}` } },
        dex: { data: { id: "katana-v3" } }
      }
    }
  };
}

function ohlcvPayload(volumes = [70_000, 80_000, 90_000, 100_000, 110_000, 120_000, 130_000]) {
  return {
    data: {
      attributes: {
        ohlcv_list: volumes.map((volume, index) => [1_700_000_000 - index * 86_400, 1, 1, 1, 1, volume])
      }
    }
  };
}

async function withServer(router, callback) {
  const app = express();
  app.use("/api/liquidity/market", router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("returns verified Katana pool analytics and volume-based APR estimates", async () => {
  const fetchImpl = async url => String(url).includes("/ohlcv/")
    ? response(ohlcvPayload())
    : response(poolPayload());
  await withServer(createLiquidityMarketRouter({ fetchImpl, cacheMs: 1_000 }), async baseUrl => {
    const result = await fetch(`${baseUrl}/api/liquidity/market`);
    assert.equal(result.status, 200);
    const payload = await result.json();
    assert.equal(payload.pool, POOL);
    assert.equal(payload.mattPerRon, 10_000);
    assert.equal(payload.tvlUsd, 1_000_000);
    assert.equal(payload.volume24hUsd, 100_000);
    assert.equal(payload.fees24hUsd, 1_000);
    assert.equal(payload.apr24h, 36.5);
    assert.equal(payload.apr7d, 36.5);
    assert.deepEqual(payload.transactions24h, { buys: 12, sells: 8 });
  });
});

test("rejects analytics returned for a different pool", async () => {
  const wrong = poolPayload();
  wrong.data.id = "ronin_0x0000000000000000000000000000000000000001";
  const fetchImpl = async url => String(url).includes("/ohlcv/")
    ? response(ohlcvPayload())
    : response(wrong);
  await withServer(createLiquidityMarketRouter({ fetchImpl }), async baseUrl => {
    const result = await fetch(`${baseUrl}/api/liquidity/market`);
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error, "MARKET_DATA_UNAVAILABLE");
  });
});

test("caches market responses to protect the public feed", async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    return String(url).includes("/ohlcv/") ? response(ohlcvPayload()) : response(poolPayload());
  };
  await withServer(createLiquidityMarketRouter({ fetchImpl, cacheMs: 60_000 }), async baseUrl => {
    await fetch(`${baseUrl}/api/liquidity/market`);
    await fetch(`${baseUrl}/api/liquidity/market`);
    assert.equal(calls, 2);
  });
});
