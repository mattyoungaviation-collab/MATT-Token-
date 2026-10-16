"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const RONIN_CHAIN_ID = 2020n;
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

function parseOptionalSlippage(current) {
  const raw = process.env.SLOTS_CONVERSION_MAX_SLIPPAGE_BPS;
  if (raw === undefined || raw === "") return current;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 1500) {
    throw new Error("SLOTS_CONVERSION_MAX_SLIPPAGE_BPS must be an integer from 0 through 1500.");
  }
  return value;
}

function parseOptionalLiquidity(current) {
  const raw = process.env.SLOTS_CONVERSION_MIN_HARMONIC_LIQUIDITY;
  if (raw === undefined || raw === "") return current;
  if (!/^\d+$/.test(raw)) {
    throw new Error("SLOTS_CONVERSION_MIN_HARMONIC_LIQUIDITY must be a positive integer.");
  }
  const value = BigInt(raw);
  if (value <= 0n || value > ((1n << 128n) - 1n)) {
    throw new Error("SLOTS_CONVERSION_MIN_HARMONIC_LIQUIDITY must fit uint128 and exceed zero.");
  }
  return value;
}

async function waitFor(tx, label) {
  console.log(`${label} broadcast`, { hash: tx.hash });
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed: ${tx.hash}`);
  return receipt;
}

async function main() {
  if (process.env.CONFIRM_SET_SLOTS_KYBER_ROUTER !== "YES") {
    throw new Error(
      "Kyber router migration is locked. Set CONFIRM_SET_SLOTS_KYBER_ROUTER=YES after reviewing the preflight settings."
    );
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_CHAIN_ID) {
    throw new Error(`Expected Ronin mainnet chain 2020, received ${network.chainId}.`);
  }

  const deploymentPath = process.env.SLOTS_DEPLOYMENT_FILE
    || path.join(__dirname, "../deployment-exports/slots-ronin.json");
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("No signer is configured.");

  const converter = await hre.ethers.getContractAt(
    "MattSlotsTreasuryConverter",
    deployment.contracts.converter,
    signer
  );
  const signerAddress = await signer.getAddress();
  const owner = await converter.owner();
  if (signerAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signerAddress} is not converter owner ${owner}.`);
  }

  const kyberRouter = hre.ethers.getAddress(KYBER_ROUTER);
  if (await hre.ethers.provider.getCode(kyberRouter) === "0x") {
    throw new Error(`Kyber router has no runtime code at ${kyberRouter}.`);
  }

  const currentRouter = hre.ethers.getAddress(await converter.router());
  const currentSlippageBps = Number(await converter.maxSlippageBps());
  const targetSlippageBps = parseOptionalSlippage(currentSlippageBps);
  const currentMinHarmonicLiquidity = await converter.minHarmonicLiquidity();
  const targetMinHarmonicLiquidity = parseOptionalLiquidity(currentMinHarmonicLiquidity);
  const wasPaused = await converter.paused();
  const routerChangeRequired = currentRouter !== kyberRouter;
  const protectionChangeRequired = (
    currentSlippageBps !== targetSlippageBps
    || currentMinHarmonicLiquidity !== targetMinHarmonicLiquidity
  );

  console.log("Slots Kyber router migration preflight", {
    network: "Ronin mainnet",
    converter: await converter.getAddress(),
    owner,
    signer: signerAddress,
    currentRouter,
    newRouter: kyberRouter,
    currentMaxSlippageBps: currentSlippageBps,
    newMaxSlippageBps: targetSlippageBps,
    currentMinHarmonicLiquidity: currentMinHarmonicLiquidity.toString(),
    newMinHarmonicLiquidity: targetMinHarmonicLiquidity.toString(),
    startsPaused: wasPaused,
    willRestoreUnpausedState: !wasPaused
  });

  if (!routerChangeRequired && !protectionChangeRequired) {
    console.log("Slots converter is already configured for Kyber with the requested protection.");
    return;
  }

  if (!wasPaused) await waitFor(await converter.pause(), "Converter pause");
  if (routerChangeRequired) {
    await waitFor(await converter.setRouter(kyberRouter), "Kyber router configuration");
  }
  if (protectionChangeRequired) {
    await waitFor(
      await converter.setConversionProtection(targetSlippageBps, targetMinHarmonicLiquidity),
      "Conversion protection configuration"
    );
  }
  if (!wasPaused) await waitFor(await converter.unpause(), "Converter unpause");

  console.log("Slots converter configured for protected Kyber routing", {
    converter: await converter.getAddress(),
    router: kyberRouter,
    maxSlippageBps: targetSlippageBps,
    minHarmonicLiquidity: targetMinHarmonicLiquidity.toString(),
    pausedStateRestored: wasPaused ? "paused" : "unpaused"
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
