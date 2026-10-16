"use strict";

const fs = require("fs");
const { JsonRpcProvider, Interface } = require("ethers");
const { createStore } = require("../dyno-api/store");

function jsonExact(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonExact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^\d+$/.test(key)).map(([key, item]) => [key, jsonExact(item)]));
  return value;
}
function eventKey(chainId, log) { return `${chainId}:${log.transactionHash.toLowerCase()}:${log.index}`; }

class DynoIndexer {
  constructor({ rpcUrl, chainId, managerAddress, vaultAddress, databaseUrl, store, provider, env = process.env, startBlock = 0, finalityBlocks = 12, finalityMode = env.NODE_ENV === "production" ? "rpc-finalized" : "confirmations", managerAbi, vaultAbi }) {
    if (![chainId, startBlock, finalityBlocks].every(n => Number.isSafeInteger(n) && n >= 0) || chainId === 0 || finalityBlocks < 1) throw new Error("Invalid indexer chain/start/finality configuration");
    if (!["rpc-finalized", "confirmations"].includes(finalityMode) || (env.NODE_ENV === "production" && finalityMode !== "rpc-finalized")) throw new Error("Production indexer requires the RPC finalized block policy; confirmations are local/test only");
    this.provider = provider || new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    this.chainId = chainId; this.addresses = [managerAddress, vaultAddress].map(value => value.toLowerCase());
    this.store = store || createStore({ connectionString: databaseUrl, production: env.NODE_ENV === "production", env, chainId }); this.ownsStore = !store;
    if (!this.store.applyBatch) throw new Error("Indexer requires durable sqlite or postgres storage");
    this.startBlock = startBlock; this.finalityBlocks = finalityBlocks; this.finalityMode = finalityMode;
    this.interfaces = [new Interface(managerAbi), new Interface(vaultAbi)];
  }
  parse(log) {
    for (const iface of this.interfaces) { try { const parsed = iface.parseLog(log); if (parsed) return { name: parsed.name, payload: Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name || `arg${index}`, jsonExact(parsed.args[index])])) }; } catch {} }
    return { name: "Unknown", payload: { topics: log.topics, data: log.data } };
  }
  async checkpoint() {
    return this.store.checkpoint(this.chainId);
  }
  async reconcileReorg(checkpoint) {
    if (!checkpoint) return this.startBlock - 1;
    const number = Number(checkpoint.block_number), block = await this.provider.getBlock(number);
    if (!block) throw new Error("Checkpoint block unavailable; refusing destructive reconciliation");
    if (block.hash.toLowerCase() === `0x${checkpoint.hash}`.toLowerCase()) return number;
    let ancestor = this.startBlock - 1;
    for (const candidate of await this.store.anchors(this.chainId, number)) {
      if (candidate.block_number < this.startBlock) break;
      const canonical = await this.provider.getBlock(candidate.block_number);
      if (!canonical) throw new Error("Ancestor block unavailable; refusing destructive reconciliation");
      if (canonical.hash.toLowerCase() === candidate.block_hash.toLowerCase()) { ancestor = candidate.block_number; break; }
    }
    await this.store.rollback(this.chainId, ancestor);
    return ancestor;
  }
  async syncOnce(batchSize = 1000) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("Indexer batch must be 1..1000");
    if (Number(BigInt(await this.provider.send("eth_chainId", []))) !== this.chainId) throw new Error("Indexer RPC chain mismatch");
    // Resolve the accepted head before any destructive reconciliation. A missing
    // finalized tag never silently becomes latest-minus-N or a wall-clock guess.
    let finalizedHead, finalizedBlock;
    if (this.finalityMode === "rpc-finalized") {
      finalizedBlock = await this.provider.getBlock("finalized");
      if (!finalizedBlock?.hash || !Number.isSafeInteger(finalizedBlock.number) || finalizedBlock.number < 0) throw new Error("Finalized block unavailable");
      const canonical = await this.provider.getBlock(finalizedBlock.number);
      if (canonical?.hash !== finalizedBlock.hash) throw new Error("Finalized block is not canonical");
      finalizedHead = Math.max(this.startBlock - 1, finalizedBlock.number);
    } else finalizedHead = Math.max(this.startBlock - 1, (await this.provider.getBlockNumber()) - this.finalityBlocks);
    const checkpoint = await this.checkpoint();
    if (checkpoint && Number(checkpoint.block_number) > finalizedHead) throw new Error("RPC accepted head behind checkpoint; refusing destructive reconciliation");
    const ancestor = await this.reconcileReorg(checkpoint);
    const from = Math.max(this.startBlock, ancestor + 1); if (from > finalizedHead) return { from, to: finalizedHead, logs: 0, head: finalizedHead };
    const to = Math.min(finalizedHead, from + batchSize - 1);
    const block = await this.provider.getBlock(to);
    if (!block?.hash) throw new Error("Indexer batch block unavailable");
    const logs = await this.provider.getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
    const hashes = new Map();
    for (const log of logs) {
      if (log.removed || log.blockNumber < from || log.blockNumber > to || !this.addresses.includes(log.address.toLowerCase())) throw new Error("Indexer received an invalid log");
      if (!hashes.has(log.blockNumber)) hashes.set(log.blockNumber, (await this.provider.getBlock(log.blockNumber))?.hash);
      if (!hashes.get(log.blockNumber) || hashes.get(log.blockNumber).toLowerCase() !== log.blockHash.toLowerCase()) throw new Error("Indexer log no longer canonical");
    }
    if ((await this.provider.getBlock(to))?.hash !== block.hash) throw new Error("Indexer batch reorged before commit");
    if (finalizedBlock && (await this.provider.getBlock(finalizedBlock.number))?.hash !== finalizedBlock.hash) throw new Error("Finalized anchor changed before commit");
    await this.store.applyBatch(this.chainId, logs.map(log => ({ ...log, ...this.parse(log) })), block);
    return { from, to, logs: logs.length, head: finalizedHead };
  }
  async close() { if (this.ownsStore) await this.store.close(); }
}

async function main() {
  const manager = require("../../packages/abis/ProjectDynoRaffleManager.json");
  const vault = require("../../packages/abis/ProjectDynoBuybackVault.json");
  const indexer = new DynoIndexer({ rpcUrl: process.env.DYNO_RPC_URL, chainId: Number(process.env.DYNO_CHAIN_ID), managerAddress: process.env.DYNO_RAFFLE_ADDRESS, vaultAddress: process.env.DYNO_BUYBACK_ADDRESS, databaseUrl: process.env.DATABASE_URL, startBlock: Number(process.env.DYNO_START_BLOCK || 0), finalityBlocks: Number(process.env.DYNO_FINALITY_BLOCKS || 12), finalityMode: process.env.DYNO_FINALITY_MODE || (process.env.NODE_ENV === "production" ? "rpc-finalized" : "confirmations"), managerAbi: manager.abi, vaultAbi: vault.abi });
  const result = await indexer.syncOnce(Number(process.env.DYNO_INDEX_BATCH || 1000)); await indexer.close(); console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(() => { console.error("Project DYNO indexer failed; check configuration and RPC health (private details redacted)"); process.exitCode = 1; });
module.exports = { DynoIndexer, jsonExact, eventKey };
