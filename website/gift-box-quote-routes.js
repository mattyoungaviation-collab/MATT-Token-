const crypto = require("crypto");
const express = require("express");
const {
  Interface,
  Wallet,
  formatUnits,
  getAddress,
  parseUnits
} = require("ethers");

const CHAIN_ID = 2020;
const OWNER = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const WRON = "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4";
const GIFT_BOXES = "0x0F4b0637D60Af8e3dfE8aF8d7C9448d34a969EcE";
const KATANA_POOL = "0xa517e05e96728e80284f2ae157ddf309449d7ce8";
const GECKO_POOL_URL = `https://api.geckoterminal.com/api/v2/networks/ronin/pools/${KATANA_POOL}`;
const QUOTE_SECONDS = 120;
const ONE_TOKEN = 10n ** 18n;
const Q192 = 1n << 192n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_PRICE_DEVIATION_BPS = 300n;
const MIN_POOL_LIQUIDITY_USD = 5_000;
const PRICE_CACHE_MS = 15_000;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const CONTRACT_INTERFACE = new Interface([
  "function paused() view returns(bool)",
  "function activeConfigVersion() view returns(uint256)",
  "function getConfiguration(uint256) view returns(uint256[3] prices,uint32[] multipliersBps,uint16[] chancesBps,uint64 activatesAt,bool exists)"
]);
const POOL_INTERFACE = new Interface([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocolNum,uint8 feeProtocolDen,bool unlocked)"
]);
const PRICE_QUOTE_TYPES = {
  PriceQuote: [
    { name: "buyer", type: "address" },
    { name: "recipient", type: "address" },
    { name: "tier", type: "uint8" },
    { name: "baseMatt", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "configVersion", type: "uint256" }
  ]
};

function createGiftBoxQuoteRouter(options = {}) {
  const router = express.Router();
  router.use(express.json({ limit: "8kb", strict: true }));

  const enabled = options.enabled ?? envFlag("GIFT_BOX_PUBLIC_QUOTES_ENABLED");
  const owner = normalizeAddress(options.owner || OWNER);
  const contractAddress = normalizeAddress(options.contractAddress || GIFT_BOXES);
  const privateKey = String(options.privateKey ?? process.env.GIFT_BOX_QUOTE_PRIVATE_KEY ?? "").trim();
  const contractRead = options.contractRead || createContractReader(options.rpcRequest, contractAddress);
  const marketPriceReader = options.marketPriceReader || createMarketPriceReader({
    rpcRequest: options.rpcRequest,
    fetchImpl: options.fetchImpl
  });
  const ipWindows = new Map();
  const buyerWindows = new Map();
  let signer = null;
  let configurationError = "";

  try {
    if (privateKey) {
      signer = new Wallet(privateKey);
      if (signer.address !== owner) throw new Error("Quote signer does not match the deployed gift-box owner.");
    }
  } catch (error) {
    configurationError = safeError(error);
    signer = null;
  }

  const configured = () => enabled && Boolean(signer) && !configurationError;

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  router.get("/config", async (_req, res) => {
    let market = null;
    if (configured()) {
      try {
        market = await marketPriceReader.getRate();
      } catch (error) {
        console.error("Gift-box market price unavailable:", safeError(error));
      }
    }
    res.json({
      enabled: configured() && Boolean(market),
      chainId: CHAIN_ID,
      contract: contractAddress,
      owner,
      quoteSeconds: QUOTE_SECONDS,
      mattPerRon: market ? formatRate(market.rateWei) : null,
      pricing: market ? publicMarket(market) : null
    });
  });

  router.post("/quote", async (req, res) => {
    const ip = String(req.ip || req.socket.remoteAddress || "unknown");
    if (!takeRateLimit(ipWindows, ip, 20, 60_000)) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "QUOTE_RATE_LIMIT", message: "Too many quote requests. Try again shortly." });
    }
    if (!configured()) {
      return res.status(503).json({
        error: "QUOTES_DISABLED",
        message: "Public gift-box quotes are not enabled."
      });
    }

    const buyer = normalizeAddress(req.body?.buyer);
    const recipient = normalizeAddress(req.body?.recipient);
    const tier = Number(req.body?.tier);
    if (!buyer || !recipient || !Number.isInteger(tier) || tier < 0 || tier > 2) {
      return res.status(400).json({
        error: "INVALID_QUOTE_REQUEST",
        message: "A valid buyer, recipient, and gift-box tier are required."
      });
    }
    if (!takeRateLimit(buyerWindows, buyer, 6, 60_000)) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "BUYER_RATE_LIMIT", message: "This wallet requested too many quotes. Try again shortly." });
    }

    try {
      const market = await marketPriceReader.getRate();
      if (await contractRead.paused()) {
        return res.status(409).json({ error: "GIFT_BOXES_PAUSED", message: "Gift boxes are currently paused." });
      }
      const configVersion = BigInt(await contractRead.activeConfigVersion());
      const configuration = await contractRead.getConfiguration(configVersion);
      const prices = configuration.prices || configuration[0];
      const exists = configuration.exists ?? configuration[4];
      if (!exists || !prices || prices.length !== 3) throw new Error("Active gift-box configuration is unavailable.");

      const priceRon = BigInt(prices[tier]);
      const baseMatt = priceRon * market.rateWei / ONE_TOKEN;
      if (priceRon <= 0n || baseMatt <= 0n || baseMatt > MAX_UINT128) {
        throw new Error("Configured gift-box quote is outside the supported range.");
      }

      const nonce = BigInt(`0x${crypto.randomBytes(16).toString("hex")}`);
      const deadline = Math.floor(Date.now() / 1_000) + QUOTE_SECONDS;
      const value = {
        buyer,
        recipient,
        tier,
        baseMatt,
        nonce,
        deadline,
        configVersion
      };
      const signature = await signer.signTypedData({
        name: "MATT Gift Boxes",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: contractAddress
      }, PRICE_QUOTE_TYPES, value);

      return res.json({
        buyer,
        recipient,
        tier,
        priceRon: priceRon.toString(),
        baseMatt: baseMatt.toString(),
        mattPerRon: formatRate(market.rateWei),
        pricing: publicMarket(market),
        nonce: nonce.toString(),
        deadline,
        configVersion: configVersion.toString(),
        signature
      });
    } catch (error) {
      console.error("Gift-box quote failed:", safeError(error));
      return res.status(502).json({
        error: "QUOTE_UNAVAILABLE",
        message: "A safe live MATT price is unavailable. Try again shortly."
      });
    }
  });

  setInterval(() => {
    pruneWindows(ipWindows);
    pruneWindows(buyerWindows);
  }, 60_000).unref();

  return router;
}

