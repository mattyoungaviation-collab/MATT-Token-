const hre = require("hardhat");

const RONIN_MAINNET = 2020n;
const MATT_TOKEN = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const OWNER = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const RONIN_VRF_COORDINATOR = "0x16a62a921e7fec5bf867ff5c805b662db757b778";

function requireAddress(name, actual, expected) {
  const normalized = hre.ethers.getAddress(actual);
  const required = hre.ethers.getAddress(expected);
  if (normalized !== required) {
    throw new Error(`${name} must be ${required}; received ${normalized}.`);
  }
  return normalized;
}

async function waitForCode(address, transactionHash) {
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const code = await hre.ethers.provider.getCode(address);
    if (code !== "0x") return code;
    if (attempt < 15) await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `No runtime bytecode is visible at ${address}. Do not redeploy until ${transactionHash} is inspected.`
  );
}

async function confirmedDeployment(contract, label, predictedAddress) {
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`${label} deployment transaction was not created.`);

  console.log(`${label} deployment broadcast:`, {
    transactionHash: transaction.hash,
    nonce: transaction.nonce,
    predictedAddress
  });

  const receipt = await transaction.wait(2);
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `${label} deployment failed. Do not redeploy until ${transaction.hash} is inspected.`
    );
  }

  const address = receipt.contractAddress || predictedAddress;
  await waitForCode(address, transaction.hash);
  console.log(`${label} deployment confirmed:`, {
    address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString()
  });
  return { address, receipt, transaction };
}

