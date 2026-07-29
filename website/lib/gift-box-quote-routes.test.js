const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const { Wallet, parseEther, verifyTypedData } = require("ethers");
const {
  CHAIN_ID,
  GIFT_BOXES,
  PRICE_QUOTE_TYPES,
  createGiftBoxQuoteRouter
} = require("../gift-box-quote-routes");

const signer = new Wallet(`0x${"31".repeat(32)}`);
const buyer = new Wallet(`0x${"41".repeat(32)}`).address;
const recipient = new Wallet(`0x${"51".repeat(32)}`).address;

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

async function fixture(options = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/gift-boxes", createGiftBoxQuoteRouter({
    enabled: true,
    privateKey: signer.privateKey,
    owner: signer.address,
    mattPerRon: "10000",
    contractRead: contractRead(),
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

test("creates a buyer-bound two-minute EIP-712 quote from the active price", async () => {
  const fx = await fixture();
  const before = Math.floor(Date.now() / 1_000);
  const { response, body } = await fx.request("/quote", quoteRequest());
  assert.equal(response.status, 200);
  assert.equal(body.buyer, buyer);
  assert.equal(body.recipient, recipient);
  assert.equal(body.priceRon, parseEther("100").toString());
  assert.equal(body.baseMatt, parseEther("1000000").toString());
  assert.equal(body.configVersion, "7");
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

test("fails closed when disabled, paused, misconfigured, or given invalid input", async () => {
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
