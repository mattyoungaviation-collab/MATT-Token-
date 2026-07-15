const hre = require("hardhat");

const MATT_TOKEN = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const TREASURY = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const operator = process.env.BLACKJACK_SETTLEMENT_OPERATOR || deployer.address;

  if (!hre.ethers.isAddress(operator)) {
    throw new Error("BLACKJACK_SETTLEMENT_OPERATOR must be a valid address");
  }

  console.log("Deploying MATT Blackjack Vault");
  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("MATT:", MATT_TOKEN);
  console.log("Treasury/owner:", TREASURY);
  console.log("Settlement operator:", operator);

  const Vault = await hre.ethers.getContractFactory("MattBlackjackVault");
  const vault = await Vault.deploy(MATT_TOKEN, TREASURY, operator);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("MattBlackjackVault deployed at:", address);
  console.log("The vault starts PAUSED. Treasury must fund it and then call unpause().");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
