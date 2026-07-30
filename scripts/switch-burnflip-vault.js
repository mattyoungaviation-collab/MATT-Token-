const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const vaultDeployment = await hre.deployments.get("MattRewardVault");
  const replacementDeployment =
    await hre.deployments.get("MattCoinFlipBurnMatt");
  const vault = await hre.ethers.getContractAt(
    "MattRewardVault",
    vaultDeployment.address,
    signer,
  );
  const currentGameAddress = await vault.burnFlip();
  const currentGame = await hre.ethers.getContractAt(
    "MattCoinFlipBurn",
    currentGameAddress,
    signer,
  );
  const replacement = await hre.ethers.getContractAt(
    "MattCoinFlipBurn",
    replacementDeployment.address,
    signer,
  );

  if ((await vault.owner()).toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the reward-vault owner`);
  }
  if (!(await vault.paused())) {
    throw new Error("Pause the reward vault before changing its authorized game");
  }
  if (!(await currentGame.paused())) {
    throw new Error(`Current game ${currentGameAddress} is not paused`);
  }
  if ((await currentGame.reservedPayouts()) !== 0n) {
    throw new Error("Current game still has reserved payouts");
  }
  if (!(await replacement.paused())) {
    throw new Error("Replacement game must remain paused during migration");
  }
  if ((await replacement.reservedPayouts()) !== 0n) {
    throw new Error("Replacement game unexpectedly has reserved payouts");
  }

  if (currentGameAddress.toLowerCase() === replacement.target.toLowerCase()) {
    console.log(`Reward vault already authorizes ${replacement.target}`);
    return;
  }

  console.log(`Previous authorized game: ${currentGameAddress}`);
  console.log(`Replacement game: ${replacement.target}`);
  const tx = await vault.configureBurnFlip(replacement.target);
  console.log(`Vault switch transaction: ${tx.hash}`);
  await tx.wait(3);
  console.log(`Vault authorized game: ${await vault.burnFlip()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
