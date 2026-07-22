const hre = require("hardhat");

const RONIN_MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const DEFAULT_TREASURY = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const token = process.env.MATT_CRASH_TOKEN || (hre.network.name === "ronin" ? RONIN_MATT : "");
  const treasury = process.env.MATT_CRASH_TREASURY || DEFAULT_TREASURY;
  const operator = process.env.MATT_CRASH_OPERATOR || deployer.address;
  const rewardsWallet = process.env.MATT_CRASH_REWARDS_WALLET || treasury;

  for (const [name, value] of Object.entries({ token, treasury, operator, rewardsWallet })) {
    if (!hre.ethers.isAddress(value)) throw new Error(`${name} must be a valid address`);
  }

  console.log("Deploying MattCrashVault");
  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("MATT token:", token);
  console.log("Treasury/owner:", treasury);
  console.log("Settlement operator:", operator);
  console.log("Rewards wallet:", rewardsWallet);

  const Vault = await hre.ethers.getContractFactory("MattCrashVault");
  const vault = await Vault.deploy(token, treasury, operator, rewardsWallet);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("MattCrashVault deployed at:", address);
  console.log("The vault starts PAUSED.");
  console.log("Before unpausing: fund bankroll, confirm operator, limits, loss allocation, and rewards wallet.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
