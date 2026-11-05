"use strict";

const { AbstractProvider, JsonRpcProvider, Network } = require("ethers");

const PUBLIC_RONIN_RPCS = [
  "https://ronin.gateway.tenderly.co",
  "https://rpc-ronin-mainnet-bfz9fadqzl.t.conduit.xyz/",
  "https://api.roninchain.com/rpc",
];

function rpcUrls(env, manifest) {
  const candidates = [
    env.DYNO_API_RPC_URL,
    env.DYNO_RPC_URL,
    env[manifest.rpcUrlEnv],
    ...(manifest.chainId === 2020 && env.DYNO_PUBLIC_RPC_FALLBACK_DISABLED !== "true" ? PUBLIC_RONIN_RPCS : []),
  ];
  return [...new Set(candidates.map(value => String(value || "").trim()).filter(Boolean))];
}

function timeoutMs(env) {
  const value = Number(env.DYNO_RPC_FAILOVER_TIMEOUT_MS || 1500);
  if (!Number.isSafeInteger(value) || value < 250 || value > 10_000) throw new Error("DYNO_RPC_FAILOVER_TIMEOUT_MS must be an integer from 250 to 10000");
  return value;
}

async function beforeTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("RPC read timed out")), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

class ReadFailoverProvider extends AbstractProvider {
  constructor(providers, chainId, { requestTimeoutMs = 1500 } = {}) {
    if (!Array.isArray(providers) || providers.length < 2) throw new Error("Read failover requires at least two providers");
    super(Network.from(chainId));
    this.backends = providers;
    this.chainId = chainId;
    this.requestTimeoutMs = requestTimeoutMs;
  }
  async _detectNetwork() { return Network.from(this.chainId); }
  async _perform(request) {
    let lastError;
    for (const provider of this.backends) {
      try { return await beforeTimeout(provider._perform(request), this.requestTimeoutMs); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error("No RPC read provider available");
  }
  async send(method, params) {
    let lastError;
    for (const provider of this.backends) {
      try { return await beforeTimeout(provider.send(method, params), this.requestTimeoutMs); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error("No RPC read provider available");
  }
  destroy() {
    for (const provider of this.backends) provider.destroy?.();
    super.destroy();
  }
}

function createDynoReadProvider({ env = process.env, manifest, providerFactory = (url, chainId) => new JsonRpcProvider(url, chainId, { staticNetwork: true }) }) {
  const urls = rpcUrls(env, manifest);
  if (!urls.length) return null;
  const providers = urls.map(url => providerFactory(url, manifest.chainId));
  if (providers.length === 1) return providers[0];
  return new ReadFailoverProvider(providers, manifest.chainId, { requestTimeoutMs: timeoutMs(env) });
}

module.exports = { PUBLIC_RONIN_RPCS, ReadFailoverProvider, createDynoReadProvider, rpcUrls, timeoutMs };
