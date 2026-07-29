const { ethers } = require("hardhat");

const LIVE = Object.freeze({
  matt: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
  wrappedRon: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
  katanaV3Factory: "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c",
  treasury: "0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc",
  admin: "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984",
});

module.exports = async ({ deployments, getNamedAccounts, network }) => {
  const { deploy, execute, read } = deployments;
  const { deployer } = await getNamedAccounts();
  const isRonin = network.name === "ronin";
  const values = {
    matt: process.env.MATT_TOKEN_ADDRESS || (isRonin ? LIVE.matt : ""),
    wrappedRon: process.env.WRON_TOKEN_ADDRESS || (isRonin ? LIVE.wrappedRon : ""),
    katanaV3Factory: process.env.KATANA_V3_FACTORY || (isRonin ? LIVE.katanaV3Factory : ""),
    treasury: process.env.BURNFLIP_TREASURY || (isRonin ? LIVE.treasury : ""),
    admin: process.env.BURNFLIP_ADMIN || (isRonin ? LIVE.admin : deployer),
  };

  for (const [name, value] of Object.entries(values)) {
    if (!value || !ethers.isAddress(value)) {
      throw new Error(`Set ${name} to a valid 0x address before deploying BurnFlip`);
    }
  }

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`MATT: ${values.matt}`);
  console.log(`WRON: ${values.wrappedRon}`);
  console.log(`Katana V3 factory: ${values.katanaV3Factory}`);
  console.log(`Treasury Safe: ${values.treasury}`);
  console.log(`Admin: ${values.admin}`);

  const vault = await deploy("MattRewardVault", {
    from: deployer,
    args: [values.matt, values.admin],
    log: true,
    waitConfirmations: isRonin ? 5 : 1,
  });
  const game = await deploy("MattCoinFlipBurn", {
    from: deployer,
    args: [
      values.matt,
      values.wrappedRon,
      values.katanaV3Factory,
      values.treasury,
      vault.address,
      values.admin,
    ],
    log: true,
    waitConfirmations: isRonin ? 5 : 1,
  });

  if (deployer.toLowerCase() === values.admin.toLowerCase()) {
    const configuredGame = await read("MattRewardVault", "burnFlip");
    if (configuredGame === ethers.ZeroAddress) {
      await execute(
        "MattRewardVault",
        { from: deployer, log: true },
        "configureBurnFlip",
        game.address,
      );
    } else if (configuredGame.toLowerCase() !== game.address.toLowerCase()) {
      throw new Error(
        `Reward vault already points to ${configuredGame}; pause and migrate it explicitly`,
      );
    }
  } else {
    console.warn("Admin differs from deployer. The Safe must configure the vault before funding or unpausing.");
  }

  console.log("BurnFlip and its reward vault remain paused by design.");
};

module.exports.tags = ["MattCoinFlipBurn", "MattRewardVault"];
