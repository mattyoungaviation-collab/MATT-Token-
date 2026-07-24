const hre = require("hardhat");

async function main() {
  const address = hre.ethers.getAddress(process.env.PLINKO_ADDRESS);
  const contract = await hre.ethers.getContractAt("MattPlinko", address);
  const token = await hre.ethers.getContractAt("IERC20", await contract.matt());

  console.log({
    address,
    matt: await contract.matt(),
    treasury: await contract.treasury(),
    vrfCoordinator: await contract.vrfCoordinator(),
    paused: await contract.paused(),
    tokenBalance: hre.ethers.formatEther(await token.balanceOf(address)),
    protectedBalance: hre.ethers.formatEther(await contract.protectedBalance()),
    reservedLiability: hre.ethers.formatEther(await contract.reservedLiability()),
    unreservedBankroll: hre.ethers.formatEther(await contract.unreservedBankroll()),
    solvent: await contract.isSolvent(),
    totalDrops: String(await contract.totalDrops()),
    totalSettled: String(await contract.totalSettled())
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