function createMarketPriceReader(options = {}) {
  const poolRead = options.poolRead || createPoolReader(options.rpcRequest, KATANA_POOL);
  const fetchImpl = options.fetchImpl || global.fetch;
  const maxDeviationBps = BigInt(options.maxDeviationBps ?? MAX_PRICE_DEVIATION_BPS);
  const minLiquidityUsd = Number(options.minLiquidityUsd ?? MIN_POOL_LIQUIDITY_USD);
  const cacheMs = Number(options.cacheMs ?? PRICE_CACHE_MS);
  let cached = null;
  let pending = null;

  async function loadRate() {
    const [token0, token1, slot, external] = await Promise.all([
      poolRead.token0(),
      poolRead.token1(),
      poolRead.slot0(),
      loadExternalPool(fetchImpl)
    ]);
    if (normalizeAddress(token0) !== MATT || normalizeAddress(token1) !== WRON) {
      throw new Error("The configured Katana pool token ordering is invalid.");
    }
    const sqrtPriceX96 = BigInt(slot.sqrtPriceX96 ?? slot[0]);
    if (sqrtPriceX96 <= 0n) throw new Error("The Katana pool price is unavailable.");
    const onChainRateWei = Q192 * ONE_TOKEN / (sqrtPriceX96 * sqrtPriceX96);
    const externalRateWei = parsePositiveRate(external.mattPerRon);
    if (!Number.isFinite(external.liquidityUsd) || external.liquidityUsd < minLiquidityUsd) {
      throw new Error("The MATT/WRON pool liquidity is below the quote safety threshold.");
    }
    const lower = onChainRateWei < externalRateWei ? onChainRateWei : externalRateWei;
    const upper = onChainRateWei > externalRateWei ? onChainRateWei : externalRateWei;
    const deviationBps = lower > 0n ? (upper - lower) * 10_000n / lower : 10_000n;
    if (lower <= 0n || deviationBps > maxDeviationBps) {
      throw new Error("Live MATT price sources disagree beyond the quote safety limit.");
    }
    return {
      rateWei: lower,
      onChainRateWei,
      externalRateWei,
      deviationBps,
      liquidityUsd: external.liquidityUsd,
      pool: KATANA_POOL,
      checkedAt: Date.now()
    };
  }

  return {
    async getRate() {
      if (cached && Date.now() - cached.checkedAt < cacheMs) return cached;
      if (!pending) {
        pending = loadRate()
          .then(value => {
            cached = value;
            return value;
          })
          .finally(() => { pending = null; });
      }
      return pending;
    }
  };
}

