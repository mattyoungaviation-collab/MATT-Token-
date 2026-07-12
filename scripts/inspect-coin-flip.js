const { ethers, deployments } = require("hardhat");

async function main() {
  const deployment = await deployments.get("MattCoinFlip");
  const game = await ethers.getContractAt("MattCoinFlip", deployment.address);

  const [matt, treasury, owner, minBet, maxBet, revealWindow, available, reserved, paused] =
    await Promise.all([
      game.matt(),
      game.treasury(),
      game.owner(),
      game.MIN_BET(),
      game.MAX_BET(),
      game.REVEAL_WINDOW_BLOCKS(),
      game.availableBankroll(),
      game.reservedPayouts(),
      game.paused(),
    ]);

  console.log(`MattCoinFlip: ${deployment.address}`);
  console.log(`MATT token: ${matt}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`Owner: ${owner}`);
  console.log(`Minimum bet: ${ethers.formatEther(minBet)} MATT`);
  console.log(`Maximum bet: ${ethers.formatEther(maxBet)} MATT`);
  console.log(`Reveal window: ${revealWindow} blocks`);
  console.log(`Available bankroll: ${ethers.formatEther(available)} MATT`);
  console.log(`Reserved payouts: ${ethers.formatEther(reserved)} MATT`);
  console.log(`Paused: ${paused}`);

  if ((await game.matt()).toLowerCase() !== (process.env.MATT_TOKEN_ADDRESS || matt).toLowerCase()) {
    throw new Error("Unexpected MATT token address");
  }

  console.log("Coin flip deployment inspection passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
