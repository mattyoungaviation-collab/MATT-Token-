const hre = require("hardhat");

const EXPECTED_TREASURY = "0xF79913cB83Cc9CABD95D0ba9250103fbb939f984";
const EXPECTED_SUPPLY = 10_000_000_000n * 10n ** 18n;

async function main() {
  const deployment = await hre.deployments.get("MattToken");
  const token = await hre.ethers.getContractAt("MattToken", deployment.address);

  const [name, symbol, decimals, totalSupply, treasuryBalance] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
    token.totalSupply(),
    token.balanceOf(EXPECTED_TREASURY),
  ]);

  console.log({
    network: hre.network.name,
    contract: deployment.address,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: hre.ethers.formatUnits(totalSupply, decimals),
    treasury: EXPECTED_TREASURY,
    treasuryBalance: hre.ethers.formatUnits(treasuryBalance, decimals),
  });

  if (name !== "Matt" || symbol !== "MATT" || decimals !== 18n) {
    throw new Error("Token identity check failed");
  }
  if (totalSupply !== EXPECTED_SUPPLY || treasuryBalance !== EXPECTED_SUPPLY) {
    throw new Error("Supply or treasury balance check failed");
  }

  console.log("Deployment inspection passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
