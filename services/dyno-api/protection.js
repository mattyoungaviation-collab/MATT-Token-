"use strict";
const { Contract, Interface, getAddress, ZeroHash, toBeHex } = require("ethers");
const { atBlock, id } = require("./public-state");
const GUARD_ABI = ["function admin() view returns(address)", "function governanceManager() view returns(address)", "function isAdmin(address) view returns(bool)", "function referenceWindow() view returns(uint32)", "function maximumDeviationBps() view returns(uint16)", "function minimumHarmonicLiquidity() view returns(uint128)", "function setProtection(uint32,uint16,uint128)"];
const MANAGER_ABI = ["function setLiveSaleSlippage(uint256,uint16)", "function setSubsystemPaused(bytes32,bool)"];
const VAULT_ABI = ["function setSlippageBps(uint16)", "function setExecutionPaused(bool)"];
function uint(value, max, positive = false) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error("INVALID_PROTECTION");
  const n = BigInt(value);
  if (n > max || (positive && n === 0n)) throw new Error("INVALID_PROTECTION");
  return n.toString();
}
async function readProtection({ provider, manager, vault, manifest, roundId, nowSeconds, guardFactory, safe, wallet }) {
  roundId = id(roundId);
  return atBlock({ provider, chainId: manifest.chainId, nowSeconds }, async at => {
    let emergencyAdmin = null;
    if (manifest.emergencyAdmin) {
      emergencyAdmin = getAddress(await manager.emergencyAdmin(at));
      if (emergencyAdmin !== getAddress(manifest.emergencyAdmin) || !await vault.hasRole(ZeroHash, emergencyAdmin, at)) throw new Error("CONTROL_MISMATCH");
    }
    const emergencyExecution = !!wallet && !!emergencyAdmin && getAddress(wallet) === emergencyAdmin;
    if (wallet) {
      const multisig = safe || new Contract(manifest.multisig, ["function isOwner(address) view returns(bool)"], provider);
      if (!emergencyExecution && !await multisig.isOwner(wallet, at)) throw new Error("MULTISIG_OWNER_REQUIRED");
    }
    if (getAddress(await manager.multisig(at)) !== getAddress(manifest.multisig) || !await vault.hasRole(ZeroHash, manifest.multisig, at)) throw new Error("CONTROL_MISMATCH");
    const r = await manager.getRoundStatus(roundId, at), config = await manager.getSwapProtection(roundId, at);
    if (r.phase === 0n) throw new Error("ROUND_NOT_FOUND");
    const guardAddress = getAddress(config.priceGuard);
    const guard = guardFactory ? guardFactory(guardAddress) : new Contract(guardAddress, GUARD_ABI, provider);
    if (getAddress(await guard.admin(at)) !== getAddress(manifest.multisig)) throw new Error("CONTROL_MISMATCH");
    if (emergencyAdmin && (getAddress(await guard.governanceManager(at)) !== getAddress(manifest.raffleProxy) || !await guard.isAdmin(emergencyAdmin, at))) throw new Error("CONTROL_MISMATCH");
    const schedule = await vault.getSchedule(at);
    const buybackActive = schedule.state === 1n && await vault.roundId(at) === BigInt(roundId);
    if (buybackActive && getAddress(await vault.guard(at)) !== guardAddress) throw new Error("CONTROL_MISMATCH");
    const current = {
      saleSlippageBps: uint(config.saleSlippageBps, 1000n),
      buybackSlippageBps: uint(buybackActive ? await vault.slippageBps(at) : config.buybackSlippageBps, 1000n),
      referenceWindowSeconds: uint(await guard.referenceWindow(at), 2n ** 32n - 1n),
      maximumDeviationBps: uint(await guard.maximumDeviationBps(at), 10000n),
      minimumLiquidity: uint(await guard.minimumHarmonicLiquidity(at), 2n ** 128n - 1n, true),
    };
    return { roundId, current, guardAddress, multisig: manifest.multisig, emergencyAdmin,
      executionMode: emergencyExecution ? "emergency-wallet" : "multisig", executionFrom: emergencyExecution ? emergencyAdmin : manifest.multisig, phase: Number(r.phase),
      checkoutPaused: await manager.checkoutPaused(at), buybackPaused: await vault.executionPaused(at),
      saleEditable: [2n, 3n].includes(r.phase), buybackEditable: buybackActive,
      guardEditable: await manager.activeRoundId(at) === BigInt(roundId),
      limits: { slippageBps: "0..1000", deviationBps: "0..10000", referenceWindowSeconds: "0..4294967295 (0 = spot-only)", minimumLiquidity: "1..340282366920938463463374607431768211455" },
      scope: "DYNO only; guard changes affect both ticket sales and buybacks using this guard. No Katana-wide restriction.", canPropose: !!wallet };
  });
}
async function prepareProtection({ state, request, manifest, provider }) {
  if (!request.expected || JSON.stringify(request.expected) !== JSON.stringify(state.current)) throw new Error("PROTECTION_CHANGED");
  let target, method, args, abi;
  if (request.kind === "sale") {
    if (!state.saleEditable) throw new Error("PROTECTION_PHASE");
    target = manifest.raffleProxy; method = "setLiveSaleSlippage"; args = [state.roundId, uint(request.value, 1000n)]; abi = MANAGER_ABI;
  } else if (request.kind === "buyback") {
    if (!state.buybackEditable) throw new Error("PROTECTION_PHASE");
    target = manifest.buybackProxy; method = "setSlippageBps"; args = [uint(request.value, 1000n)]; abi = VAULT_ABI;
  } else if (request.kind === "guard") {
    if (!state.guardEditable) throw new Error("PROTECTION_PHASE");
    target = state.guardAddress; method = "setProtection"; abi = GUARD_ABI;
    args = [uint(request.referenceWindowSeconds, 2n ** 32n - 1n), uint(request.maximumDeviationBps, 10000n), uint(request.minimumLiquidity, 2n ** 128n - 1n, true)];
  } else throw new Error("INVALID_PROTECTION");
  const data = new Interface(abi).encodeFunctionData(method, args);
  // Simulate the authenticated execution authority, without signing or sending.
  await provider.send("eth_call", [{ from: state.executionFrom || manifest.multisig, to: target, data, value: "0x0" }, toBeHex(BigInt(state.chainBlock))]);
  if ((await provider.getBlock(Number(state.chainBlock)))?.hash !== state.chainBlockHash) throw new Error("CHAIN_DATA_CHANGED");
  return { target, value: "0", data, method, args, chainId: manifest.chainId, multisig: manifest.multisig,
    executionMode: state.executionMode || "multisig", executionFrom: state.executionFrom || manifest.multisig,
    before: state.current, proposed: request.kind === "guard" ? { referenceWindowSeconds: args[0], maximumDeviationBps: args[1], minimumLiquidity: args[2] } : { [`${request.kind}SlippageBps`]: args.at(-1) },
    chainBlock: state.chainBlock, chainBlockHash: state.chainBlockHash, submitted: false, simulated: true,
    meaning: `Unsigned ${state.executionMode === "emergency-wallet" ? "unilateral emergency-wallet" : "multisig"} draft. No transaction submitted. Effective only after on-chain execution; no timelock. Ticket/prize amounts, DCA budget, slices, beneficiary and end time do not change.`,
    warnings: ["A zero-second window uses the current spot price only: one manipulated trade can set a misleading reference. Even a low per-trade slippage allowance can accompany severe cumulative price decline.", "The fixed pool, positive liquidity floor and nonzero minimum output remain. Zero slippage means exact selected-reference protection.", "Already FAILED/MISSED buyback slots cannot be revived; guard changes affect subsequent attempts only.", "Settings may change again before signing; review current on-chain values in the multisig."] };
}
module.exports = { readProtection, prepareProtection };
