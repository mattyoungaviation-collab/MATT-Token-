const { ethers } = require("hardhat");

const LIVE_MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const mattToken = process.env.MATT_TOKEN_ADDRESS || (network.name === "ronin" ? LIVE_MATT_ADDRESS : "");
  const owner = process.env.COIN_FLIP_BURN_OWNER || deployer;

  for (const [name, value] of Object.entries({ mattToken, owner })) {
    if (!value || !ethers.isAddress(value)) throw new Error(`Set ${name} to a valid 0x address before deploying MattCoinFlipBurn`);
  }

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`MATT token: ${mattToken}`);
  console.log(`Burn coin flip owner: ${owner}`);

  await deploy("MattCoinFlipBurn", {
    from: deployer,
    args: [mattToken, owner],
    log: true,
    waitConfirmations: network.name === "ronin" ? 5 : 1,
  });
};

module.exports.tags = ["MattCoinFlipBurn"];
