"use strict";
// Read-only readiness evidence. Never signs, deploys, requests a seed or prints RPC URLs.
const { Interface, keccak256 } = require("ethers");
const NETWORKS = {
  ronin: { chainId: 2020, rpcEnv: "RONIN_RPC_URL", publicRpc: "https://api.roninchain.com/rpc", coordinator: "0x16a62a921e7fec5bf867ff5c805b662db757b778" },
  saigon: { chainId: 202601, rpcEnv: "SAIGON_RPC_URL", publicRpc: "https://saigon-testnet.roninchain.com/rpc", coordinator: "0xa60c1e07fa030e4b49eb54950adb298ab94dd312" }
};
function rpcErrorCode(error) {
  const data = typeof error?.data === "string" ? error.data : typeof error?.data?.data === "string" ? error.data.data : "";
  // Verified Ronin VRF dependency: PriceTooOld(bytes32,uint32,uint256,uint256).
  return data.slice(0, 10).toLowerCase() === "0xff68e149" ? "VRF_PRICE_FEED_STALE" : null;
}
function makeRpc(url) {
  let id = 0;
  return async (method, params = []) => {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (body.error) throw new Error(rpcErrorCode(body.error) || "RPC_READ_UNAVAILABLE");
      if (body.result === undefined) throw new Error();
      return body.result;
    } catch (error) { throw new Error(error.message === "VRF_PRICE_FEED_STALE" ? error.message : "RPC_READ_UNAVAILABLE"); }
  };
}
async function preflightNetwork({ network = "saigon", rpc: supplied, callbackGas = 250000n } = {}) {
  const config = NETWORKS[network];
  if (!config) throw new Error("UNSUPPORTED_NETWORK");
  if (callbackGas < 100000n || callbackGas > 2000000n) throw new Error("INVALID_CALLBACK_GAS");
  const privateRpcConfigured = Boolean(process.env[config.rpcEnv]);
  const rpc = supplied || makeRpc(process.env[config.rpcEnv] || config.publicRpc);
  if (Number(BigInt(await rpc("eth_chainId"))) !== config.chainId) throw new Error("CHAIN_MISMATCH");
  const tag = await rpc("eth_blockNumber");
  const block = await rpc("eth_getBlockByNumber", [tag, false]);
  if (!block?.hash || block.number !== tag) throw new Error("BLOCK_UNAVAILABLE");
  const code = await rpc("eth_getCode", [config.coordinator, tag]);
  if (code === "0x") throw new Error("COORDINATOR_HAS_NO_CODE");
  const baseFee = BigInt(block.baseFeePerGas || "0x0");
  const proposedGasPrice = baseFee * 2n + 20_000_000_000n;
  const gasPrice = proposedGasPrice > 21_000_000_000n ? proposedGasPrice : 21_000_000_000n;
  const abi = new Interface(["function estimateRequestRandomFee(uint256,uint256) view returns(uint256)"]);
  const data = abi.encodeFunctionData("estimateRequestRandomFee", [callbackGas, gasPrice]);
  let fee;
  try { fee = abi.decodeFunctionResult("estimateRequestRandomFee", await rpc("eth_call", [{ to: config.coordinator, data }, tag]))[0]; }
  catch (error) { throw new Error(error.message === "VRF_PRICE_FEED_STALE" ? error.message : "VRF_FEE_READ_UNAVAILABLE"); }
  if (fee <= 0n) throw new Error("INVALID_VRF_FEE");
  let finalized = null;
  try {
    const f = await rpc("eth_getBlockByNumber", ["finalized", false]);
    if (!f?.hash || BigInt(f.number) > BigInt(tag)) throw new Error();
    const canonical = await rpc("eth_getBlockByNumber", [f.number, false]);
    if (canonical?.hash !== f.hash) throw new Error();
    finalized = { number: BigInt(f.number).toString(), hash: f.hash };
  } catch { /* Unsupported finalized tag is a blocker, never a latest fallback. */ }
  if ((await rpc("eth_getBlockByNumber", [tag, false]))?.hash !== block.hash) throw new Error("PREFLIGHT_BLOCK_REORGED");
  return {
    readOnly: true, network, chainId: config.chainId, observedAt: new Date().toISOString(),
    block: { number: BigInt(tag).toString(), hash: block.hash, timestamp: BigInt(block.timestamp).toString() },
    privateRpcConfigured, finalized,
    vrf: { coordinator: config.coordinator, codeHash: keccak256(code), callbackGas: callbackGas.toString(), gasPrice: gasPrice.toString(), fee: fee.toString(), operationsBudget: "25000000000000000000", budgetCoversOneQuotedRequest: fee <= 25n * 10n ** 18n },
    productionReady: false,
    blockers: [!privateRpcConfigured && "PRIVATE_RPC_NOT_CONFIGURED", !finalized && "FINALIZED_TAG_NOT_VERIFIED", "REAL_TESTNET_REQUEST_AND_CALLBACK_PENDING", "CALLBACK_GAS_REQUIRES_MEASUREMENT", "OPERATORS_AND_FUNDING_PENDING"].filter(Boolean),
    sources: ["https://docs.roninchain.com/developers/network", "https://docs.roninchain.com/developers/tools/vrf"]
  };
}
if (require.main === module) {
  require("dotenv").config({ quiet: true });
  preflightNetwork({ network: process.argv[2] || "saigon" }).then(r => console.log(JSON.stringify(r, null, 2))).catch(error => {
    const code = ["RPC_READ_UNAVAILABLE", "CHAIN_MISMATCH", "COORDINATOR_HAS_NO_CODE", "BLOCK_UNAVAILABLE", "PREFLIGHT_BLOCK_REORGED", "VRF_FEE_READ_UNAVAILABLE", "VRF_PRICE_FEED_STALE", "INVALID_VRF_FEE", "UNSUPPORTED_NETWORK"].includes(error.message) ? error.message : "PREFLIGHT_FAILED";
    console.error(`DYNO read-only network preflight: ${code}; credentials and private RPC details are redacted.`); process.exitCode = 1;
  });
}
module.exports = { preflightNetwork, makeRpc, rpcErrorCode, NETWORKS };
