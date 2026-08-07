"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

function parseMatt(name, fallback) {
  const text = String(process.env[name] || fallback || "").trim();
  if (!/^d+(.d{1,18})?$/.test(text)) {
    throw new Error(name + " must be a positive MATT amount with at most 18 decimals.");
  }
  const value = hre.ethers.parseEther(text);
  if (value <= 0n) throw new Error(name + " must be positive.");
  return { text, value };
}

async function main() {
  if (process.env.CONFIRM_SLOTS_BET_LIMITS !== "YES") {
    throw new Error("Bet-limit update is locked. Set CONFIRM_SLOTS_BET_LIMITS=YES after reviewing bankroll capacity.");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 2020n) throw new Error("Expected Ronin mainnet.");

  const deploymentPath = process.env.SLOTS_V2_DEPLOYMENT_FILE
    || path.join(__dirname, "../deployment-exports/slots-v2-ronin.json");
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const [signer] = await hre.ethers.getSigners();
  const slots = await hre.ethers.getContractAt("MattSlotsV2", deployment.contracts.slots, signer);
  const owner = await slots.owner();

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Signer is not Slots owner. Expected " + owner + ".");
  }

  const minimum = parseMatt("SLOTS_MIN_BET_MATT", "500");
  const maximum = parseMatt("SLOTS_MAX_BET_MATT");
  if (maximum.value < minimum.value) throw new Error("Maximum bet must be at least the minimum bet.");

  console.log("Slots bet-limit update preflight", {
    slots: await slots.getAddress(),
    owner,
    minimumMATT: minimum.text,
    maximumMATT: maximum.text,
    playableBeforeMATT: hre.ethers.formatEther(await slots.currentPlayableMaxBet())
  });

  const tx = await slots.setBetLimits(minimum.value, maximum.value);
  console.log("Slots bet-limit update broadcast", { hash: tx.hash });
  await tx.wait(2);

  const configuredMinimum = await slots.minBet();
  const configuredMaximum = await slots.maxBet();
  if (configuredMinimum !== minimum.value || configuredMaximum !== maximum.value) {
    throw new Error("Bet-limit verification failed.");
  }

  console.log("Slots bet limits updated", {
    minimumMATT: hre.ethers.formatEther(configuredMinimum),
    maximumMATT: hre.ethers.formatEther(configuredMaximum),
    playableNowMATT: hre.ethers.formatEther(await slots.currentPlayableMaxBet())
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});