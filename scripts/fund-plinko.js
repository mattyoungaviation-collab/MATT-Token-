const hre = require("hardhat");

const RONIN_MAINNET = 2020n;
const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
const TREASURY_ADDRESS = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const PLINKO_ADDRESS = "0xFAefDD57E2C04EdEc6e33fA006702DaB5E194Cb2";
const VRF_COORDINATOR = "0x16A62a921e7fEC5Bf867fF5c805b662Db757B778";
const DEFAULT_BANKROLL = "100000000";

async function main() {
  if (process.env.CONFIRM_PLINKO_FUNDING !== "YES") {
    throw new Error("Funding is locked. Set CONFIRM_PLINKO_FUNDING=YES after checking the preflight.");
  }

  const [treasurySigner] = await hre.ethers.getSigners();
  if (!treasurySigner) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== RONIN_MAINNET) {
    throw new Error(`Refusing to fund Plinko on chain ${network.chainId}; expected Ronin mainnet 2020.`);
  }

  const treasury = hre.ethers.getAddress(TREASURY_ADDRESS);
  if (hre.ethers.getAddress(treasurySigner.address) !== treasury) {
    throw new Error(`Funding must be signed by treasury ${treasury}; received ${treasurySigner.address}.`);
  }

  const amountText = process.env.PLINKO_BANKROLL_MATT || DEFAULT_BANKROLL;
  if (!/^\d+$/.test(amountText) || BigInt(amountText) === 0n) {
    throw new Error("PLINKO_BANKROLL_MATT must be a positive whole-number MATT amount.");
  }
  const amount = hre.ethers.parseEther(amountText);

  const code = await hre.ethers.provider.getCode(PLINKO_ADDRESS);
  if (code === "0x") throw new Error(`No contract exists at ${PLINKO_ADDRESS}.`);

  const plinko = await hre.ethers.getContractAt("MattPlinko", PLINKO_ADDRESS, treasurySigner);
  const token = await hre.ethers.getContractAt("IERC20", MATT_ADDRESS, treasurySigner);

  // Keep these reads sequential because Ronin public RPC can return empty
  // responses when several post-transaction calls arrive together.
  const owner = await plinko.owner();
  const configuredMatt = await plinko.matt();
  const configuredTreasury = await plinko.treasury();
  const configuredCoordinator = await plinko.vrfCoordinator();
  const paused = await plinko.paused();
  const bankrollBefore = await plinko.unreservedBankroll();
  const treasuryBalance = await token.balanceOf(treasury);

  if (owner !== treasury) throw new Error(`Unexpected owner ${owner}.`);
  if (configuredMatt !== hre.ethers.getAddress(MATT_ADDRESS)) {
    throw new Error(`Unexpected MATT contract ${configuredMatt}.`);
  }
  if (configuredTreasury !== treasury) throw new Error(`Unexpected treasury ${configuredTreasury}.`);
  if (configuredCoordinator !== hre.ethers.getAddress(VRF_COORDINATOR)) {
    throw new Error(`Unexpected VRF coordinator ${configuredCoordinator}.`);
  }
  if (!paused) throw new Error("Refusing to fund through this launch script because Plinko is not paused.");
  if (treasuryBalance < amount) {
    throw new Error(
      `Treasury has ${hre.ethers.formatEther(treasuryBalance)} MATT; ${amountText} MATT is required.`
    );
  }

  console.log("Plinko funding preflight:", {
    chainId: network.chainId.toString(),
    treasury,
    plinko: PLINKO_ADDRESS,
    paused,
    amountMATT: amountText,
    bankrollBeforeMATT: hre.ethers.formatEther(bankrollBefore),
    treasuryBalanceMATT: hre.ethers.formatEther(treasuryBalance)
  });

  const allowance = await token.allowance(treasury, PLINKO_ADDRESS);
  if (allowance < amount) {
    const approval = await token.approve(PLINKO_ADDRESS, amount);
    console.log("MATT approval submitted:", approval.hash);
    await approval.wait(1);
  }

  const funding = await plinko.fundBankroll(amount);
  console.log("Plinko funding submitted:", funding.hash);
  await funding.wait(1);

  const bankrollAfter = await plinko.unreservedBankroll();
  const solvent = await plinko.isSolvent();
  if (!solvent || bankrollAfter < bankrollBefore + amount) {
    throw new Error("Funding confirmed but post-funding verification failed. Keep Plinko paused and inspect it.");
  }

  console.log("Plinko funded and still paused:", {
    transactionHash: funding.hash,
    bankrollAfterMATT: hre.ethers.formatEther(bankrollAfter),
    solvent,
    paused: await plinko.paused()
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
