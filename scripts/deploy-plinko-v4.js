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

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForRuntimeCode(address, transactionHash) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    const code = await hre.ethers.provider.getCode(address);
    if (code !== "0x") return code;

    if (attempt < 15) {
      console.warn(
        `Deployment receipt exists but RPC bytecode is not available yet `
        + `(attempt ${attempt}/15). Transaction: ${transactionHash}`
      );
      await delay(2_000);
    }
  }

  throw new Error(
    `No runtime bytecode is visible at ${address} after confirmation. `
    + `Do not redeploy until transaction ${transactionHash} is inspected.`
  );
}

async function readVerifiedConfiguration(contract, transactionHash) {
  let lastError;

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return {
        owner: await contract.owner(),
        paused: await contract.paused(),
        deployedMatt: await contract.matt(),
        deployedTreasury: await contract.treasury(),
        deployedCoordinator: await contract.vrfCoordinator(),
        coinPrice: await contract.COIN_PRICE(),
        maximumBatch: await contract.MAX_BATCH_SIZE(),
        maximumPayout: await contract.maxPayout(100),
        rtpNumerator: await contract.RTP_NUMERATOR(),
        rtpDenominator: await contract.RTP_DENOMINATOR(),
        highSlotMultiplier: await contract.multiplierForSlot(2),
        centerSlotMultiplier: await contract.multiplierForSlot(8)
      };
    } catch (error) {
      lastError = error;
      if (attempt < 10) {
        console.warn(
          `RPC post-deployment read is not ready (attempt ${attempt}/10). `
          + `Transaction: ${transactionHash}`
        );
        await delay(2_000);
      }
    }
  }

  throw new Error(
    `Post-deployment reads failed for transaction ${transactionHash}. `
    + `Do not redeploy; inspect the printed address and transaction hash.`,
    { cause: lastError }
  );
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_MAINNET && network.chainId !== SAIGON_TESTNET) {
    throw new Error(`Refusing to deploy Plinko V4 on unsupported chain ${network.chainId}.`);
  }

  const isMainnet = network.chainId === RONIN_MAINNET;
  const matt = addressFromEnv("MATT_CONTRACT", isMainnet ? MAINNET_MATT : undefined);
  const treasury = addressFromEnv("MATT_TREASURY", isMainnet ? MAINNET_TREASURY : deployer.address);
  const coordinator = addressFromEnv(
    "RONIN_VRF_COORDINATOR",
    isMainnet ? MAINNET_VRF_COORDINATOR : SAIGON_VRF_COORDINATOR
  );

  if (isMainnet) {
    if (process.env.CONFIRM_PLINKO_V4_MAINNET !== "YES") {
      throw new Error(
        "Mainnet V4 deployment is locked. Set CONFIRM_PLINKO_V4_MAINNET=YES after reviewing the preflight."
      );
    }
    requireMainnetAddress("MATT_CONTRACT", matt, MAINNET_MATT);
    requireMainnetAddress("MATT_TREASURY", treasury, MAINNET_TREASURY);
    requireMainnetAddress("RONIN_VRF_COORDINATOR", coordinator, MAINNET_VRF_COORDINATOR);
  }

  if (await hre.ethers.provider.getCode(matt) === "0x") {
    throw new Error(`No token contract exists at ${matt}.`);
  }
  if (await hre.ethers.provider.getCode(coordinator) === "0x") {
    throw new Error(`No VRF coordinator exists at ${coordinator}.`);
  }

  const factory = await hre.ethers.getContractFactory("MattPlinkoV4");
  const deployment = await factory.getDeployTransaction(matt, treasury, coordinator);
  const estimatedGas = await hre.ethers.provider.estimateGas({
    from: deployer.address,
    data: deployment.data
  });
  const feeData = await hre.ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  const deploymentNonce = await hre.ethers.provider.getTransactionCount(
    deployer.address,
    "pending"
  );
  const predictedAddress = hre.ethers.getCreateAddress({
    from: deployer.address,
    nonce: deploymentNonce
  });

  console.log("Plinko V4 deployment preflight:", {
    network: isMainnet ? "Ronin mainnet" : "Saigon testnet",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    deploymentNonce,
    predictedAddress,
    matt,
    treasury,
    coordinator,
    coinPriceMATT: "10000",
    batchSize: "1-100",
    maximumBatchPayoutMATT: "50000000",
    theoreticalRtpPercent: "98.2",
    estimatedGas: estimatedGas.toString(),
    estimatedCostRON: gasPrice ? hre.ethers.formatEther(estimatedGas * gasPrice) : "unavailable",
    startsPaused: true
  });

  const contract = await factory.deploy(matt, treasury, coordinator);
  const deploymentTransaction = contract.deploymentTransaction();
  if (!deploymentTransaction) {
    throw new Error("The deployment transaction was not created.");
  }

  console.log("Plinko V4 deployment broadcast:", {
    transactionHash: deploymentTransaction.hash,
    nonce: deploymentTransaction.nonce,
    predictedAddress
  });

  const receipt = await deploymentTransaction.wait(2);
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `V4 deployment did not succeed. Transaction: ${deploymentTransaction.hash}. `
      + "Do not redeploy until the receipt is inspected."
    );
  }

  const address = receipt.contractAddress || predictedAddress;
  console.log("Plinko V4 deployment confirmed:", {
    address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status
  });

  if (hre.ethers.getAddress(address) !== hre.ethers.getAddress(predictedAddress)) {
    throw new Error(
      `Receipt contract address ${address} does not match predicted address ${predictedAddress}. `
      + `Do not fund or redeploy. Transaction: ${receipt.hash}`
    );
  }

  await waitForRuntimeCode(address, receipt.hash);
  const deployedContract = factory.attach(address);
  const {
    owner,
    paused,
    deployedMatt,
    deployedTreasury,
    deployedCoordinator,
    coinPrice,
    maximumBatch,
    maximumPayout,
    rtpNumerator,
    rtpDenominator,
    highSlotMultiplier,
    centerSlotMultiplier
  } = await readVerifiedConfiguration(deployedContract, receipt.hash);

  if (
    owner !== treasury
    || !paused
    || deployedMatt !== matt
    || deployedTreasury !== treasury
    || deployedCoordinator !== coordinator
    || coinPrice !== hre.ethers.parseEther("10000")
    || maximumBatch !== 100n
    || maximumPayout !== hre.ethers.parseEther("50000000")
    || rtpNumerator !== 643_563_520n
    || rtpDenominator !== 655_360_000n
    || highSlotMultiplier !== 100_174n
    || centerSlotMultiplier !== 4_848n
  ) {
    throw new Error(
      `V4 post-deployment verification failed. Leave it paused and inspect transaction ${receipt.hash}.`
    );
  }

  console.log("MattPlinkoV4 deployed and verified paused:", {
    address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    owner,
    paused
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
