"use strict";

// Local-only compatibility bridge for the installed Hardhat 2.29.1/EDR pair.
// Hardhat emits `hardforks`; EDR's installed API expects
// `hardforkActivationOverrides`. Unknown-chain histories otherwise disappear.
// This changes no activation, EVM rule, chain data or live RPC write behavior.
function adaptForkConfig(config) {
  if (!config.fork?.chainOverrides) return config;
  return { ...config, fork: { ...config.fork, chainOverrides: config.fork.chainOverrides.map(chain => {
    if (!chain.hardforks || chain.hardforkActivationOverrides) return chain;
    const { hardforks, ...rest } = chain;
    return { ...rest, hardforkActivationOverrides: hardforks };
  }) } };
}

async function installForkRuntimeCompatibility(hre) {
  if (hre.network.name !== "hardhat") throw new Error("COMPATIBILITY_REFUSES_LIVE_NETWORK");
  if (require("hardhat/package.json").version !== "2.29.1") return;
  const { getGlobalEdrContext } = require("hardhat/internal/hardhat-network/provider/provider");
  const context = await getGlobalEdrContext();
  const create = context.createProvider.bind(context);
  context.createProvider = (type, config, ...args) => create(type, adaptForkConfig(config), ...args);
}

module.exports = { adaptForkConfig, installForkRuntimeCompatibility };
