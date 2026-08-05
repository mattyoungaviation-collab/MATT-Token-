const fs = require("node:fs");
const path = require("node:path");
const deploymentPath = process.argv[2];
if (!deploymentPath) throw new Error("Usage: node scripts/update-slots-frontend.js deployment-exports/slots-ronin.json");
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
if (deployment.chainId !== 2020) throw new Error("Only a verified Ronin mainnet deployment may be published to the live Slots page.");
const target = path.join(__dirname, "../website/public/slots-config.js");
const content = `(() => {\n  "use strict";\n  window.MATT_SLOTS_CONFIG = Object.freeze(${JSON.stringify({
  chainId: 2020, chainHex: "0x7e4", chainName: "Ronin Mainnet", rpcUrl: "/api/rpc",
  tokenAddress: deployment.immutable.matt, tokenSymbol: "MATT", treasuryAddress: deployment.immutable.treasury,
  vrfCoordinatorAddress: deployment.immutable.coordinator,
  slotsAddress: deployment.contracts.slots, rewardVaultAddress: deployment.contracts.rewardVault,
  converterAddress: deployment.contracts.converter, deploymentBlock: deployment.deploymentBlock || null,
  declaredRtp: deployment.math.declaredRtpBps / 100, maxMultiplier: 500,
  defaultBet: "5000", defaultQuantity: 10, explorerBase: "https://app.roninchain.com", practiceEnabled: true
}, null, 4)});\n})();\n`;
fs.writeFileSync(target, content);
console.log(`Updated ${target} with paused deployment addresses.`);
