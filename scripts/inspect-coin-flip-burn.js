const hre = require("hardhat");

async function main() {
  const deployment = await hre.deployments.get("MattCoinFlipBurn");
  const vaultDeployment = await hre.deployments.get("MattRewardVault");
  const game = await hre.ethers.getContractAt("MattCoinFlipBurn", deployment.address);
  const vault = await hre.ethers.getContractAt("MattRewardVault", vaultDeployment.address);
  const mattAddress = await game.matt();
  const matt = await hre.ethers.getContractAt("IERC20", mattAddress);

  console.log(`MattCoinFlipBurn: ${deployment.address}`);
  console.log(`Deployment block: ${deployment.receipt?.blockNumber ?? deployment.blockNumber ?? "unknown"}`);
  console.log(`Owner: ${await game.owner()}`);
  console.log(`MATT: ${mattAddress}`);
  console.log(`Treasury: ${await game.treasury()}`);
  console.log(`WRON: ${await game.wrappedRon()}`);
  console.log(`Katana V3 factory: ${await game.katanaV3Factory()}`);
  console.log(`Reward vault: ${vault.target}`);
  console.log(`Vault authorized game: ${await vault.burnFlip()}`);
  console.log(`Vault balance: ${hre.ethers.formatEther(await matt.balanceOf(vault.target))} MATT`);
  console.log(`Available reward balance: ${hre.ethers.formatEther(await game.availableRewardBalance())} MATT`);
  console.log(`Reserved payouts: ${hre.ethers.formatEther(await game.reservedPayouts())} MATT`);
  console.log(`Burn rate: ${await game.burnBps()} bps`);
  console.log(`Payout multiplier: ${await game.payoutMultiplierBps()} bps`);
  console.log(`Total games: ${await game.totalGames()}`);
  console.log(`Total MATT paid: ${hre.ethers.formatEther(await game.totalMattPaid())} MATT`);
  console.log(`Total MATT burned: ${hre.ethers.formatEther(await game.totalMattBurned())} MATT`);
  console.log(`Game retained MATT: ${hre.ethers.formatEther(await matt.balanceOf(deployment.address))} MATT`);
  console.log(`Game paused: ${await game.paused()}`);
  console.log(`Vault paused: ${await vault.paused()}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
