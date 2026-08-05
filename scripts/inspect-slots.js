const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const name = network.chainId === 2020n ? "ronin" : network.chainId === 202601n ? "saigon" : null;
  if (!name) throw new Error(`Unsupported chain ${network.chainId}.`);
  const exportPath = process.env.SLOTS_DEPLOYMENT_FILE || path.join(__dirname, `../deployment-exports/slots-${name}.json`);
  const deployment = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  const slots = await hre.ethers.getContractAt("MattSlotsV1", deployment.contracts.slots);
  const vault = await hre.ethers.getContractAt("MattSlotsRewardVault", deployment.contracts.rewardVault);
  const converter = await hre.ethers.getContractAt("MattSlotsTreasuryConverter", deployment.contracts.converter);
  const report = {
    network: name, chainId: network.chainId.toString(), addresses: deployment.contracts,
    slots: {
      owner: await slots.owner(), paused: await slots.paused(), minBet: (await slots.minBet()).toString(),
      maxBet: (await slots.maxBet()).toString(), playableMaxBet: (await slots.currentPlayableMaxBet()).toString(),
      activeMathVersion: (await slots.activeMathVersion()).toString(), totalCreditEscrow: (await slots.totalCreditEscrow()).toString(),
      totalPaidSpinsPlayed: (await slots.totalPaidSpinsPlayed()).toString(), totalBonusSpinsPlayed: (await slots.totalBonusSpinsPlayed()).toString()
    },
    vault: {
      owner: await vault.owner(), controller: await vault.controller(), availableBankroll: (await vault.availableBankroll()).toString(),
      totalReserved: (await vault.totalReserved()).toString(), totalClaimable: (await vault.totalClaimable()).toString(),
      pendingTreasuryLoss: (await vault.pendingTreasuryLoss()).toString(), solvent: await vault.isSolvent()
    },
    converter: {
      owner: await converter.owner(), paused: await converter.paused(), sourceVault: await converter.sourceVault(),
      router: await converter.router(), keeper: await converter.keeper(), pendingMatt: (await converter.pendingMatt()).toString(),
      totalMattConverted: (await converter.totalMattConverted()).toString(), totalRonForwarded: (await converter.totalRonForwarded()).toString()
    }
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.vault.solvent) throw new Error("Reward vault is not solvent.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
