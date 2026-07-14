const hre = require("hardhat");

async function main() {
  const deployment = await hre.deployments.get("MattCoinFlipBurn");
  const game = await hre.ethers.getContractAt("MattCoinFlipBurn", deployment.address);
  const mattAddress = await game.matt();
  const matt = await hre.ethers.getContractAt("IERC20", mattAddress);

  console.log(`MattCoinFlipBurn: ${deployment.address}`);
  console.log(`Deployment block: ${deployment.receipt?.blockNumber ?? deployment.blockNumber ?? "unknown"}`);
  console.log(`Owner: ${await game.owner()}`);
  console.log(`MATT: ${mattAddress}`);
  console.log(`Minimum bet: ${hre.ethers.formatEther(await game.MIN_BET())} MATT`);
  console.log(`Available bankroll: ${hre.ethers.formatEther(await game.availableBankroll())} MATT`);
  console.log(`Maximum acceptable bet: ${hre.ethers.formatEther(await game.maxAcceptableBet())} MATT`);
  console.log(`Reserved payouts: ${hre.ethers.formatEther(await game.reservedPayouts())} MATT`);
  console.log(`Total burned by game: ${hre.ethers.formatEther(await game.totalBurnedByGame())} MATT`);
  console.log(`Contract balance: ${hre.ethers.formatEther(await matt.balanceOf(deployment.address))} MATT`);
  console.log(`Paused: ${await game.paused()}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
