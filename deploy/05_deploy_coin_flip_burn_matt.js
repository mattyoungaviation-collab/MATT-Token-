const { ethers } = require("hardhat");

const LIVE = Object.freeze({
  matt: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
  wrappedRon: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
  katanaV3Factory: "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c",
  treasury: "0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc",
  admin: "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984",
});

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();
  const isRonin = network.name === "ronin";
  const existingVault = await getOrNull("MattRewardVault");
  const values = {
    matt: process.env.MATT_TOKEN_ADDRESS || (isRonin ? LIVE.matt : ""),
    wrappedRon: process.env.WRON_TOKEN_ADDRESS || (isRonin ? LIVE.wrappedRon : ""),
    katanaV3Factory: process.env.KATANA_V3_FACTORY || (isRonin ? LIVE.katanaV3Factory : ""),
    treasury: process.env.BURNFLIP_TREASURY || (isRonin ? LIVE.treasury : ""),
    admin: process.env.BURNFLIP_ADMIN || (isRonin ? LIVE.admin : deployer),
    vault: process.env.BURNFLIP_REWARD_VAULT || existingVault?.address || "",
  };

  for (const [name, value] of Object.entries(values)) {
    if (!value || !ethers.isAddress(value)) {
      throw new Error(`Set ${name} to a valid 0x address before deploying BurnFlip`);
    }
  }
  if (await ethers.provider.getCode(values.vault) === "0x") {
    throw new Error(`Reward vault ${values.vault} has no contract code`);
  }

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`Reused reward vault: ${values.vault}`);
  console.log("MATT wagers use exact 1:1 identity pricing.");

  const game = await deploy("MattCoinFlipBurnMatt", {
    contract: "MattCoinFlipBurn",
    from: deployer,
    args: [
      values.matt,
      values.wrappedRon,
      values.katanaV3Factory,
      values.treasury,
      values.vault,
      values.admin,
    ],
    log: true,
    waitConfirmations: isRonin ? 5 : 1,
  });

  console.log(`Replacement BurnFlip: ${game.address}`);
  console.log("Replacement remains paused. Configure assets before switching the vault.");
};

module.exports.tags = ["MattCoinFlipBurnMatt"];
