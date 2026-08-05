"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const name = network.chainId === 2020n ? "ronin" : network.chainId === 202601n ? "saigon" : null;
  if (!name) throw new Error(`Unsupported chain ${network.chainId}.`);
  const deploymentPath = process.env.SLOTS_DEPLOYMENT_FILE
    || path.join(__dirname, `../deployment-exports/slots-${name}.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const vault = await hre.ethers.getContractAt("MattSlotsRewardVault", deployment.contracts.rewardVault);
  const pending = await vault.pendingTreasuryLoss();
  if (pending === 0n) {
    console.log("No settled Slots loss is waiting in the reward vault.");
    return;
  }
  const requested = process.env.SLOTS_FLUSH_MATT
    ? hre.ethers.parseEther(process.env.SLOTS_FLUSH_MATT)
    : pending;
  if (requested <= 0n || requested > pending) {
    throw new Error(`SLOTS_FLUSH_MATT must be positive and no greater than ${hre.ethers.formatEther(pending)} MATT.`);
  }
  const tx = await vault.flushTreasuryLoss(requested);
  console.log("Slots loss flush broadcast", { hash: tx.hash, amountMATT: hre.ethers.formatEther(requested) });
  await tx.wait(2);
  console.log("Slots loss moved into the protected treasury converter.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
