"use strict";

const express = require("express");
const { Contract, JsonRpcProvider } = require("ethers");
const { readActiveRound, readRound } = require("./public-state");

// Public chain projection only. No identity signer, auth, admin, quote or checkout route.
function createReadOnlyDynoRouter({ manifest, env = process.env, chainProvider, raffleManager, now = () => Date.now() }) {
  const router = express.Router();
  const provider = chainProvider || (env[manifest.rpcUrlEnv]
    ? new JsonRpcProvider(env[manifest.rpcUrlEnv], manifest.chainId, { staticNetwork: true }) : null);
  const manager = raffleManager || (provider
    ? new Contract(manifest.raffleProxy, require("../../packages/abis/ProjectDynoRaffleManager.json").abi, provider) : null);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/health", (_req, res) => res.json({ ok: true, environment: "production", mock: false,
    enabled: true, readOnly: true, purchasesEnabled: false, chainReaderConfigured: !!provider }));
  router.get("/config", (_req, res) => res.json({ environment: "production", mock: false, chainId: manifest.chainId,
    enabled: true, readOnly: true, purchasesEnabled: false, paymentModel: manifest.paymentModel,
    raffleProxy: manifest.raffleProxy, buybackProxy: manifest.buybackProxy, matt: manifest.matt,
    nftCollection: manifest.nftCollection, nftTokenId: manifest.nftTokenId,
    nftChainId: manifest.nftChainId, prizeDelivery: manifest.prizeDelivery }));
  router.get("/active-round", async (_req, res) => {
    try {
      if (!provider || !manager) throw Error("CHAIN_UNAVAILABLE");
      res.json(await readActiveRound({ provider, manager, chainId: manifest.chainId, nowSeconds: Math.floor(now() / 1000) }));
    } catch { res.status(503).json({ error: "CHAIN_STATE_UNAVAILABLE", purchasesEnabled: false }); }
  });
  router.get("/round", async (req, res) => {
    try {
      if (!provider || !manager) throw Error("CHAIN_UNAVAILABLE");
      res.json(await readRound({ provider, manager, chainId: manifest.chainId,
        roundId: String(req.query.roundId || "1"), nowSeconds: Math.floor(now() / 1000) }));
    } catch { res.status(503).json({ error: "CHAIN_STATE_UNAVAILABLE", purchasesEnabled: false }); }
  });
  router.use((_req, res) => res.status(503).json({ error: "DYNO_READ_ONLY", purchasesEnabled: false }));
  return router;
}

module.exports = { createReadOnlyDynoRouter };
