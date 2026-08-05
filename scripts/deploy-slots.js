const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const math = require("../config/slots.math.v1.json");

const RONIN = 2020n;
const SAIGON = 202601n;
const MAINNET = Object.freeze({
  matt: "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d",
  wrappedRon: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4",
  factory: "0x1f0B70d9A137e3cAEF0ceAcD312BC5f81Da0cC0c",
  pool: "0xa517E05e96728E80284F2aE157dDF309449D7cE8",
  treasury: "0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc",
  admin: "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984",
  coordinator: "0x16a62a921e7fec5bf867ff5c805b662db757b778"
});
const SAIGON_COORDINATOR = "0xa60c1e07fa030e4b49eb54950adb298ab94dd312";

function required(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required.`);
  return hre.ethers.getAddress(value);
}
function positiveBigInt(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw || !/^\d+$/.test(String(raw))) throw new Error(`${name} must be a positive integer.`);
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be greater than zero.`);
  return value;
}
function exact(name, actual, expected) {
  if (actual !== hre.ethers.getAddress(expected)) throw new Error(`${name} must be ${expected}; received ${actual}.`);
}
async function assertCode(name, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") throw new Error(`${name} has no runtime code at ${address}.`);
}
async function deploy(factoryName, args) {
  const factory = await hre.ethers.getContractFactory(factoryName);
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  console.log(`${factoryName} broadcast`, { hash: tx.hash, predicted: await contract.getAddress() });
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) throw new Error(`${factoryName} deployment failed: ${tx.hash}`);
  return { contract, receipt };
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN && network.chainId !== SAIGON) throw new Error(`Unsupported chain ${network.chainId}.`);
  const mainnet = network.chainId === RONIN;
  if (mainnet && process.env.CONFIRM_SLOTS_MAINNET !== "YES") {
    throw new Error("Mainnet deployment is locked. Set CONFIRM_SLOTS_MAINNET=YES after reviewing the preflight.");
  }

  const matt = required("MATT_CONTRACT", mainnet ? MAINNET.matt : undefined);
  const wrappedRon = required("WRON_CONTRACT", mainnet ? MAINNET.wrappedRon : undefined);
  const factory = required("KATANA_V3_FACTORY", mainnet ? MAINNET.factory : undefined);
  const pool = required("MATT_WRON_POOL", mainnet ? MAINNET.pool : undefined);
  const treasury = required("MATT_TREASURY_SAFE", mainnet ? MAINNET.treasury : deployer.address);
  const admin = required("MATT_SLOTS_ADMIN", mainnet ? MAINNET.admin : deployer.address);
  const coordinator = required("RONIN_VRF_COORDINATOR", mainnet ? MAINNET.coordinator : SAIGON_COORDINATOR);
  const router = required("SLOTS_SWAP_ROUTER");
  const keeper = required("SLOTS_CONVERSION_KEEPER", admin);
  const minLiquidity = positiveBigInt("SLOTS_MIN_HARMONIC_LIQUIDITY", mainnet ? undefined : "1");
  const maxSlippageBps = Number(process.env.SLOTS_MAX_SLIPPAGE_BPS || "500");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 1500) {
    throw new Error("SLOTS_MAX_SLIPPAGE_BPS must be between 0 and 1500.");
  }

  if (mainnet) {
    exact("MATT_CONTRACT", matt, MAINNET.matt); exact("WRON_CONTRACT", wrappedRon, MAINNET.wrappedRon);
    exact("KATANA_V3_FACTORY", factory, MAINNET.factory); exact("MATT_WRON_POOL", pool, MAINNET.pool);
    exact("MATT_TREASURY_SAFE", treasury, MAINNET.treasury); exact("MATT_SLOTS_ADMIN", admin, MAINNET.admin);
    exact("RONIN_VRF_COORDINATOR", coordinator, MAINNET.coordinator);
  }
  await Promise.all([
    assertCode("MATT", matt), assertCode("WRON", wrappedRon), assertCode("Katana factory", factory),
    assertCode("Katana pool", pool), assertCode("VRF coordinator", coordinator), assertCode("swap router", router)
  ]);
  const signerAddress = await deployer.getAddress();
  if (signerAddress.toLowerCase() !== admin.toLowerCase()) {
    throw new Error(`Refusing to deploy: signer ${signerAddress} is not configured Slots admin ${admin}.`);
  }

  console.log("MATT Slots deployment preflight", {
    network: mainnet ? "Ronin mainnet" : "Saigon testnet", chainId: network.chainId.toString(),
    deployer: deployer.address, matt, wrappedRon, factory, pool, treasury, admin, coordinator, router, keeper,
    minHarmonicLiquidity: minLiquidity.toString(), maxSlippageBps,
    initialMinBetMATT: "500", initialMaxBetMATT: "50000", quantity: "1-25",
    declaredRtpPercent: math.declaredRtpBps / 100, maximumConnectedWin: "500x",
    startsPaused: true
  });

  const converterDeployment = await deploy("MattSlotsTreasuryConverter", [
    matt, wrappedRon, factory, pool, treasury, router, keeper, maxSlippageBps, minLiquidity, admin
  ]);
  const converter = converterDeployment.contract;
  const vaultDeployment = await deploy("MattSlotsRewardVault", [matt, await converter.getAddress(), admin]);
  const vault = vaultDeployment.contract;
  const slotsDeployment = await deploy("MattSlotsV1", [
    matt, await vault.getAddress(), coordinator, admin,
    math.packedReels.map(BigInt), math.linePaysBps, math.scatterPaysBps, math.bonusAwards, math.declaredRtpBps
  ]);
  const slots = slotsDeployment.contract;

  await (await converter.configureSourceVault(await vault.getAddress())).wait(2);
  await (await vault.setController(await slots.getAddress())).wait(2);

  const checks = {
    slotsPaused: await slots.paused(), converterPaused: await converter.paused(),
    slotsOwner: await slots.owner(), vaultOwner: await vault.owner(), converterOwner: await converter.owner(),
    vaultController: await vault.controller(), converterSourceVault: await converter.sourceVault(),
    minBet: await slots.minBet(), maxBet: await slots.maxBet(), activeMathVersion: await slots.activeMathVersion()
  };
  if (!checks.slotsPaused || !checks.converterPaused || checks.vaultController !== await slots.getAddress()
      || checks.converterSourceVault !== await vault.getAddress() || checks.activeMathVersion !== 1n) {
    throw new Error("Post-deployment verification failed. Leave all contracts paused and inspect the printed transactions.");
  }

  const deploymentBlock = Math.min(
    converterDeployment.receipt.blockNumber,
    vaultDeployment.receipt.blockNumber,
    slotsDeployment.receipt.blockNumber
  );
  const output = {
    schemaVersion: 1, network: mainnet ? "ronin" : "saigon", chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(), deploymentBlock, deployer: signerAddress,
    contracts: { slots: await slots.getAddress(), rewardVault: await vault.getAddress(), converter: await converter.getAddress() },
    immutable: { matt, wrappedRon, factory, pool, treasury, coordinator },
    administration: { owner: admin, router, keeper, maxSlippageBps, minHarmonicLiquidity: minLiquidity.toString() },
    math: { version: 1, declaredRtpBps: math.declaredRtpBps, maxMultiplierBps: math.maximumMultiplierBps },
    paused: true
  };
  const outputDir = path.join(__dirname, "../deployment-exports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `slots-${output.network}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log("MATT Slots deployed, linked, verified, and left paused", { ...output.contracts, outputPath });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
