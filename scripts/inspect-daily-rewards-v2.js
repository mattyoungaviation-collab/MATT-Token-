const hre = require("hardhat");

async function main() {
  const deployment = await hre.deployments.get("MattDailyRewardsV2");
  const receipt = await hre.ethers.provider.getTransactionReceipt(deployment.transactionHash);
  const rewards = await hre.ethers.getContractAt("MattDailyRewardsV2", deployment.address);
  const tokenAddress = await rewards.matt();
  const token = await hre.ethers.getContractAt("IERC20", tokenAddress);

  console.log(`MattDailyRewardsV2: ${deployment.address}`);
  console.log(`Deployment block: ${receipt?.blockNumber ?? "unknown"}`);
  console.log(`Owner: ${await rewards.owner()}`);
  console.log(`Verifier: ${await rewards.verifier()}`);
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