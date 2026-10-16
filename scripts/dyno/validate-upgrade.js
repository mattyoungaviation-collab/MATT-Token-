"use strict";

const hre = require("hardhat");
async function main() {
  const managerName = process.env.DYNO_MANAGER_UPGRADE_CONTRACT || "ProjectDynoRaffleManager";
  const vaultName = process.env.DYNO_VAULT_UPGRADE_CONTRACT || "ProjectDynoBuybackVault";
  if (managerName === "ProjectDynoRaffleManager") {
    await hre.upgrades.validateImplementation(await hre.ethers.getContractFactory(managerName), { kind: "uups" });
  } else {
    await hre.upgrades.validateUpgrade(
      await hre.ethers.getContractFactory("ProjectDynoRaffleManager"),
      await hre.ethers.getContractFactory(managerName),
      { kind: "uups" }
    );
  }
  if (vaultName === "ProjectDynoBuybackVault") {
    await hre.upgrades.validateImplementation(await hre.ethers.getContractFactory(vaultName), { kind: "uups" });
  } else {
    await hre.upgrades.validateUpgrade(
      await hre.ethers.getContractFactory("ProjectDynoBuybackVault"),
      await hre.ethers.getContractFactory(vaultName),
      { kind: "uups" }
    );
  }
  console.log(`UUPS implementation and storage validation passed for ${managerName} and ${vaultName}.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
