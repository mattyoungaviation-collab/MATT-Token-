const hre = require("hardhat");

const RONIN_MAINNET = 2020n;
const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const TREASURY_ADDRESS = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const VRF_COORDINATOR = "0x16A62a921e7fEC5Bf867fF5c805b662Db757B778";
const DEFAULT_BANKROLL = "250000000";
const MINIMUM_FULL_BATCH_BANKROLL = hre.ethers.parseEther("199000000");

async function main() {
  if (process.env.CONFIRM_PLINKO_V2_FUNDING !== "YES") {
    throw new Error(
      "V2 funding is locked. Set CONFIRM_PLINKO_V2_FUNDING=YES after reviewing the preflight."
    );
  }
  if (!process.env.PLINKO_V2_ADDRESS) {
    throw new Error("PLINKO_V2_ADDRESS is required. Never use the V1 address.");
  }

  const address = hre.ethers.getAddress(process.env.PLINKO_V2_ADDRESS);
  const [treasurySigner] = await hre.ethers.getSigners();
  if (!treasurySigner) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_MAINNET) {
    throw new Error(`Refusing to fund V2 on chain ${network.chainId}; expected Ronin 2020.`);
  }
  if (hre.ethers.getAddress(treasurySigner.address) !== hre.ethers.getAddress(TREASURY_ADDRESS)) {
    throw new Error(`Funding must be signed by treasury ${TREASURY_ADDRESS}.`);
  }
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`No contract exists at ${address}.`);
  }

  const amountText = process.env.PLINKO_V2_BANKROLL_MATT || DEFAULT_BANKROLL;
  if (!/^\d+$/.test(amountText) || BigInt(amountText) === 0n) {
    throw new Error("PLINKO_V2_BANKROLL_MATT must be a positive whole-number MATT amount.");
  }
  const amount = hre.ethers.parseEther(amountText);
  const plinko = await hre.ethers.getContractAt("MattPlinkoV2", address, treasurySigner);
  const token = await hre.ethers.getContractAt("IERC20", MATT_ADDRESS, treasurySigner);

  const owner = await plinko.owner();
  const configuredMatt = await plinko.matt();
  const configuredTreasury = await plinko.treasury();
  const configuredCoordinator = await plinko.vrfCoordinator();
  const paused = await plinko.paused();
  const bankrollBefore = await plinko.unreservedBankroll();
  const treasuryBalance = await token.balanceOf(TREASURY_ADDRESS);

  if (owner !== hre.ethers.getAddress(TREASURY_ADDRESS)) throw new Error(`Unexpected owner ${owner}.`);
  if (configuredMatt !== hre.ethers.getAddress(MATT_ADDRESS)) throw new Error(`Unexpected MATT ${configuredMatt}.`);
  if (configuredTreasury !== hre.ethers.getAddress(TREASURY_ADDRESS)) throw new Error(`Unexpected treasury ${configuredTreasury}.`);
  if (configuredCoordinator !== hre.ethers.getAddress(VRF_COORDINATOR)) throw new Error(`Unexpected coordinator ${configuredCoordinator}.`);
  if (!paused) throw new Error("Refusing guarded V2 funding because the contract is not paused.");
  if (treasuryBalance < amount) throw new Error(`Treasury does not have ${amountText} MATT.`);

  console.log("Plinko V2 funding preflight:", {
    address,
    chainId: network.chainId.toString(),
    amountMATT: amountText,
    bankrollBeforeMATT: hre.ethers.formatEther(bankrollBefore),
    minimumForFull100CoinBatchMATT: "199000000",
    paused
  });

  const allowance = await token.allowance(TREASURY_ADDRESS, address);
  if (allowance < amount) {
    const approval = await token.approve(address, amount);
    console.log("MATT approval submitted:", approval.hash);
    await approval.wait(1);
  }

  const funding = await plinko.fundBankroll(amount);
  console.log("V2 funding submitted:", funding.hash);
  await funding.wait(1);

  const bankrollAfter = await plinko.unreservedBankroll();
  const solvent = await plinko.isSolvent();
  if (!solvent || bankrollAfter < bankrollBefore + amount) {
    throw new Error("Funding confirmed, but V2 verification failed. Keep it paused.");
  }

  console.log("Plinko V2 funded and still paused:", {
    transactionHash: funding.hash,
    bankrollAfterMATT: hre.ethers.formatEther(bankrollAfter),
    supportsFull100CoinBatch: bankrollAfter >= MINIMUM_FULL_BATCH_BANKROLL,
    solvent,
    paused: await plinko.paused()
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
