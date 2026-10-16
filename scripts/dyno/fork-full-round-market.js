"use strict";

// Economic capacity probe only. All writes are to a disposable Hardhat fork.
// It does not imitate actual participants, daily timing, or identity checks.
const fs = require("node:fs");
const hre = require("hardhat");

const SOURCE_HOLDER = "0x6EA3e4bD286FD84ca09B0781fEDCaB44b103706a";
const TICKET_MATT = 700_000n * 10n ** 18n;
const MAX_SALES = Number(process.env.DYNO_SIM_MAX_SALES || 1000);
const REQUIRED_MATT = BigInt(Number.isSafeInteger(MAX_SALES) && MAX_SALES >= 1 && MAX_SALES <= 1000 ? MAX_SALES : 1000) * TICKET_MATT;
const BLOCK = Number(process.env.DYNO_FORK_BLOCK);
const GAP_SECONDS = Number(process.env.DYNO_SIM_GAP_SECONDS || 0);
const SALE_SLIPPAGE_BPS = Number(process.env.DYNO_SIM_SALE_SLIPPAGE_BPS || 200);
const REFERENCE_WINDOW_SECONDS = Number(process.env.DYNO_SIM_REFERENCE_WINDOW_SECONDS ?? 3600);
let stage = "configuration";

function classifyFailure(error, ethers) {
  const text = String(error.message || "");
  const errors = new ethers.Interface([
    "error ExecutionFailed(uint256 commandIndex,bytes message)",
    "error V3TooLittleReceived()", "error V3TooMuchRequested()",
    "error V3UnauthorizedSwap()", "error V3InvalidAmountOut()",
    "error V3InvalidCaller()", "error V3InvalidSwap()",
    "error ExcessiveDeviation()", "error InsufficientLiquidity()",
    "error InvalidOracleLiquidity()", "error InvalidConfiguration()"
  ]);
  const data = [error.data, error.error?.data, error.info?.error?.data].find(value => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value));
  if (data) {
    try {
      const parsed = errors.parseError(data);
      if (parsed) {
        if (parsed.name === "ExecutionFailed") return errors.parseError(parsed.args[1])?.name || "ExecutionFailed";
        if (parsed.name === "Error") {
          const revertReason = String(parsed.args[0] || "");
          return ["OLD", "I", "LOK", "T", "AS", "SPL", "STF", "TF", "SafeERC20: low-level call failed"].includes(revertReason)
            ? `Error(${revertReason})` : "Error(string)";
        }
        return parsed.name;
      }
    } catch { /* Unrecognized bytes are never printed. */ }
  }
  return ["InsufficientLiquidity", "ExcessiveDeviation", "InvalidOracleLiquidity", "V3TooLittleReceived", "V3UnauthorizedSwap", "V3InvalidSwap"].find(name => text.includes(name)) || (text.includes("missing revert data") ? "missing-revert-data" : "unclassified");
}

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("LIVE_NETWORK_REFUSED");
  if (!process.env.DYNO_FORK_RPC_URL || !process.env.DYNO_FORK_MANIFEST || !Number.isSafeInteger(BLOCK) || BLOCK < 43254600) throw new Error("FORK_INPUTS_REQUIRED");
  if (!Number.isSafeInteger(GAP_SECONDS) || GAP_SECONDS < 0 || GAP_SECONDS > 86400) throw new Error("SIMULATION_GAP_INVALID");
  if (!Number.isSafeInteger(MAX_SALES) || MAX_SALES < 1 || MAX_SALES > 1000) throw new Error("SIMULATION_SALE_LIMIT_INVALID");
  if (!Number.isSafeInteger(SALE_SLIPPAGE_BPS) || SALE_SLIPPAGE_BPS < 0 || SALE_SLIPPAGE_BPS > 1000) throw new Error("SIMULATION_SLIPPAGE_INVALID");
  if (!Number.isSafeInteger(REFERENCE_WINDOW_SECONDS) || REFERENCE_WINDOW_SECONDS < 0 || REFERENCE_WINDOW_SECONDS > 86400) throw new Error("SIMULATION_WINDOW_INVALID");
  const manifest = JSON.parse(fs.readFileSync(process.env.DYNO_FORK_MANIFEST, "utf8"));
  if (manifest.environment !== "local-fork-only" || manifest.productionReady !== false || manifest.chainId !== 2020) throw new Error("LOCAL_SIMULATION_MANIFEST_REQUIRED");
  if (hre.config.networks.hardhat.forking?.blockNumber !== BLOCK) throw new Error("PINNED_FORK_CONFIGURATION_REQUIRED");
  await require("./fork-runtime-compat").installForkRuntimeCompatibility(hre);
  const { ethers } = hre;
  const source = new ethers.JsonRpcProvider(process.env.DYNO_FORK_RPC_URL, 2020, { staticNetwork: true, batchMaxCount: 1 });
  if (Number(BigInt(await source.send("eth_chainId", []))) !== 2020) throw new Error("WRONG_SOURCE_CHAIN");
  const sourceBlock = await source.getBlock(BLOCK);
  if (!sourceBlock?.hash) throw new Error("SOURCE_BLOCK_MISSING");
  const routerCode = await source.getCode(manifest.router, BLOCK);
  if (routerCode === "0x" || ethers.keccak256(routerCode) !== manifest.routerCodeHash) throw new Error("ROUTER_CODE_MISMATCH");
  const balanceAbi = ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"];
  const tokenOnSource = new ethers.Contract(manifest.matt, balanceAbi, source);
  if (await tokenOnSource.balanceOf(SOURCE_HOLDER, { blockTag: BLOCK }) < REQUIRED_MATT) throw new Error("HOLDER_BALANCE_BELOW_SIMULATION_INPUT");
  stage = "fork-setup";
  await hre.network.provider.request({ method: "eth_chainId", params: [] });
  const [deployer] = await ethers.getSigners();
  const guard = await (await ethers.getContractFactory("ProjectDynoKatanaV3PriceGuard")).deploy(deployer.address, manifest.matt, manifest.wron, manifest.pool, manifest.factory, manifest.minimumLiquidity);
  await guard.waitForDeployment();
  if (REFERENCE_WINDOW_SECONDS !== 3600) await (await guard.setProtection(REFERENCE_WINDOW_SECONDS, 1000, manifest.minimumLiquidity)).wait();
  await guard.validate();
  const adapter = await (await ethers.getContractFactory("ProjectDynoKatanaAggregateAdapter")).deploy(manifest.matt, manifest.wron, manifest.router, manifest.poolFee);
  await adapter.waitForDeployment();
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [SOURCE_HOLDER] });
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [SOURCE_HOLDER, "0x" + ethers.parseEther("20").toString(16)] });
  const holder = await ethers.getSigner(SOURCE_HOLDER);
  const token = new ethers.Contract(manifest.matt, balanceAbi, holder);
  await (await token.approve(adapter.target, REQUIRED_MATT)).wait();
  const sell = adapter.connect(holder);
  const pool = new ethers.Contract(manifest.pool, ["function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,uint8,bool)", "function observe(uint32[]) view returns(int56[],uint160[])"], ethers.provider);
  const checkpoints = [];
  let totalRon = 0n;
  let completed = 0;
  let firstFailure = null;
  const firstDay = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 86400);
  for (let i = 0; i < MAX_SALES; i++) {
    stage = `sale-${i + 1}`;
    let minimum;
    try {
      await guard.validate();
      minimum = await guard.saleMinOut(TICKET_MATT, SALE_SLIPPAGE_BPS);
      const before = await ethers.provider.getBalance(SOURCE_HOLDER);
      const receipt = await (await sell.sellExactMatt(TICKET_MATT, minimum)).wait();
      const after = await ethers.provider.getBalance(SOURCE_HOLDER);
      const received = after - before + receipt.gasUsed * receipt.gasPrice;
      if (received < minimum) throw new Error("BELOW_MINIMUM");
      totalRon += received;
      completed++;
      if (GAP_SECONDS && completed < MAX_SALES) {
        await hre.network.provider.request({ method: "evm_increaseTime", params: [GAP_SECONDS] });
        await hre.network.provider.request({ method: "evm_mine", params: [] });
      }
      if (completed <= 3 || completed % 25 === 0 || completed === MAX_SALES) {
        checkpoints.push({ eligibleEquivalentSales: completed, lastTicketRon: received.toString(), totalSaleRon: totalRon.toString(), minimumRon: minimum.toString() });
        console.log(JSON.stringify({ checkpoint: checkpoints.at(-1), localForkOnly: true }));
      }
    } catch (error) {
      const reason = classifyFailure(error, ethers);
      let spotTick = null, meanTick = null;
      try {
        const spot = await pool.slot0();
        const observed = await pool.observe([3600, 0]);
        const tickDelta = observed[0][1] - observed[0][0];
        const mean = tickDelta >= 0n ? tickDelta / 3600n : (tickDelta - 3599n) / 3600n;
        spotTick = spot[1].toString(); meanTick = mean.toString();
      } catch { /* A failed diagnostic must not erase the primary trade failure. */ }
      let unprotectedQuote = null;
      if (reason === "V3TooLittleReceived") {
        try { unprotectedQuote = (await sell.sellExactMatt.staticCall(TICKET_MATT, 1)).toString(); }
        catch { /* Quote absence cannot justify removing the floor. */ }
      }
      firstFailure = { saleNumber: i + 1, reason, referenceMinimumRon: minimum?.toString() || null, unprotectedLocalQuoteRon: unprotectedQuote, spotTick, meanTick };
      break;
    }
  }
  if ((await source.getBlock(BLOCK))?.hash !== sourceBlock.hash) throw new Error("SOURCE_REORGED");
  const lastBlock = await ethers.provider.getBlock("latest");
  const report = {
    localForkOnly: true, productionReady: false, sourceChainId: 2020,
    blockNumber: BLOCK, blockHash: sourceBlock.hash, publicImpersonatedHolder: SOURCE_HOLDER,
    guard: { saleSlippageBps: SALE_SLIPPAGE_BPS, maximumDeviationBps: 1000, referenceWindowSeconds: REFERENCE_WINDOW_SECONDS, exploratoryMinimumLiquidity: manifest.minimumLiquidity },
    gapSeconds: GAP_SECONDS, maxSales: MAX_SALES, reachedConfiguredLimit: completed === MAX_SALES && !firstFailure,
    completed, firstFailure, totalSaleRon: totalRon.toString(),
    simulatedDayChange: Math.floor(lastBlock.timestamp / 86400) - firstDay,
    checkpoints,
    limitations: [`at most ${MAX_SALES} continuous local swaps from one public holder; no daily identity simulation`, "price history moves with local block timestamps, not multi-day real trading", "liquidity floor 1 is exploratory, not production approval", "market participants/MEV/other trades excluded"]
  };
  console.log(JSON.stringify(report, null, 2));
  source.destroy();
}

main().catch(error => {
  console.error(JSON.stringify({ stage, failure: ["LIVE_NETWORK_REFUSED", "FORK_INPUTS_REQUIRED", "SIMULATION_SALE_LIMIT_INVALID", "LOCAL_SIMULATION_MANIFEST_REQUIRED", "PINNED_FORK_CONFIGURATION_REQUIRED", "WRONG_SOURCE_CHAIN", "SOURCE_BLOCK_MISSING", "ROUTER_CODE_MISMATCH", "HOLDER_BALANCE_BELOW_SIMULATION_INPUT", "SOURCE_REORGED"].includes(error.message) ? error.message : "SIMULATION_UNAVAILABLE" }));
  process.exitCode = 1;
});
