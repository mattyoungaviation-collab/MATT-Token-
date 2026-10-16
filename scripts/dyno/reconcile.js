"use strict";

const fs = require("fs");
const { JsonRpcProvider, Contract } = require("ethers");

async function main() {
  const deploymentFile = process.argv[2];
  if (!deploymentFile) throw new Error("Usage: node scripts/dyno/reconcile.js deployment.json [roundId]");
  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const rpc = process.env.DYNO_RPC_URL || process.env.RONIN_RPC_URL;
  if (!rpc) throw new Error("DYNO_RPC_URL or RONIN_RPC_URL is required");
  const artifact = require("../../artifacts/contracts/dyno/ProjectDynoRaffleManager.sol/ProjectDynoRaffleManager.json");
  const provider = new JsonRpcProvider(rpc, deployment.chainId, { staticNetwork: true });
  const manager = new Contract(deployment.raffleProxy, artifact.abi, provider);
  const roundId = BigInt(process.argv[3] || deployment.roundId || 1);
  const status = await manager.getRoundStatus(roundId);
  const balance = await provider.getBalance(deployment.raffleProxy);
  const recorded = status.directActive + status.saleActive + status.operationsBalance + status.refundLiability + status.prizeLiability + status.treasuryLiability;
  const mattBuckets = {
    active: await manager.mattActive(roundId), refundable: await manager.mattRefundLiability(roundId), treasuryDue: await manager.treasuryMattLiability(roundId),
  };
  const token = new Contract(deployment.matt, ["function balanceOf(address) view returns(uint256)"], provider);
  const mattBalance = await token.balanceOf(deployment.raffleProxy);
  const mattObligations = mattBuckets.active + mattBuckets.refundable + mattBuckets.treasuryDue;
  console.log(JSON.stringify({ roundId: roundId.toString(), indexedBlock: await provider.getBlockNumber(), ronBalance: balance.toString(), recordedRonObligations: recorded.toString(), mattBalance: mattBalance.toString(), recordedMattObligations: mattObligations.toString(), ronSolvent: balance >= recorded, mattSolvent: mattBalance >= mattObligations, note: "Per-round obligations; reconcile all unsettled rounds before treating excess as surplus." }, null, 2));
  if (balance < recorded || mattBalance < mattObligations) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
