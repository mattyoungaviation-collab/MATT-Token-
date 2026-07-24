const hre = require("hardhat");

const RONIN_MAINNET = 2020n;
const SAIGON_TESTNET = 202601n;
const MAINNET_MATT = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const MAINNET_TREASURY = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const MAINNET_VRF_COORDINATOR = "0x16a62a921e7fec5bf867ff5c805b662db757b778";
const SAIGON_VRF_COORDINATOR = "0xa60c1e07fa030e4b49eb54950adb298ab94dd312";

function addressFromEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required for this network.`);
  return hre.ethers.getAddress(value);
}

function requireMainnetAddress(name, actual, expected) {
  if (actual !== hre.ethers.getAddress(expected)) {
    throw new Error(`${name} must be ${expected}; received ${actual}.`);
  }
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_MAINNET && network.chainId !== SAIGON_TESTNET) {
    throw new Error(`Refusing to deploy Plinko V2 on unsupported chain ${network.chainId}.`);
  }

  const isMainnet = network.chainId === RONIN_MAINNET;
  const matt = addressFromEnv("MATT_CONTRACT", isMainnet ? MAINNET_MATT : undefined);
  const treasury = addressFromEnv("MATT_TREASURY", isMainnet ? MAINNET_TREASURY : deployer.address);
  const coordinator = addressFromEnv(
    "RONIN_VRF_COORDINATOR",
    isMainnet ? MAINNET_VRF_COORDINATOR : SAIGON_VRF_COORDINATOR
  );

  if (isMainnet) {
    if (process.env.CONFIRM_PLINKO_V2_MAINNET !== "YES") {
      throw new Error(
        "Mainnet V2 deployment is locked. Set CONFIRM_PLINKO_V2_MAINNET=YES after reviewing the preflight."
      );
    }
    requireMainnetAddress("MATT_CONTRACT", matt, MAINNET_MATT);
    requireMainnetAddress("MATT_TREASURY", treasury, MAINNET_TREASURY);
    requireMainnetAddress("RONIN_VRF_COORDINATOR", coordinator, MAINNET_VRF_COORDINATOR);
  }

  const mattCode = await hre.ethers.provider.getCode(matt);
  const coordinatorCode = await hre.ethers.provider.getCode(coordinator);
  if (mattCode === "0x") throw new Error(`No token contract exists at ${matt}.`);
  if (coordinatorCode === "0x") throw new Error(`No VRF coordinator exists at ${coordinator}.`);

  const factory = await hre.ethers.getContractFactory("MattPlinkoV2");
  const deployment = await factory.getDeployTransaction(matt, treasury, coordinator);
  const estimatedGas = await hre.ethers.provider.estimateGas({
    from: deployer.address,
    data: deployment.data
  });
  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

  console.log("Plinko V2 deployment preflight:", {
    network: isMainnet ? "Ronin mainnet" : "Saigon testnet",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    matt,
    treasury,
    coordinator,
    coinPriceMATT: "10000",
    batchSize: "1-100",
    maximumBatchPayoutMATT: "200000000",
    estimatedGas: estimatedGas.toString(),
    estimatedCostRON: gasPrice ? hre.ethers.formatEther(estimatedGas * gasPrice) : "unavailable",
    startsPaused: true
  });

  const contract = await factory.deploy(matt, treasury, coordinator);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();

  // Keep verification reads sequential because the public Ronin RPC can return
  // empty data when several post-deployment reads arrive together.
  const owner = await contract.owner();
  const paused = await contract.paused();
  const deployedMatt = await contract.matt();
  const deployedTreasury = await contract.treasury();
  const deployedCoordinator = await contract.vrfCoordinator();
  const coinPrice = await contract.COIN_PRICE();
  const maximumBatch = await contract.MAX_BATCH_SIZE();

  if (
    owner !== treasury
    || !paused
    || deployedMatt !== matt
    || deployedTreasury !== treasury
    || deployedCoordinator !== coordinator
    || coinPrice !== hre.ethers.parseEther("10000")
    || maximumBatch !== 100n
  ) {
    throw new Error("V2 post-deployment verification failed. Leave it paused and inspect it.");
  }

  console.log("MattPlinkoV2 deployed and verified paused:", {
    address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    owner,
    paused
  });
  console.log("Next: verify source, inspect, fund at least 199M MATT, connect the frontend, test, then unpause.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
