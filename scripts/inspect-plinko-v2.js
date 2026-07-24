const hre = require("hardhat");

async function main() {
  if (!process.env.PLINKO_V2_ADDRESS) throw new Error("PLINKO_V2_ADDRESS is required.");
  const address = hre.ethers.getAddress(process.env.PLINKO_V2_ADDRESS);
  const contract = await hre.ethers.getContractAt("MattPlinkoV2", address);
  const token = await hre.ethers.getContractAt("IERC20", await contract.matt());

  console.log({
    address,
    matt: await contract.matt(),
    treasury: await contract.treasury(),
    vrfCoordinator: await contract.vrfCoordinator(),
    paused: await contract.paused(),
    coinPriceMATT: hre.ethers.formatEther(await contract.COIN_PRICE()),
    maxBatchSize: String(await contract.MAX_BATCH_SIZE()),
    maximum100CoinPayoutMATT: hre.ethers.formatEther(await contract.maxPayout(100)),
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
