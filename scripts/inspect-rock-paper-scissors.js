const hre = require("hardhat");

async function main() {
  const address = hre.ethers.getAddress(String(process.env.MATT_RPS_ADDRESS || ""));
  const rps = await hre.ethers.getContractAt("MattRockPaperScissors", address);
  const [network, code, matt, treasury, owner, wager, pot, nextGameId, paused] = await Promise.all([
    hre.ethers.provider.getNetwork(), hre.ethers.provider.getCode(address), rps.matt(), rps.treasury(),
    rps.owner(), rps.WAGER(), rps.TOTAL_POT(), rps.nextGameId(), rps.paused()
  ]);
  const expectedMatt = hre.ethers.getAddress(process.env.MATT_CONTRACT || "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d");
  const valid = Number(network.chainId) === 2020 && code !== "0x" && matt === expectedMatt &&
    wager === hre.ethers.parseEther("25000") && pot === hre.ethers.parseEther("50000");
  console.log({ valid, chainId: Number(network.chainId), address, matt, treasury, owner, paused,
    wagerMatt: hre.ethers.formatEther(wager), potMatt: hre.ethers.formatEther(pot), nextGameId: nextGameId.toString() });
  if (!valid) throw new Error("RPS deployment does not match the expected Ronin/MATT configuration.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
