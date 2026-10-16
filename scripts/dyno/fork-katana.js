"use strict";
// The ONLY provider used for writes is Hardhat's ephemeral in-process fork.
const hre = require("hardhat");
const fs = require("fs");
let stage = "configuration";
async function main() {
  if (hre.network.name !== "hardhat") throw new Error("FORK_SCRIPT_REFUSES_LIVE_NETWORK");
  const url = process.env.DYNO_FORK_RPC_URL;
  const file = process.env.DYNO_FORK_MANIFEST;
  const blockNumber = Number(process.env.DYNO_FORK_BLOCK);
  if (!url || !file || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) throw new Error("Private read-only fork RPC, manifest and pinned block are required");
  if (blockNumber < 43254600) throw new Error("FORK_REQUIRES_POST_CANCUN_RONIN_BLOCK");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const { ethers } = hre;
  for (const field of ["matt", "wron", "router", "pool", "factory"]) if (!ethers.isAddress(m[field] || "") || m[field] === ethers.ZeroAddress) throw new Error(`Missing verified ${field}`);
  if (m.chainId !== 2020 || !m.poolFee || BigInt(m.minimumLiquidity || 0) <= 0n) throw new Error("Ronin route, fee and explicit simulation liquidity floor are required");
  const source = new ethers.JsonRpcProvider(url, 2020, { staticNetwork: true, batchMaxCount: 1 });
  stage = "source-chain-and-block";
  if (Number(BigInt(await source.send("eth_chainId", []))) !== 2020) throw new Error("FORK_SOURCE_CHAIN_MISMATCH");
  const pinned = await source.getBlock(blockNumber); if (!pinned?.hash) throw new Error("FORK_BLOCK_UNAVAILABLE");
  stage = "source-router-code";
  const routerCode = await source.getCode(m.router, blockNumber);
  if (routerCode === "0x" || (m.routerCodeHash && ethers.keccak256(routerCode) !== m.routerCodeHash)) throw new Error("ROUTER_CODE_MISMATCH");
  stage = "local-fork-reset";
  await require("./fork-runtime-compat").installForkRuntimeCompatibility(hre);
  // Initialize directly with the explicitly configured source-chain history.
  if (hre.config.networks.hardhat.forking?.blockNumber !== blockNumber) throw new Error("FORK_BOOTSTRAP_CONFIGURATION_MISMATCH");
  await hre.network.provider.request({ method: "eth_chainId", params: [] });
  const [actor, treasury] = await ethers.getSigners();
  const pool = new ethers.Contract(m.pool, ["function factory() view returns(address)", "function fee() view returns(uint24)"], ethers.provider);
  stage = "pool-configuration-read";
  if ((await pool.factory()).toLowerCase() !== m.factory.toLowerCase() || Number(await pool.fee()) !== m.poolFee) throw new Error("POOL_CONFIGURATION_MISMATCH");
  stage = "local-guard-deployment";
  const guard = await (await ethers.getContractFactory("ProjectDynoKatanaV3PriceGuard")).deploy(actor.address, m.matt, m.wron, m.pool, m.factory, m.minimumLiquidity);
  await guard.waitForDeployment();
  const windowSeconds = Number(process.env.DYNO_SIM_REFERENCE_WINDOW_SECONDS ?? 3600);
  const buybackSlippageBps = Number(process.env.DYNO_SIM_BUYBACK_SLIPPAGE_BPS ?? 200);
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 0 || windowSeconds > 86400 || !Number.isSafeInteger(buybackSlippageBps) || buybackSlippageBps < 0 || buybackSlippageBps > 1000) throw new Error("FORK_SIMULATION_SETTINGS_INVALID");
  if (windowSeconds !== 3600) await (await guard.setProtection(windowSeconds, 1000, m.minimumLiquidity)).wait();
  stage = "reference-guard-validation";
  try { await guard.validate(); } catch (error) {
    // Public pool diagnostics help distinguish oracle state from a compiler ABI
    // incompatibility without weakening the guard or exposing provider errors.
    const oracle = new ethers.Contract(m.pool, ["function observe(uint32[]) view returns(int56[],uint160[])", "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,uint8,bool)"], ethers.provider);
    const observed = await oracle.observe([3600, 0]);
    const current = await oracle.slot0();
    console.error(JSON.stringify({ localOracle: { observations: observed.map(values => Array.from(values, String)), spotTick: current[1].toString(), unlocked: current[7] } }));
    throw error;
  } // canonical pair/history/harmonic liquidity/unlocked/deviation
  const adapter = await (await ethers.getContractFactory("ProjectDynoKatanaAggregateAdapter")).deploy(m.matt, m.wron, m.router, m.poolFee);
  const matt = new ethers.Contract(m.matt, ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)", "function decimals() view returns(uint8)"], actor);
  if (Number(await matt.decimals()) !== 18) throw new Error("MATT_DECIMALS_MISMATCH");
  const marketSnapshot = await hre.network.provider.request({ method: "evm_snapshot", params: [] });
  // Bootstrap only on the fork: obtains real MATT without modifying token storage or impersonating a holder.
  // This deliberately unprotected setup trade is NOT a permitted production checkout.
  stage = "local-bootstrap-swap";
  await (await adapter.buyMatt(actor.address, 1, { value: ethers.parseEther("200") })).wait();
  const ticket = ethers.parseEther("700000");
  if (await matt.balanceOf(actor.address) < ticket * 3n) throw new Error("FORK_BOOTSTRAP_INSUFFICIENT_MATT");
  await (await matt.approve(adapter.target, ticket * 3n)).wait();
  const sales = [];
  for (let i = 0; i < 3; i++) {
    stage = `ticket-sale-${i + 1}`;
    const minimum = await guard.saleMinOut(ticket, 200);
    const before = await ethers.provider.getBalance(actor.address);
    const receipt = await (await adapter.sellExactMatt(ticket, minimum)).wait();
    const after = await ethers.provider.getBalance(actor.address);
    const output = after - before + receipt.gasUsed * receipt.gasPrice;
    sales.push({ ticket: i, minimum: minimum.toString(), actualRon: output.toString(), gasUsed: receipt.gasUsed.toString() });
    if (output < minimum) throw new Error("FORK_SALE_OUTPUT_MISMATCH");
  }
  console.log(JSON.stringify({ checkpoint: "three-ticket-sales-completed", localForkOnly: true, blockNumber, blockHash: pinned.hash, sales }));
  // The bootstrap buy changes spot price. Restore the original pool before
  // testing a buyback so that artificial ticket inventory acquisition cannot
  // masquerade as real market impact. These are independent trade-size probes,
  // not a claim that a full 1,000-ticket sales path has been simulated.
  if (!await hre.network.provider.request({ method: "evm_revert", params: [marketSnapshot] })) throw new Error("LOCAL_SNAPSHOT_RESTORE_FAILED");
  // Planning-size buy is illustrative, not an asserted live DCA slice or guaranteed output.
  stage = "hourly-buyback-size";
  const buy = ethers.parseEther("136.5672"), minimum = await guard.buybackMinOut(buy, buybackSlippageBps);
  const before = await matt.balanceOf(treasury.address);
  let receipt;
  try {
    receipt = await (await adapter.buyMatt(treasury.address, minimum, { value: buy })).wait();
  } catch (error) {
    let localUnprotectedMattOut = null;
    try { localUnprotectedMattOut = (await adapter.buyMatt.staticCall(treasury.address, 1, { value: buy })).toString(); }
    catch { /* A failed diagnostic cannot weaken the protected trade. */ }
    console.error(JSON.stringify({ localBuybackProbe: { ronIn: buy.toString(), referenceMinimumMattOut: minimum.toString(), localUnprotectedMattOut } }));
    throw error;
  }
  const delivered = (await matt.balanceOf(treasury.address)) - before;
  if (delivered < minimum || await matt.allowance(adapter.target, m.router) !== 0n) throw new Error("FORK_DELIVERY_OR_APPROVAL_MISMATCH");
  stage = "source-reconciliation";
  if ((await source.getBlock(blockNumber))?.hash !== pinned.hash) throw new Error("FORK_SOURCE_REORGED");
  source.destroy();
  console.log(JSON.stringify({ localForkOnly: true, sourceChainId: 2020, blockNumber, blockHash: pinned.hash, referenceWindowSeconds: windowSeconds, buybackSlippageBps, sales, illustrativeBuy: { ron: buy.toString(), minimum: minimum.toString(), deliveredMatt: delivered.toString(), gasUsed: receipt.gasUsed.toString() }, productionReady: false, remaining: ["sustained/transient manipulation simulations", "full-round pool-path/impact analysis", "liquidity-floor review", "live bytecode provenance"] }, null, 2));
}
main().catch(error => {
  // Decode only locally known contract error NAMES. Never print provider text,
  // transaction payloads, arguments, URLs or nested error objects.
  let reason = ["CALL_EXCEPTION", "BAD_DATA", "NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"].includes(error.code) ? error.code : ["TypeError", "RangeError"].includes(error.name) ? error.name : "unclassified";
  const data = [error.data, error.error?.data, error.info?.error?.data].find(value => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value));
  if (data) {
    for (const name of ["ProjectDynoKatanaV3PriceGuard", "ProjectDynoKatanaAggregateAdapter"]) {
      try {
        const abi = require(`../../artifacts/contracts/dyno/${name}.sol/${name}.json`).abi;
        const decoded = new hre.ethers.Interface(abi).parseError(data);
        if (decoded) { reason = decoded.name; break; }
      } catch { /* Unknown provider or external contract errors stay redacted. */ }
    }
    try {
      const routerErrors = new hre.ethers.Interface([
        "error ExecutionFailed(uint256 commandIndex,bytes message)",
        "error V3TooLittleReceived()", "error V3TooMuchRequested()",
        "error V3UnauthorizedSwap()", "error V3InvalidAmountOut()",
        "error V3InvalidCaller()", "error V3InvalidSwap()"
      ]);
      const outer = routerErrors.parseError(data);
      if (outer) reason = outer.name === "ExecutionFailed" ? routerErrors.parseError(outer.args[1])?.name || "ExecutionFailed" : outer.name;
    } catch { /* Never print undecoded error bytes. */ }
  }
  const diagnosticText = String(error.message || "");
  const knownRouterError = ["V3TooLittleReceived", "V3TooMuchRequested", "V3UnauthorizedSwap", "V3InvalidAmountOut", "V3InvalidCaller", "V3InvalidSwap"].find(name => diagnosticText.includes(name));
  if (knownRouterError) reason = knownRouterError;
  const hardforkContext = diagnosticText.match(/No known hardfork for execution on historical block [0-9]+(?: \(relative to fork block number [0-9]+\))?(?: in chain with id [0-9]+)?/i)?.[0] || null;
  const providerHints = {
    unsupportedMethod: /method not found|not supported|unsupported/i.test(diagnosticText),
    rateLimited: /429|rate.limit|too many requests/i.test(diagnosticText),
    historicalState: /historical|archive|trie/i.test(diagnosticText),
    storageRead: /eth_getStorageAt|storage/i.test(diagnosticText),
    stateProof: /eth_getProof/i.test(diagnosticText),
    invalidResponse: /invalid response|invalid params|invalid json/i.test(diagnosticText),
    missingHardforkHistory: /No known hardfork|hardfork activation history/i.test(diagnosticText),
    missingMethod: /is not a function/i.test(diagnosticText),
    noRevertData: /without a reason|missing revert data/i.test(diagnosticText),
    oracleTooOld: /\bOLD\b/.test(diagnosticText)
  };
  console.error(JSON.stringify({ stage, reason, providerHints, hardforkContext }));
  console.error(`DYNO Katana fork check failed at ${stage} (${reason}); RPC credentials and private error details are redacted. No live transaction was sent.`);
  process.exitCode = 1;
});
