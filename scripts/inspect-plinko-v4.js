const hre = require("hardhat");

async function main() {
  if (!process.env.PLINKO_V4_ADDRESS) throw new Error("PLINKO_V4_ADDRESS is required.");
  const address = hre.ethers.getAddress(process.env.PLINKO_V4_ADDRESS);
  const contract = await hre.ethers.getContractAt("MattPlinkoV4", address);
  const token = await hre.ethers.getContractAt("IERC20", await contract.matt());

  console.log({
    address,
    matt: await contract.matt(),
    treasury: await contract.treasury(),
    vrfCoordinator: await contract.vrfCoordinator(),
    paused: await contract.paused(),
    coinPriceMATT: hre.ethers.formatEther(await contract.COIN_PRICE()),
    maxBatchSize: String(await contract.MAX_BATCH_SIZE()),
    theoreticalRtpPercent: "98.2",
    rtpNumerator: String(await contract.RTP_NUMERATOR()),
    rtpDenominator: String(await contract.RTP_DENOMINATOR()),
    multiplierSlot2: String(await contract.multiplierForSlot(2)),
    multiplierSlot8: String(await contract.multiplierForSlot(8)),
    maximum100CoinPayoutMATT: hre.ethers.formatEther(await contract.maxPayout(100)),
    maximum100CoinAdditionalLiabilityMATT:
      hre.ethers.formatEther(await contract.maxAdditionalLiability(100)),
    tokenBalanceMATT: hre.ethers.formatEther(await token.balanceOf(address)),
    protectedBalanceMATT: hre.ethers.formatEther(await contract.protectedBalance()),
    reservedLiabilityMATT: hre.ethers.formatEther(await contract.reservedLiability()),
    unreservedBankrollMATT: hre.ethers.formatEther(await contract.unreservedBankroll()),
    solvent: await contract.isSolvent(),
    totalBatches: String(await contract.totalBatches()),
    totalSettledBatches: String(await contract.totalSettledBatches()),
    totalCoinsPurchased: String(await contract.totalCoinsPurchased()),
    totalCoinsSettled: String(await contract.totalCoinsSettled())
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
