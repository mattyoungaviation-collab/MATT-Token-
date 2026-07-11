const { ethers } = require("hardhat");

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const treasury = process.env.TREASURY_ADDRESS;

  if (!treasury || !ethers.isAddress(treasury)) {
    throw new Error("Set TREASURY_ADDRESS to a valid 0x address in .env");
  }

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`Treasury: ${treasury}`);

  await deploy("MattToken", {
    from: deployer,
    args: [treasury],
    log: true,
    waitConfirmations: network.name === "ronin" ? 5 : 1,
  });
};

module.exports.tags = ["MattToken"];
