const { ethers } = require("hardhat");

const LIVE_MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const LIVE_COIN_FLIP_ADDRESS = "0x4C014Eb6F1e65c97A006beC8c8F2fB8Fbbf5F5aB";

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const mattToken = process.env.MATT_TOKEN_ADDRESS || (network.name === "ronin" ? LIVE_MATT_ADDRESS : "");
  const coinFlip = process.env.MATT_COIN_FLIP_ADDRESS || (network.name === "ronin" ? LIVE_COIN_FLIP_ADDRESS : "");
  const owner = process.env.DAILY_REWARDS_OWNER || deployer;

  for (const [name, value] of Object.entries({ mattToken, coinFlip, owner })) {
    if (!value || !ethers.isAddress(value)) {
      throw new Error(`Set ${name} to a valid 0x address before deploying MattDailyRewards`);
    }
  }

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`MATT token: ${mattToken}`);
  console.log(`Coin flip: ${coinFlip}`);
  console.log(`Daily rewards owner: ${owner}`);

  await deploy("MattDailyRewards", {
    from: deployer,
    args: [mattToken, coinFlip, owner],
    log: true,
    waitConfirmations: network.name === "ronin" ? 5 : 1,
  });
};

module.exports.tags = ["MattDailyRewards"];
