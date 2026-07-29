const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { Wallet, parseEther, parseUnits, verifyTypedData } = require("ethers");
const {
  CHAIN_ID,
  GIFT_BOXES,
  KATANA_POOL,
  MATT,
  PRICE_QUOTE_TYPES,
  WRON,
  createGiftBoxQuoteRouter,
  createMarketPriceReader
} = require("../gift-box-quote-routes");

const signer = new Wallet(`0x${"31".repeat(32)}`);
const buyer = new Wallet(`0x${"41".repeat(32)}`).address;
const recipient = new Wallet(`0x${"51".repeat(32)}`).address;
const liveRate = "11128.1";

function contractRead({ paused = false } = {}) {
  return {
    async paused() { return paused; },
    async activeConfigVersion() { return 7n; },
    async getConfiguration() {
      return {
        prices: [parseEther("100"), parseEther("250"), parseEther("500")],
        exists: true
      };
    }
  };
}

function marketPriceReader(rate = liveRate) {
  return {
    async getRate() {
      return {
        rateWei: parseUnits(rate, 18),
        onChainRateWei: parseUnits(rate, 18),
        externalRateWei: parseUnits(rate, 18),
        deviationBps: 0n,
        liquidityUsd: 9_500,
        pool: KATANA_POOL,
        checkedAt: Date.now()
      };
    }
  };
}

async function fixture(options = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/gift-boxes", createGiftBoxQuoteRouter({
    enabled: true,
    privateKey: signer.privateKey,
    owner: signer.address,
    contractRead: contractRead(),
    marketPriceReader: marketPriceReader(),
    ...options
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/gift-boxes`;
  return {
    server,
    async request(route, init) {
      const response = await fetch(`${base}${route}`, init);
      return { response, body: await response.json() };
    }
  };
}

function quoteRequest(overrides = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyer, recipient, tier: 0, ...overrides })
  };
}

test("creates a buyer-bound live-market EIP-712 quote", async () => {
  const fx = await fixture();
  const before = Math.floor(Date.now() / 1_000);
  const { response, body } = await fx.request("/quote", quoteRequest());
  assert.equal(response.status, 200);
  assert.equal(body.buyer, buyer);
  assert.equal(body.recipient, recipient);
  assert.equal(body.priceRon, parseEther("100").toString());
  assert.equal(body.mattPerRon, liveRate);
  assert.equal(body.baseMatt, parseEther("1112810").toString());
  assert.equal(body.configVersion, "7");
  assert.equal(body.pricing.source, "Katana V3 + CoinGecko");
  assert.ok(body.deadline >= before + 118 && body.deadline <= before + 122);
  const recovered = verifyTypedData({
    name: "MATT Gift Boxes",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: GIFT_BOXES
  }, PRICE_QUOTE_TYPES, {
    buyer: body.buyer,
    recipient: body.recipient,
    tier: body.tier,
    baseMatt: BigInt(body.baseMatt),
    nonce: BigInt(body.nonce),
    deadline: body.deadline,
    configVersion: BigInt(body.configVersion)
  }, body.signature);
  assert.equal(recovered, signer.address);
  fx.server.close();
});

test("fails closed when disabled, paused, misconfigured, unpriced, or given invalid input", async () => {
  const disabled = await fixture({ enabled: false });
  assert.equal((await disabled.request("/quote", quoteRequest())).response.status, 503);
  disabled.server.close();

  const paused = await fixture({ contractRead: contractRead({ paused: true }) });
  assert.equal((await paused.request("/quote", quoteRequest())).response.status, 409);
  paused.server.close();

  const mismatch = await fixture({ owner: Wallet.createRandom().address });
  const mismatchConfig = await mismatch.request("/config");
  assert.equal(mismatchConfig.body.enabled, false);
  assert.equal((await mismatch.request("/quote", quoteRequest())).response.status, 503);
  mismatch.server.close();

  const unpriced = await fixture({
    marketPriceReader: { async getRate() { throw new Error("no safe price"); } }
  });
  assert.equal((await unpriced.request("/config")).body.enabled, false);
  assert.equal((await unpriced.request("/quote", quoteRequest())).response.status, 502);
  unpriced.server.close();

  const invalid = await fixture();
  assert.equal((await invalid.request("/quote", quoteRequest({ buyer: "not-an-address" }))).response.status, 400);
  assert.equal((await invalid.request("/quote", quoteRequest({ tier: 3 }))).response.status, 400);
  invalid.server.close();
});

test("rate limits repeated quote requests for the same buyer", async () => {
  const fx = await fixture();
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await fx.request("/quote", quoteRequest())).response.status, 200);
  }
  const limited = await fx.request("/quote", quoteRequest());
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, "BUYER_RATE_LIMIT");
  fx.server.close();
});

test("uses the lower agreeing Katana and CoinGecko rates", async () => {
  const sqrtPriceX96 = 751116074902070579413882856n;
  const reader = createMarketPriceReader({
    cacheMs: 0,
    poolRead: {
      async token0() { return MATT; },
      async token1() { return WRON; },
      async slot0() { return { sqrtPriceX96 }; }
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return geckoPayload("11128.1078556056", "9667.56");
      }
    })
  });
  const market = await reader.getRate();
  assert.equal(market.rateWei, market.onChainRateWei);
  assert.ok(market.externalRateWei > market.onChainRateWei);
  assert.ok(market.deviationBps < 10n);
});

test("rejects wrong pools, low liquidity, and divergent prices", async () => {
  const poolRead = {
    async token0() { return MATT; },
    async token1() { return WRON; },
    async slot0() { return { sqrtPriceX96: 751116074902070579413882856n }; }
  };
  const lowLiquidity = createMarketPriceReader({
    cacheMs: 0,
    poolRead,
    fetchImpl: async () => ({ ok: true, async json() { return geckoPayload("11128", "4999"); } })
  });
  await assert.rejects(lowLiquidity.getRate(), /liquidity/);

  const divergent = createMarketPriceReader({
    cacheMs: 0,
    poolRead,
    fetchImpl: async () => ({ ok: true, async json() { return geckoPayload("15000", "9500"); } })
  });
  await assert.rejects(divergent.getRate(), /disagree/);

  const wrongPool = createMarketPriceReader({
    cacheMs: 0,
    poolRead,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        const payload = geckoPayload("11128", "9500");
        payload.data.id = "ronin_0x0000000000000000000000000000000000000001";
        return payload;
      }
    })
  });
  await assert.rejects(wrongPool.getRate(), /wrong pool/);
});

function geckoPayload(mattPerRon, liquidityUsd) {
  return {
    data: {
      id: `ronin_${KATANA_POOL}`,
      attributes: {
        quote_token_price_base_token: mattPerRon,
        reserve_in_usd: liquidityUsd
      },
      relationships: {
        base_token: { data: { id: `ronin_${MATT}` } },
        quote_token: { data: { id: `ronin_${WRON}` } },
        dex: { data: { id: "katana-v3" } }
      }
    }
  };
}
