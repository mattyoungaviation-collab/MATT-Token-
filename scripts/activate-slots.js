const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  if (process.env.CONFIRM_ACTIVATE_SLOTS !== "YES") throw new Error("Activation locked. Set CONFIRM_ACTIVATE_SLOTS=YES only after tests, source verification, math approval, and funding.");
  const [signer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const name = network.chainId === 2020n ? "ronin" : "saigon";
  const deployment = JSON.parse(fs.readFileSync(process.env.SLOTS_DEPLOYMENT_FILE || path.join(__dirname, `../deployment-exports/slots-${name}.json`), "utf8"));
  const slots = await hre.ethers.getContractAt("MattSlotsV1", deployment.contracts.slots, signer);
  const vault = await hre.ethers.getContractAt("MattSlotsRewardVault", deployment.contracts.rewardVault, signer);
  const converter = await hre.ethers.getContractAt("MattSlotsTreasuryConverter", deployment.contracts.converter, signer);
  const minimum = await slots.minBet();
  const playable = await slots.currentPlayableMaxBet();
  if (playable < minimum || !(await vault.isSolvent())) throw new Error("Reward vault is not funded enough for even the minimum spin.");
  const [, liquidity] = await converter.quoteTwap(hre.ethers.parseEther("1000"));
  if (liquidity < await converter.minHarmonicLiquidity()) throw new Error("MATT/WRON TWAP liquidity is below the converter minimum.");
  if (await converter.paused()) await (await converter.unpause()).wait(2);
  if (await slots.paused()) await (await slots.unpause()).wait(2);
  console.log("MATT Slots activated", { slots: await slots.getAddress(), playableMaxMATT: hre.ethers.formatEther(await slots.currentPlayableMaxBet()) });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
