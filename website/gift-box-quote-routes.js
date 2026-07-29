const crypto = require("crypto");
const express = require("express");
const {
  Interface,
  Wallet,
  getAddress,
  parseUnits
} = require("ethers");

const CHAIN_ID = 2020;
const OWNER = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const GIFT_BOXES = "0x0F4b0637D60Af8e3dfE8aF8d7C9448d34a969EcE";
const QUOTE_SECONDS = 120;
const ONE_TOKEN = 10n ** 18n;
const MAX_UINT128 = (1n << 128n) - 1n;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const CONTRACT_INTERFACE = new Interface([
  "function paused() view returns(bool)",
  "function activeConfigVersion() view returns(uint256)",
  "function getConfiguration(uint256) view returns(uint256[3] prices,uint32[] multipliersBps,uint16[] chancesBps,uint64 activatesAt,bool exists)"
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
  const rateText = String(options.mattPerRon ?? process.env.GIFT_BOX_MATT_PER_RON ?? "").trim();
  const privateKey = String(options.privateKey ?? process.env.GIFT_BOX_QUOTE_PRIVATE_KEY ?? "").trim();
  const contractRead = options.contractRead || createContractReader(options.rpcRequest, contractAddress);
  const ipWindows = new Map();
  const buyerWindows = new Map();
  let rateWei = 0n;
  let signer = null;
  let configurationError = "";

  try {
    rateWei = parsePositiveRate(rateText);
    if (privateKey) {
      signer = new Wallet(privateKey);
      if (signer.address !== owner) throw new Error("Quote signer does not match the deployed gift-box owner.");
    }
  } catch (error) {
    configurationError = safeError(error);
    signer = null;
  }

  const ready = () => enabled && Boolean(signer) && rateWei > 0n && !configurationError;

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  router.get("/config", (_req, res) => {
    res.json({
      enabled: ready(),
      chainId: CHAIN_ID,
      contract: contractAddress,
      owner,
      quoteSeconds: QUOTE_SECONDS,
      mattPerRon: ready() ? rateText : null
    });
  });

  router.post("/quote", async (req, res) => {
    const ip = String(req.ip || req.socket.remoteAddress || "unknown");
    if (!takeRateLimit(ipWindows, ip, 20, 60_000)) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "QUOTE_RATE_LIMIT", message: "Too many quote requests. Try again shortly." });
    }
    if (!ready()) {
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
      if (await contractRead.paused()) {
        return res.status(409).json({ error: "GIFT_BOXES_PAUSED", message: "Gift boxes are currently paused." });
      }
      const configVersion = BigInt(await contractRead.activeConfigVersion());
      const configuration = await contractRead.getConfiguration(configVersion);
      const prices = configuration.prices || configuration[0];
      const exists = configuration.exists ?? configuration[4];
      if (!exists || !prices || prices.length !== 3) throw new Error("Active gift-box configuration is unavailable.");

      const priceRon = BigInt(prices[tier]);
      const baseMatt = priceRon * rateWei / ONE_TOKEN;
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
        nonce: nonce.toString(),
        deadline,
        configVersion: configVersion.toString(),
        signature
      });
    } catch (error) {
      console.error("Gift-box quote failed:", safeError(error));
      return res.status(502).json({
        error: "QUOTE_UNAVAILABLE",
        message: "A signed gift-box quote could not be created. Try again shortly."
      });
    }
  });

  setInterval(() => {
    pruneWindows(ipWindows);
    pruneWindows(buyerWindows);
  }, 60_000).unref();

  return router;
}

function createContractReader(rpcRequest, contractAddress) {
  if (typeof rpcRequest !== "function") {
    return {
      async paused() { throw new Error("Gift-box RPC is unavailable."); },
      async activeConfigVersion() { throw new Error("Gift-box RPC is unavailable."); },
      async getConfiguration() { throw new Error("Gift-box RPC is unavailable."); }
    };
  }
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

function parsePositiveRate(value) {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error("GIFT_BOX_MATT_PER_RON must be a positive decimal.");
  const parsed = parseUnits(value, 18);
  if (parsed <= 0n) throw new Error("GIFT_BOX_MATT_PER_RON must be positive.");
  return parsed;
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
  GIFT_BOXES,
  OWNER,
  PRICE_QUOTE_TYPES,
  createGiftBoxQuoteRouter
};