async function main() {
  if (process.env.CONFIRM_GIFT_BOX_MAINNET !== "YES") {
    throw new Error(
      "Mainnet deployment is locked. Set CONFIRM_GIFT_BOX_MAINNET=YES after reviewing the preflight."
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_MAINNET) {
    throw new Error(`Refusing to deploy gift boxes on unsupported chain ${network.chainId}.`);
  }

  const owner = requireAddress("OWNER", OWNER, OWNER);
  const matt = requireAddress(
    "MATT_CONTRACT",
    process.env.MATT_CONTRACT || MATT_TOKEN,
    MATT_TOKEN
  );
  const coordinator = requireAddress(
    "RONIN_VRF_COORDINATOR",
    process.env.RONIN_VRF_COORDINATOR || RONIN_VRF_COORDINATOR,
    RONIN_VRF_COORDINATOR
  );
  requireAddress("DEPLOYER_PRIVATE_KEY account", deployer.address, owner);

  if (await hre.ethers.provider.getCode(matt) === "0x") {
    throw new Error(`No MATT token contract exists at ${matt}.`);
  }
  if (await hre.ethers.provider.getCode(coordinator) === "0x") {
    throw new Error(`No Ronin VRF coordinator exists at ${coordinator}.`);
  }

  const Vault = await hre.ethers.getContractFactory("MattGiftBoxVault");
  const GiftBoxes = await hre.ethers.getContractFactory("MattGiftBoxes");
  const nonce = await hre.ethers.provider.getTransactionCount(deployer.address, "pending");
  const predictedVault = hre.ethers.getCreateAddress({ from: deployer.address, nonce });
  const predictedGiftBoxes = hre.ethers.getCreateAddress({
    from: deployer.address,
    nonce: nonce + 1
  });

  const vaultDeployment = await Vault.getDeployTransaction(matt, owner);
  const giftBoxesDeployment = await GiftBoxes.getDeployTransaction(
    predictedVault,
    coordinator,
    owner
  );
  const [vaultGas, giftBoxesGas, feeData, balance] = await Promise.all([
    hre.ethers.provider.estimateGas({ from: deployer.address, data: vaultDeployment.data }),
    hre.ethers.provider.estimateGas({ from: deployer.address, data: giftBoxesDeployment.data }),
    hre.ethers.provider.getFeeData(),
    hre.ethers.provider.getBalance(deployer.address)
  ]);
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
  const estimatedGas = vaultGas + giftBoxesGas + 150_000n;
  const estimatedCost = gasPrice ? estimatedGas * gasPrice : 0n;

  console.log("MATT Gift Boxes mainnet preflight:", {
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    owner,
    matt,
    coordinator,
    deploymentNonce: nonce,
    predictedVault,
    predictedGiftBoxes,
    vaultRuntimeBytes: (Vault.bytecode.length - 2) / 2,
    giftBoxesRuntimeBytes: (GiftBoxes.bytecode.length - 2) / 2,
    estimatedGas: estimatedGas.toString(),
    gasPriceGwei: gasPrice ? hre.ethers.formatUnits(gasPrice, "gwei") : "unavailable",
    estimatedCostRON: gasPrice ? hre.ethers.formatEther(estimatedCost) : "unavailable",
    deployerBalanceRON: hre.ethers.formatEther(balance),
    startsPaused: true,
    livePurchasesAfterDeployment: false
  });

  if (gasPrice && balance < estimatedCost) {
    throw new Error(
      `Owner wallet has insufficient RON. Estimated ${hre.ethers.formatEther(estimatedCost)} RON, `
      + `available ${hre.ethers.formatEther(balance)} RON.`
    );
  }

  const vaultContract = await Vault.deploy(matt, owner);
  const vaultResult = await confirmedDeployment(
    vaultContract,
    "MATT Gift Box Vault",
    predictedVault
  );

  const giftBoxesContract = await GiftBoxes.deploy(
    vaultResult.address,
    coordinator,
    owner
  );
  const giftBoxesResult = await confirmedDeployment(
    giftBoxesContract,
    "MATT Gift Boxes",
    predictedGiftBoxes
  );

  const controllerTransaction = await vaultContract.setController(giftBoxesResult.address);
  console.log("Vault controller transaction broadcast:", {
    transactionHash: controllerTransaction.hash,
    controller: giftBoxesResult.address
  });
  const controllerReceipt = await controllerTransaction.wait(2);
  if (!controllerReceipt || controllerReceipt.status !== 1) {
    throw new Error(
      `Vault controller setup failed. Do not redeploy. Inspect ${controllerTransaction.hash}.`
    );
  }

  const [
    vaultOwner,
    controller,
    giftBoxesOwner,
    paused,
    deployedVault,
    deployedCoordinator,
    activeConfigVersion,
    initialConfig
  ] = await Promise.all([
    vaultContract.owner(),
    vaultContract.controller(),
    giftBoxesContract.owner(),
    giftBoxesContract.paused(),
    giftBoxesContract.vault(),
    giftBoxesContract.vrfCoordinator(),
    giftBoxesContract.activeConfigVersion(),
    giftBoxesContract.getConfiguration(1)
  ]);

  if (
    vaultOwner !== owner
      || controller !== giftBoxesResult.address
      || giftBoxesOwner !== owner
      || paused !== true
      || deployedVault !== vaultResult.address
      || deployedCoordinator !== coordinator
      || activeConfigVersion !== 1n
      || initialConfig.prices[0] !== hre.ethers.parseEther("100")
      || initialConfig.prices[1] !== hre.ethers.parseEther("250")
      || initialConfig.prices[2] !== hre.ethers.parseEther("500")
  ) {
    throw new Error("Post-deployment verification failed. Do not fund or unpause.");
  }

  console.log("MATT Gift Boxes mainnet deployment verified:", {
    vault: vaultResult.address,
    giftBoxes: giftBoxesResult.address,
    owner,
    controller,
    paused,
    activeConfigVersion: activeConfigVersion.toString(),
    vaultDeploymentTransaction: vaultResult.transaction.hash,
    giftBoxesDeploymentTransaction: giftBoxesResult.transaction.hash,
    controllerTransaction: controllerTransaction.hash,
    nextActions: [
      "Verify both contracts on Ronin Explorer.",
      "Fund the MATT vault.",
      "Fund the RON randomness reserve.",
      "Configure the signed quote service.",
      "Run a controlled live test before unpausing."
    ]
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
