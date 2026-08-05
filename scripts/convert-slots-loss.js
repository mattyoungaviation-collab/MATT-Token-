"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

function requireHexCalldata(value) {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(String(value || "")) || String(value).length % 2 !== 0) {
    throw new Error("SLOTS_ROUTER_CALLDATA must be complete 0x-prefixed calldata for the approved router.");
  }
  return String(value);
}

async function main() {
  if (process.env.CONFIRM_SLOTS_CONVERSION !== "YES") {
    throw new Error("Conversion is locked. Review the router quote, then set CONFIRM_SLOTS_CONVERSION=YES.");
  }
  const network = await hre.ethers.provider.getNetwork();
  const name = network.chainId === 2020n ? "ronin" : network.chainId === 202601n ? "saigon" : null;
  if (!name) throw new Error(`Unsupported chain ${network.chainId}.`);
  const deploymentPath = process.env.SLOTS_DEPLOYMENT_FILE
    || path.join(__dirname, `../deployment-exports/slots-${name}.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const converter = await hre.ethers.getContractAt("MattSlotsTreasuryConverter", deployment.contracts.converter);
  if (await converter.paused()) throw new Error("The Slots converter is paused.");

  const amountText = process.env.SLOTS_CONVERT_MATT;
  const minimumText = process.env.SLOTS_MIN_WRON_OUT;
  if (!amountText || !/^\d+(\.\d{1,18})?$/.test(amountText)) {
    throw new Error("Set SLOTS_CONVERT_MATT to the exact queued MATT amount the approved router call will spend.");
  }
  if (!minimumText || !/^\d+(\.\d{1,18})?$/.test(minimumText)) {
    throw new Error("Set SLOTS_MIN_WRON_OUT to the exact WRON minimum encoded in the router call.");
  }
  const amountIn = hre.ethers.parseEther(amountText);
  const minimumOut = hre.ethers.parseEther(minimumText);
  const routerCall = requireHexCalldata(process.env.SLOTS_ROUTER_CALLDATA);
  const pending = await converter.pendingMatt();
  if (amountIn > pending) throw new Error(`Only ${hre.ethers.formatEther(pending)} MATT is queued in the converter.`);
  const [twapQuote, liquidity] = await converter.quoteTwap(amountIn);
  const maxSlippageBps = await converter.maxSlippageBps();
  const requiredMinimum = twapQuote * (10_000n - maxSlippageBps) / 10_000n;
  if (minimumOut < requiredMinimum) {
    throw new Error(
      `Router minimum ${hre.ethers.formatEther(minimumOut)} WRON is below the contract floor `
      + `${hre.ethers.formatEther(requiredMinimum)} WRON.`
    );
  }
  console.log("Slots conversion preflight", {
    converter: await converter.getAddress(),
    router: await converter.router(),
    mattIn: amountText,
    minimumWronOut: minimumText,
    twapWronQuote: hre.ethers.formatEther(twapQuote),
    harmonicLiquidity: liquidity.toString(),
    treasury: await converter.treasury()
  });
  const tx = await converter.convert(amountIn, minimumOut, routerCall);
  console.log("Slots conversion broadcast", { hash: tx.hash });
  await tx.wait(2);
  console.log("Queued MATT was converted and all received RON was forwarded to the immutable treasury.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
