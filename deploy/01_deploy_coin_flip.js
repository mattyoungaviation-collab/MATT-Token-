const { ethers } = require("hardhat");

const LIVE_MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const LIVE_TREASURY_ADDRESS = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const mattToken =
    process.env.MATT_TOKEN_ADDRESS ||
    (network.name === "ronin" ? LIVE_MATT_ADDRESS : "");
  const treasury =
    process.env.TREASURY_ADDRESS ||
    (network.name === "ronin" ? LIVE_TREASURY_ADDRESS : "");
  const owner = process.env.COIN_FLIP_OWNER || deployer;

  for (const [name, value] of Object.entries({ mattToken, treasury, owner })) {
    if (!value || !ethers.isAddress(value)) {
      throw new Error(`Set ${name} to a valid 0x address before deploying MattCoinFlip`);
    }
  }

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`MATT token: ${mattToken}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`Coin flip owner: ${owner}`);

  await deploy("MattCoinFlip", {
    from: deployer,
    args: [mattToken, treasury, owner],
    log: true,
    waitConfirmations: network.name === "ronin" ? 5 : 1,
  });
};

module.exports.tags = ["MattCoinFlip"];
