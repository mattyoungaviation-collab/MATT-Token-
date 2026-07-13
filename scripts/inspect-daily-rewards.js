const hre = require("hardhat");

async function main() {
  const deployment = await hre.deployments.get("MattDailyRewards");
  const rewards = await hre.ethers.getContractAt("MattDailyRewards", deployment.address);
  const tokenAddress = await rewards.matt();
  const token = await hre.ethers.getContractAt("IERC20", tokenAddress);

  console.log(`MattDailyRewards: ${deployment.address}`);
  console.log(`Owner: ${await rewards.owner()}`);
  console.log(`MATT: ${tokenAddress}`);
  console.log(`Coin flip: ${await rewards.coinFlip()}`);
  console.log(`Reward amount: ${hre.ethers.formatEther(await rewards.REWARD_AMOUNT())} MATT`);
  console.log(`Cooldown: ${await rewards.CLAIM_COOLDOWN()} seconds`);
  console.log(`Reward pool: ${hre.ethers.formatEther(await token.balanceOf(deployment.address))} MATT`);
  console.log(`Available claims: ${await rewards.availableClaims()}`);
  console.log(`Paused: ${await rewards.paused()}`);
  console.log(`Total claims: ${await rewards.totalClaims()}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
