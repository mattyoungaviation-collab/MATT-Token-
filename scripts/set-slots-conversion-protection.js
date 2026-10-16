const hre = require("hardhat");

const CONVERTER_ADDRESS = "0xCe4CBBD4d2Ee93a678297E3a27cb14Ece80A04a2";

async function main() {
  if (process.env.CONFIRM_SET_SLOTS_CONVERSION_PROTECTION !== "YES") {
    throw new Error(
      "Set CONFIRM_SET_SLOTS_CONVERSION_PROTECTION=YES to authorize this admin change."
    );
  }

  const targetBps = Number(process.env.SLOTS_CONVERSION_MAX_SLIPPAGE_BPS || "");
  if (!Number.isInteger(targetBps) || targetBps < 0 || targetBps > 1500) {
    throw new Error(
      "Set SLOTS_CONVERSION_MAX_SLIPPAGE_BPS to an integer from 0 through 1500."
    );
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 2020n) {
    throw new Error("This script is restricted to Ronin mainnet.");
  }

  const [signer] = await hre.ethers.getSigners();
  const converter = await hre.ethers.getContractAt(
    "MattSlotsTreasuryConverter",
    CONVERTER_ADDRESS,
    signer
  );

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
    converter: CONVERTER_ADDRESS,
    signer: signer.address,
    currentMaxSlippageBps: Number(currentBps),
    targetMaxSlippageBps: targetBps,
    minHarmonicLiquidity: minimumLiquidity.toString(),
    initiallyPaused
  });

  if (Number(currentBps) === targetBps && !initiallyPaused) {
    console.log("Converter already has the requested protection and is unpaused.");
    return;
  }

  if (!initiallyPaused) {
    const pauseTx = await converter.pause();
    console.log("Converter pause broadcast", { hash: pauseTx.hash });
    await pauseTx.wait(2);
  }

  try {
    if (Number(currentBps) !== targetBps) {
      const updateTx = await converter.setConversionProtection(
        targetBps,
        minimumLiquidity
      );
      console.log("Protection update broadcast", { hash: updateTx.hash });
      await updateTx.wait(2);
    }

    const unpauseTx = await converter.unpause();
    console.log("Converter unpause broadcast", { hash: unpauseTx.hash });
    await unpauseTx.wait(2);
  } catch (error) {
    console.error(
      "Update did not complete. The converter remains paused for safety."
    );
    throw error;
  }

  const [finalBps, finalLiquidity, finalPaused] = await Promise.all([
    converter.maxSlippageBps(),
    converter.minHarmonicLiquidity(),
    converter.paused()
  ]);

  if (
    Number(finalBps) !== targetBps ||
    finalLiquidity !== minimumLiquidity ||
    finalPaused
  ) {
    throw new Error("Final converter state does not match the requested settings.");
  }

  console.log("Slots conversion protection updated", {
    converter: CONVERTER_ADDRESS,
    maxSlippageBps: Number(finalBps),
    minHarmonicLiquidity: finalLiquidity.toString(),
    paused: finalPaused
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});