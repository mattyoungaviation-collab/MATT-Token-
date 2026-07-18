const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const matt = process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const treasury = process.env.MATT_TREASURY || "0xf79913cb83cc9cabd95d0ba9250103fbb939f984";
  const operator = process.env.FLAPPY_MATT_OPERATOR || deployer.address;
  const owner = process.env.FLAPPY_MATT_OWNER || deployer.address;

  console.log("Deploying FlappyMattPrizePool with:");
  console.log({ deployer: deployer.address, matt, treasury, operator, owner });

  const factory = await hre.ethers.getContractFactory("FlappyMattPrizePool");
  const contract = await factory.deploy(matt, treasury, operator, owner);
  await contract.waitForDeployment();

  console.log("FlappyMattPrizePool:", await contract.getAddress());
  console.log("Set FLAPPY_MATT_POT_ADDRESS to this address in Render after verification.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
