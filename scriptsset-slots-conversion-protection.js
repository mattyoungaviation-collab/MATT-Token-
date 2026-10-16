const hre = require("hardhat");

const DEFAULT_CONVERTER = "0xCe4CBBD4d2Ee93a678297E3a27cb14Ece80A04a2";
const CONFIRMATION = "YES";
const MAX_ALLOWED_BPS = 1500;

function targetBps() {
  const value = Number(process.env.SLOTS_CONVERSION_MAX_SLIPPAGE_BPS || "");
  if (!Number.isInteger(value) || value < 0 || value > MAX_ALLOWED_BPS) {
    throw new Error("Set SLOTS_CONVERSION_MAX_SLIPPAGE_BPS to an integer from 0 through 1500.");
  }
  return value;
}

async function main() {
  if (process.env.CONFIRM_SET_SLOTS_CONVERSION_PROTECTION !== CONFIRMATION) {
    throw new Error(
      "Protection update is locked. Set CONFIRM_SET_SLOTS_CONVERSION_PROTECTION=YES."
    );
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 2020n) {
    throw new Error("This script is restricted to Ronin mainnet (chain ID 2020).");
  }

  const [signer] = await hre.ethers.getSigners();
  const converterAddress = hre.ethers.getAddress(
    process.env.SLOTS_CONVERTER_ADDRESS || DEFAULT_CONVERTER
  );
  const converter = await hre.ethers.getContractAt(
    "MattSlotsTreasuryConverter",
    converterAddress,
    signer
  );

  const target = targetBps();
  const [owner, currentBps, minimumLiquidity, initiallyPaused] = await Promise.all([
    converter.owner(),
    converter.maxSlippageBps(),
    converter.minHarmonicLiquidity(),
    converter.paused()
  ]);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("Signer is not the converter owner.");
  }

  console.log("Slots conversion protection preflight", {
    network: "Ronin mainnet",
    converter: converterAddress,
    signer: signer.address,
    currentMaxSlippageBps: Number(currentBps),
    targetMaxSlippageBps: target,
    minHarmonicLiquidity: minimumLiquidity.toString(),
    initiallyPaused
  });

  if (Number(currentBps) === target && !initiallyPaused) {
    console.log("Converter already has the requested protection and is unpaused.");
    return;
  }

  if (!initiallyPaused) {
    const pauseTx = await converter.pause();
    console.log("Converter pause broadcast", { hash: pauseTx.hash });
    await pauseTx.wait(2);
  }

  try {
    if (Number(currentBps) !== target) {
      const updateTx = await converter.setConversionProtection(target, minimumLiquidity);
      console.log("Protection update broadcast", { hash: updateTx.hash });
      await updateTx.wait(2);
    }

    const unpauseTx = await converter.unpause();
    console.log("Converter unpause broadcast", { hash: unpauseTx.hash });
    await unpauseTx.wait(2);
  } catch (error) {
    console.error(
      "Protection update did not complete. The converter was deliberately left paused for safety."
    );
    throw error;
  }

  const [finalBps, finalMinimumLiquidity, finalPaused] = await Promise.all([
    converter.maxSlippageBps(),
    converter.minHarmonicLiquidity(),
    converter.paused()
  ]);

  if (
    Number(finalBps) !== target ||
    finalMinimumLiquidity !== minimumLiquidity ||
    finalPaused
  ) {
    throw new Error("Final converter state did not match the requested protection.");
  }

  console.log("Slots conversion protection updated", {
    converter: converterAddress,
    maxSlippageBps: Number(finalBps),
    minHarmonicLiquidity: finalMinimumLiquidity.toString(),
    paused: finalPaused
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});