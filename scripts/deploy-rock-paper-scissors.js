const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const matt = hre.ethers.getAddress(process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d");
  const treasury = hre.ethers.getAddress(process.env.MATT_TREASURY || "0xf79913cb83cc9cabd95d0ba9250103fbb939f984");
  const owner = hre.ethers.getAddress(process.env.MATT_RPS_OWNER || deployer.address);
  console.log("Deploying MattRockPaperScissors:", { deployer: deployer.address, matt, treasury, owner });
  const factory = await hre.ethers.getContractFactory("MattRockPaperScissors");
  const contract = await factory.deploy(matt, treasury, owner);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("MattRockPaperScissors:", address);
  console.log("Set MATT_RPS_ADDRESS=" + address + " after verification.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
