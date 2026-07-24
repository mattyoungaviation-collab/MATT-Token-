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
    throw new Error(
      `${name} must be ${expected} for the production Plinko deployment; received ${actual}.`
    );
  }
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_MAINNET && network.chainId !== SAIGON_TESTNET) {
    throw new Error(`Refusing to deploy Plinko on unsupported chain ${network.chainId}.`);
  }

  const isMainnet = network.chainId === RONIN_MAINNET;
  const matt = addressFromEnv(
    "MATT_CONTRACT",
    isMainnet ? MAINNET_MATT : undefined
  );
  const treasury = addressFromEnv(
    "MATT_TREASURY",
    isMainnet ? MAINNET_TREASURY : deployer.address
  );
  const coordinator = addressFromEnv(
    "RONIN_VRF_COORDINATOR",
    isMainnet ? MAINNET_VRF_COORDINATOR : SAIGON_VRF_COORDINATOR
  );

  if (isMainnet) {
    if (process.env.CONFIRM_RONIN_MAINNET !== "YES") {
      throw new Error(
        "Mainnet deployment is locked. Set CONFIRM_RONIN_MAINNET=YES after checking the addresses."
      );
    }
    requireMainnetAddress("MATT_CONTRACT", matt, MAINNET_MATT);
    requireMainnetAddress("MATT_TREASURY", treasury, MAINNET_TREASURY);
    requireMainnetAddress("RONIN_VRF_COORDINATOR", coordinator, MAINNET_VRF_COORDINATOR);
  }

  const [mattCode, coordinatorCode, deployerBalance] = await Promise.all([
    hre.ethers.provider.getCode(matt),
    hre.ethers.provider.getCode(coordinator),
    hre.ethers.provider.getBalance(deployer.address)
  ]);
  if (mattCode === "0x") throw new Error(`No token contract exists at ${matt}.`);
  if (coordinatorCode === "0x") throw new Error(`No VRF coordinator exists at ${coordinator}.`);

  const token = new hre.ethers.Contract(
    matt,
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ],
    hre.ethers.provider
  );
  const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals()
  ]);
  if (isMainnet && (tokenName !== "Matt" || tokenSymbol !== "MATT" || tokenDecimals !== 18n)) {
    throw new Error(
      `Unexpected mainnet token identity: ${tokenName} / ${tokenSymbol} / ${tokenDecimals} decimals.`
    );
  }

  const factory = await hre.ethers.getContractFactory("MattPlinko");
  const deploymentTransaction = await factory.getDeployTransaction(matt, treasury, coordinator);
  const estimatedGas = await hre.ethers.provider.estimateGas({
    from: deployer.address,
    data: deploymentTransaction.data
  });
  const feeData = await hre.ethers.provider.getFeeData();
  const estimatedGasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  const estimatedCost = estimatedGasPrice ? estimatedGas * estimatedGasPrice : null;

  console.log("Plinko deployment preflight:", {
    network: isMainnet ? "Ronin mainnet" : "Saigon testnet",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    deployerBalanceRON: hre.ethers.formatEther(deployerBalance),
    matt,
    treasury,
    coordinator,
    token: `${tokenName} (${tokenSymbol})`,
    estimatedGas: estimatedGas.toString(),
    estimatedCostRON: estimatedCost ? hre.ethers.formatEther(estimatedCost) : "unavailable",
    startsPaused: true
  });

  const contract = await factory.deploy(matt, treasury, coordinator);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const deploymentReceipt = await contract.deploymentTransaction().wait();
  // Ronin public RPC occasionally returns an empty result for concurrent reads
  // immediately after deployment. Verify sequentially so a healthy deployment
  // is not reported as failed after its transaction has already confirmed.
  const owner = await contract.owner();
  const paused = await contract.paused();
  const deployedMatt = await contract.matt();
  const deployedTreasury = await contract.treasury();
  const deployedCoordinator = await contract.vrfCoordinator();
  if (
    owner !== treasury
    || !paused
    || deployedMatt !== matt
    || deployedTreasury !== treasury
    || deployedCoordinator !== coordinator
  ) {
    throw new Error("Post-deployment verification failed. Leave the contract paused and inspect it.");
  }

  console.log("MattPlinko deployed and verified paused:", {
    address,
    transactionHash: deploymentReceipt.hash,
    blockNumber: deploymentReceipt.blockNumber,
    owner,
    paused
  });
  console.log("Next: verify, fund bankroll, set PLINKO_ADDRESS in plinko.js, then unpause from treasury.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
