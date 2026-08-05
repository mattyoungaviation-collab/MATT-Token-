const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const name = network.chainId === 2020n ? "ronin" : "saigon";
  const deployment = JSON.parse(fs.readFileSync(process.env.SLOTS_DEPLOYMENT_FILE || path.join(__dirname, `../deployment-exports/slots-${name}.json`), "utf8"));
  const amountText = process.env.SLOTS_VAULT_FUND_MATT;
  if (!amountText || !/^\d+(\.\d{1,18})?$/.test(amountText)) throw new Error("Set SLOTS_VAULT_FUND_MATT to the MATT amount to deposit.");
  const amount = hre.ethers.parseEther(amountText);
  const token = await hre.ethers.getContractAt(["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], deployment.immutable.matt, signer);
  const vault = await hre.ethers.getContractAt("MattSlotsRewardVault", deployment.contracts.rewardVault, signer);
  if ((await token.balanceOf(signer.address)) < amount) throw new Error("Signer does not hold enough MATT.");
  await (await token.approve(await vault.getAddress(), amount)).wait(2);
  await (await vault.fund(amount)).wait(2);
  console.log("Slots reward vault funded", { amountMATT: amountText, availableBankroll: (await vault.availableBankroll()).toString() });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
