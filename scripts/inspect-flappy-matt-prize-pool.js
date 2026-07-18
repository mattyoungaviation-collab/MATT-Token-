const hre = require("hardhat");

async function main() {
  const poolAddress = requireAddress("FLAPPY_MATT_POT_ADDRESS");
  const pool = await hre.ethers.getContractAt("FlappyMattPrizePool", poolAddress);
  const provider = hre.ethers.provider;
  const code = await provider.getCode(poolAddress);
  const [network, matt, treasury, operator, owner, entryFee, treasuryFee, prizePerEntry, currentRoundId] = await Promise.all([
    provider.getNetwork(), pool.matt(), pool.treasury(), pool.operator(), pool.owner(),
    pool.ENTRY_FEE(), pool.TREASURY_FEE_PER_ENTRY(), pool.PRIZE_PER_ENTRY(), pool.currentRoundId()
  ]);
  const expectedMatt = hre.ethers.getAddress(process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d");
  const expectedTreasury = hre.ethers.getAddress(process.env.MATT_TREASURY || "0xf79913cb83cc9cabd95d0ba9250103fbb939f984");
  const valid = code !== "0x" && Number(network.chainId) === 2020 &&
    matt.toLowerCase() === expectedMatt.toLowerCase() && treasury.toLowerCase() === expectedTreasury.toLowerCase() &&
    entryFee === hre.ethers.parseEther("50000") && treasuryFee === hre.ethers.parseEther("1000") &&
    prizePerEntry === hre.ethers.parseEther("49000");
  console.log("Flappy MATT prize-pool inspection:");
  console.log({
    valid, chainId: Number(network.chainId), pool: poolAddress,
    bytecodeBytes: Math.max(0, (code.length - 2) / 2), matt, treasury, operator, owner,
    entryFeeMatt: hre.ethers.formatEther(entryFee), treasuryFeeMatt: hre.ethers.formatEther(treasuryFee),
    prizePerEntryMatt: hre.ethers.formatEther(prizePerEntry), currentRoundId: currentRoundId.toString(),
    currentRoundEntries: (await pool.roundEntries(currentRoundId)).toString(),
    currentRoundPrizeMatt: hre.ethers.formatEther(await pool.availablePrize(currentRoundId))
  });
  if (!valid) throw new Error("The deployed contract does not match the official Flappy MATT configuration.");
}

function requireAddress(name) {
  const value = String(process.env[name] || "").trim();
  if (!hre.ethers.isAddress(value)) throw new Error(`${name} must be a valid Ronin address.`);
  return hre.ethers.getAddress(value);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
