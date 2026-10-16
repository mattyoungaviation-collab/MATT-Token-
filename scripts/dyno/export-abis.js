"use strict";

const fs = require("fs");
const path = require("path");
for (const contract of ["ProjectDynoRaffleManager", "ProjectDynoBuybackVault", "ProjectDynoVRFRefundReceiver", "ProjectDynoKatanaV3PriceGuard", "ProjectDynoKatanaAggregateAdapter"]) {
  const artifact = require(`../../artifacts/contracts/dyno/${contract}.sol/${contract}.json`);
  const target = path.join(__dirname, `../../packages/abis/${contract}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ contractName: contract, abi: artifact.abi }, null, 2)}\n`);
  console.log(target);
}