async function loadExternalPool(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("The independent market feed is unavailable.");
  const response = await fetchImpl(GECKO_POOL_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`The independent market feed returned HTTP ${response.status}.`);
  const payload = await response.json();
  const data = payload?.data;
  const attributes = data?.attributes;
  const relationships = data?.relationships;
  if (
    String(data?.id || "").toLowerCase() !== `ronin_${KATANA_POOL}`.toLowerCase()
    || normalizeRelationAddress(relationships?.base_token?.data?.id) !== MATT
    || normalizeRelationAddress(relationships?.quote_token?.data?.id) !== WRON
    || String(relationships?.dex?.data?.id || "") !== "katana-v3"
  ) {
    throw new Error("The independent market feed returned the wrong pool.");
  }
  return {
    mattPerRon: String(attributes?.quote_token_price_base_token || ""),
    liquidityUsd: Number(attributes?.reserve_in_usd)
  };
}

function createContractReader(rpcRequest, contractAddress) {
  if (typeof rpcRequest !== "function") return unavailableReader("Gift-box RPC is unavailable.");
  async function call(name, args = []) {
    const data = CONTRACT_INTERFACE.encodeFunctionData(name, args);
    const result = await rpcRequest("eth_call", [{ to: contractAddress, data }, "latest"]);
    return CONTRACT_INTERFACE.decodeFunctionResult(name, result);
  }
  return {
    async paused() { return (await call("paused"))[0]; },
    async activeConfigVersion() { return (await call("activeConfigVersion"))[0]; },
    async getConfiguration(version) { return call("getConfiguration", [version]); }
  };
}

function createPoolReader(rpcRequest, poolAddress) {
  if (typeof rpcRequest !== "function") return unavailableReader("Katana pool RPC is unavailable.");
  async function call(name) {
    const data = POOL_INTERFACE.encodeFunctionData(name);
    const result = await rpcRequest("eth_call", [{ to: poolAddress, data }, "latest"]);
    return POOL_INTERFACE.decodeFunctionResult(name, result);
  }
  return {
    async token0() { return (await call("token0"))[0]; },
    async token1() { return (await call("token1"))[0]; },
    async slot0() { return call("slot0"); }
  };
}

function unavailableReader(message) {
  return new Proxy({}, { get: () => async () => { throw new Error(message); } });
}

function parsePositiveRate(value) {
  const text = String(value || "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text)) throw new Error("The live MATT/RON rate is invalid.");
  const parsed = parseUnits(text, 18);
  if (parsed <= 0n) throw new Error("The live MATT/RON rate must be positive.");
  return parsed;
}

function formatRate(rateWei) {
  return formatUnits(rateWei, 18).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

function publicMarket(market) {
  return {
    source: "Katana V3 + CoinGecko",
    pool: market.pool,
    deviationBps: market.deviationBps.toString(),
    liquidityUsd: market.liquidityUsd,
    checkedAt: new Date(market.checkedAt).toISOString()
  };
}

function normalizeRelationAddress(value) {
  return normalizeAddress(String(value || "").replace(/^ronin_/i, ""));
}

function normalizeAddress(value) {
  const text = String(value || "").trim();
  if (!ADDRESS_PATTERN.test(text)) return "";
  try { return getAddress(text); } catch { return ""; }
}

function takeRateLimit(windows, key, limit, windowMs) {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    windows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function pruneWindows(windows) {
  const cutoff = Date.now() - 120_000;
  for (const [key, value] of windows) if (value.startedAt < cutoff) windows.delete(key);
}

function envFlag(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 220);
}

module.exports = {
  CHAIN_ID,
  GECKO_POOL_URL,
  GIFT_BOXES,
  KATANA_POOL,
  MATT,
  OWNER,
  PRICE_QUOTE_TYPES,
  WRON,
  createGiftBoxQuoteRouter,
  createMarketPriceReader
};
