const hre = require("hardhat");

async function main() {
  const [ownerSigner] = await hre.ethers.getSigners();
  const poolAddress = requireAddress("FLAPPY_MATT_POT_ADDRESS");
  const newOperator = requireAddress("FLAPPY_MATT_OPERATOR");
  const pool = await hre.ethers.getContractAt("FlappyMattPrizePool", poolAddress, ownerSigner);

  const [owner, currentOperator] = await Promise.all([pool.owner(), pool.operator()]);
  console.log("Flappy MATT operator handoff:");
  console.log({
    pool: poolAddress,
    signer: ownerSigner.address,
    owner,
    currentOperator,
    newOperator
  });

  if (owner.toLowerCase() !== ownerSigner.address.toLowerCase()) {
    throw new Error("The configured deployer key is not the prize-pool owner.");
  }
  if (currentOperator.toLowerCase() === newOperator.toLowerCase()) {
    console.log("Operator already configured. No transaction required.");
    return;
  }

  const transaction = await pool.setOperator(newOperator);
  console.log("Operator update transaction:", transaction.hash);
  await transaction.wait(1);
  console.log("New operator:", await pool.operator());
}

function requireAddress(name) {
  const value = String(process.env[name] || "").trim();
  if (!hre.ethers.isAddress(value)) throw new Error(`${name} must be a valid Ronin address.`);
  return hre.ethers.getAddress(value);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
