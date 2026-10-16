"use strict";

const fs = require("fs");
const { Interface } = require("ethers");

function prepare(target, abi, method, args, value = "0") {
  const data = new Interface(abi).encodeFunctionData(method, args);
  return { target, value: String(value), data, method, args, meaning: `Call ${method} on Project DYNO contract; review target, value and decoded parameters in the multisig before signing.`, submitted: false };
}

if (require.main === module) {
  const [requestFile, outputFile] = process.argv.slice(2);
  if (!requestFile) throw new Error("Usage: node scripts/dyno/prepare-multisig.js request.json [output.json]");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const artifact = require(`../../artifacts/contracts/dyno/${request.contract}.sol/${request.contract}.json`);
  const tx = prepare(request.target, artifact.abi, request.method, request.args || [], request.value || "0");
  if (outputFile) fs.writeFileSync(outputFile, `${JSON.stringify(tx, null, 2)}\n`);
  else console.log(JSON.stringify(tx, null, 2));
}
module.exports = { prepare };
