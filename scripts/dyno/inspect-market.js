"use strict";

// Read-only interface evidence. No approvals, swaps, signing or production
// manifest mutation. A readable interface is not verification of token safety.
const { Interface, keccak256 } = require("ethers");
const MATT = "0xa5450417bdca0bdfb058ffe41205400ffda1174d";
const POOL_CANDIDATE = "0xa517e05e96728e80284f2ae157ddf309449d7ce8";
const SOURCE = "https://docs.roninchain.com/developers/network";
function exact(value) { return typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(exact) : value; }

async function inspectMarket({ rpcUrl = process.env.DYNO_RPC_URL || process.env.RONIN_RPC_URL || "https://api.roninchain.com/rpc", rpc: suppliedRpc } = {}) {
  let requestId = 0;
  async function rpc(method, params = []) {
    if (suppliedRpc) return suppliedRpc(method, params);
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("RPC_UNAVAILABLE");
    const result = await response.json();
    if (result.error || result.result === undefined) throw new Error("RPC_CALL_FAILED");
    return result.result;
  }
  const chainId = Number(BigInt(await rpc("eth_chainId")));
  if (chainId !== 2020) throw new Error("RONIN_CHAIN_MISMATCH");
  const blockTag = await rpc("eth_blockNumber"), block = await rpc("eth_getBlockByNumber", [blockTag, false]);
  if (!block?.hash || block.number !== blockTag) throw new Error("BLOCK_UNAVAILABLE");
  async function read(address, signature, args = []) {
    const abi = new Interface([signature]), fn = abi.fragments[0];
    try {
      const raw = await rpc("eth_call", [{ to: address, data: abi.encodeFunctionData(fn, args) }, blockTag]);
      return { ok: true, values: exact(Array.from(abi.decodeFunctionResult(fn, raw))) };
    } catch { return { ok: false, error: "INTERFACE_UNSUPPORTED_OR_READ_UNAVAILABLE" }; }
  }
  async function token(address) {
    const code = await rpc("eth_getCode", [address, blockTag]);
    const result = { address, codeBytes: (code.length - 2) / 2, codeHash: keccak256(code) };
    if (code === "0x") return result;
    for (const [key, signature] of [["name", "function name() view returns(string)"], ["symbol", "function symbol() view returns(string)"], ["decimals", "function decimals() view returns(uint8)"], ["totalSupply", "function totalSupply() view returns(uint256)"]]) result[key] = await read(address, signature);
    return result;
  }
  const result = { readOnly: true, observedAt: new Date().toISOString(), networkSource: SOURCE, chainId, blockNumber: BigInt(blockTag).toString(), blockHash: block.hash, blockTimestamp: BigInt(block.timestamp).toString(), matt: await token(MATT) };
  const code = await rpc("eth_getCode", [POOL_CANDIDATE, blockTag]);
  const pool = { address: POOL_CANDIDATE, codeBytes: (code.length - 2) / 2, codeHash: keccak256(code) };
  result.poolCandidate = pool;
  if (code !== "0x") {
    for (const [key, signature] of [
      ["token0", "function token0() view returns(address)"], ["token1", "function token1() view returns(address)"], ["factory", "function factory() view returns(address)"],
      ["reserves", "function getReserves() view returns(uint112,uint112,uint32)"], ["price0Cumulative", "function price0CumulativeLast() view returns(uint256)"], ["price1Cumulative", "function price1CumulativeLast() view returns(uint256)"],
      ["slot0", "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,uint8,bool)"], ["fee", "function fee() view returns(uint24)"], ["liquidity", "function liquidity() view returns(uint128)"]
    ]) pool[key] = await read(POOL_CANDIDATE, signature);
    pool.classification = pool.token0.ok && pool.token1.ok && pool.reserves.ok ? "V2_LIKE_INTERFACE" : pool.token0.ok && pool.token1.ok && pool.slot0.ok && pool.fee.ok ? "V3_LIKE_INTERFACE" : "UNRESOLVED";
    if (pool.token0.ok && pool.token1.ok) {
      const tokens = [pool.token0.values[0], pool.token1.values[0]];
      pool.includesMatt = tokens.some(address => address.toLowerCase() === MATT);
      pool.tokens = [];
      for (const address of tokens) pool.tokens.push(await token(address));
      if (pool.factory.ok) {
        pool.factoryPair = pool.classification === "V2_LIKE_INTERFACE" ? await read(pool.factory.values[0], "function getPair(address,address) view returns(address)", tokens)
          : pool.fee.ok ? await read(pool.factory.values[0], "function getPool(address,address,uint24) view returns(address)", [...tokens, pool.fee.values[0]]) : { ok: false };
        pool.factoryMatches = pool.factoryPair.ok && pool.factoryPair.values[0].toLowerCase() === POOL_CANDIDATE;
      }
      if (pool.classification === "V3_LIKE_INTERFACE") {
        pool.historyProbes = [];
        for (const seconds of [0, 300, 900, 1800, 3600]) pool.historyProbes.push({ seconds, result: await read(POOL_CANDIDATE, "function observe(uint32[]) view returns(int56[],uint160[])", [[seconds, 0]]) });
        pool.trailingHour = pool.historyProbes.find(probe => probe.seconds === 3600).result;
        pool.referenceWindowReadable = pool.trailingHour.ok;
        pool.feeUnits = "millionths of swap input (official Katana V3 source; deployment behavior still requires fork verification)";
      }
    }
  }
  const canonical = await rpc("eth_getBlockByNumber", [blockTag, false]);
  if (canonical?.hash !== block.hash) throw new Error("INSPECTION_BLOCK_REORGED");
  result.productionReady = false;
  result.notVerified = ["transfer taxes/rebases/permit", "approved router ABI and fees", "wrapped RON official address consistency", "trade-size/impact simulations", "historical oracle suitability", "liquidity floor", "manipulation resistance"];
  return result;
}
if (require.main === module) inspectMarket().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error("Read-only market inspection failed; RPC credentials and private error details are not printed."); process.exitCode = 1; });
module.exports = { inspectMarket, exact, MATT, POOL_CANDIDATE };
