"use strict";

const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, isAddress, getAddress, Contract } = require("ethers");

const ADDRESS_FIELDS = ["multisig", "raffleProxy", "raffleImplementation", "buybackProxy", "buybackImplementation", "matt", "nftCollection", "nftDepositor", "vrfCoordinator", "identitySigner", "keeper"];
const CODE_FIELDS = ["raffleProxy", "raffleImplementation", "buybackProxy", "buybackImplementation", "matt", "vrfCoordinator"];

function validateManifest(manifest, { production = manifest.environment === "production" } = {}) {
  const errors = [];
  if (manifest.schemaVersion !== 2 || manifest.paymentModel !== "RON_AND_HELD_MATT") errors.push("schemaVersion 2 and RON_AND_HELD_MATT payment model are required");
  if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0) errors.push("chainId must be a positive integer");
  if (production && manifest.chainId !== 2020) errors.push("production raffle chainId must be Ronin 2020");
  if (production && manifest.mock) errors.push("production manifest cannot enable mocks");
  if (production && (!isAddress(manifest.emergencyAdmin || "") || manifest.emergencyAdmin === "0x0000000000000000000000000000000000000000" || manifest.emergencyAdminMode !== "full-unilateral-contract-admin")) errors.push("owner-selected nonzero full unilateral emergencyAdmin is required");
  if (production && manifest.indexerFinalityMode !== "rpc-finalized") errors.push("production indexerFinalityMode must be rpc-finalized; verify provider finalized-tag support before enabling indexing");
  if (production && (!/^0x[0-9a-fA-F]{64}$/.test(manifest.termsHash || "") || /^0x0{64}$/.test(manifest.termsHash))) errors.push("approved nonzero no-sale termsHash is required");
  if (production && (!Number.isInteger(manifest.vrfCallbackGasLimit) || manifest.vrfCallbackGasLimit < 100000)) errors.push("measured vrfCallbackGasLimit is required");
  if (production && !/^[1-9][0-9]*$/.test(String(manifest.vrfGasPrice || ""))) errors.push("exact nonzero vrfGasPrice is required");
  if (manifest.prizeDelivery !== "manual") errors.push("prizeDelivery must be manual for the owner-selected delivery implementation");
  if (!Number.isSafeInteger(manifest.nftChainId) || manifest.nftChainId <= 0) errors.push("nftChainId must identify the external NFT delivery chain");
  if (!manifest.nftRpcUrlEnv) errors.push("nftRpcUrlEnv is required for manual NFT receipt verification");
  if (!Number.isSafeInteger(manifest.nftFinalityBlocks) || manifest.nftFinalityBlocks < (production ? 12 : 1)) errors.push("nftFinalityBlocks is insufficient for delivery verification");
  if (production && (manifest.multisigThreshold !== 2 || manifest.multisigOwnerCount !== 3)) errors.push("owner-selected multisig must be 2-of-3");
  for (const field of ADDRESS_FIELDS) {
    const value = manifest[field];
    if (!isAddress(value || "") || getAddress(value) === "0x0000000000000000000000000000000000000000") errors.push(`${field} must be a nonzero address`);
  }
  for (const field of ["operationsBudget", "discordGuildId", "discordApplicationId", "publicOAuthRedirectUri"]) {
    if (manifest[field] === null || manifest[field] === undefined || String(manifest[field]).trim() === "") errors.push(`${field} is required`);
  }
  if (!Number.isInteger(manifest.mattDecimals) || manifest.mattDecimals < 0 || manifest.mattDecimals > 36) errors.push("mattDecimals is invalid");
  const round = manifest.round || {};
  const baseUnitString = value => typeof value === "string" && /^\d+$/.test(value);
  for (const [field, value] of Object.entries({
    operationsBudget: manifest.operationsBudget,
    "round.ticketRon": round.ticketRon, "round.ticketMatt": round.ticketMatt,
    "round.nextDynoReserve": round.nextDynoReserve,
  })) if (!baseUnitString(value)) errors.push(`${field} must be an exact decimal base-unit string`);
  if (!Array.isArray(round.ronPrizes) || round.ronPrizes.some(value => !baseUnitString(value))) errors.push("round.ronPrizes must contain exact decimal base-unit strings");
  try {
    if (round.capacity !== 1000) errors.push("round.capacity must be exactly 1000");
    if (BigInt(round.ticketRon) !== 35n * 10n ** 18n) errors.push("ticketRon must be exactly 35 RON");
    if (BigInt(round.ticketMatt) !== 700000n * 10n ** BigInt(manifest.mattDecimals)) errors.push("ticketMatt must be exactly 700,000 MATT");
    const prizes = (round.ronPrizes || []).map(BigInt);
    const reserve = BigInt(round.nextDynoReserve);
    if (reserve !== 10000n * 10n ** 18n) errors.push("nextDynoReserve must be exactly 10,000 RON for this round");
    if (prizes.length !== 5) errors.push("exactly five RON prizes are required");
    else {
      if (prizes.some((value, index) => value <= 0n || (index > 0 && value <= prizes[index - 1]))) errors.push("RON prizes must be positive and strictly ascending in draw order");
      const total = prizes.reduce((sum, value) => sum + value, 0n);
      if (total + reserve > BigInt(round.ticketRon) * 1000n) errors.push("prizes plus reserve exceed direct receipts");
    }
    if (BigInt(manifest.operationsBudget || 0) <= 0n) errors.push("operationsBudget must be nonzero");
  } catch (error) { errors.push(`integer field is malformed: ${error.message}`); }
  if (round.reviewDurationSeconds < 86400) errors.push("reviewDurationSeconds must be at least 86400");
  for (const field of ["saleSlippageBps", "buybackSlippageBps"]) if (round[field] !== 0) errors.push(`${field} must be zero when no swaps occur`);
  for (const field of ["swapAdapter", "priceGuard"]) if (manifest[field] !== null && manifest[field] !== undefined) errors.push(`${field} must be null in the no-sale model`);
  return errors;
}

async function validateOnChain(manifest) {
  const rpcUrl = process.env[manifest.rpcUrlEnv];
  if (!rpcUrl) return [`${manifest.rpcUrlEnv} is required for --onchain validation`];
  const provider = new JsonRpcProvider(rpcUrl, manifest.chainId, { staticNetwork: true });
  const errors = [];
  const actualChainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (actualChainId !== manifest.chainId) return [`RPC chain mismatch: got ${actualChainId}`];
  for (const field of CODE_FIELDS) if (isAddress(manifest[field] || "") && await provider.getCode(manifest[field]) === "0x") errors.push(`${field} has no deployed code`);
  if (isAddress(manifest.multisig || "")) {
    try {
      const safe = new Contract(manifest.multisig, ["function getThreshold() view returns(uint256)", "function getOwners() view returns(address[])"], provider);
      if (Number(await safe.getThreshold()) !== manifest.multisigThreshold) errors.push("multisig threshold differs from manifest");
      if ((await safe.getOwners()).length !== manifest.multisigOwnerCount) errors.push("multisig owner count differs from manifest");
    } catch { errors.push("multisig threshold/owners could not be verified"); }
  }
  if (isAddress(manifest.nftCollection || "")) {
    try {
      const nftRpc = process.env[manifest.nftRpcUrlEnv];
      if (manifest.nftChainId !== manifest.chainId && !nftRpc) throw new Error("external NFT RPC is missing");
      const nftProvider = manifest.nftChainId === manifest.chainId ? provider : new JsonRpcProvider(nftRpc);
      if (Number(BigInt(await nftProvider.send("eth_chainId", []))) !== manifest.nftChainId) throw new Error("NFT RPC chain mismatch");
      if (await nftProvider.getCode(manifest.nftCollection) === "0x") throw new Error("NFT collection has no code on its delivery chain");
      const nft = new Contract(manifest.nftCollection, ["function supportsInterface(bytes4) view returns(bool)", "function ownerOf(uint256) view returns(address)"], nftProvider);
      if (!await nft.supportsInterface("0x80ac58cd")) errors.push("NFT collection does not report ERC721 support");
      const owner = (await nft.ownerOf(manifest.nftTokenId)).toLowerCase();
      if (owner !== manifest.nftDepositor.toLowerCase()) errors.push("NFT is not held by the declared manual depositor before opening");
    } catch { errors.push("NFT standard/ownership/RPC could not be verified on its manual delivery chain"); }
  }
  if (!errors.length) {
    try {
      const token = new Contract(manifest.matt, ["function decimals() view returns(uint8)"], provider);
      if (Number(await token.decimals()) !== manifest.mattDecimals) errors.push("MATT decimals do not match on-chain value");
    } catch (error) { errors.push(`MATT decimals read failed: ${error.shortMessage || error.message}`); }
  }
  return errors;
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node scripts/dyno/validate-manifest.js <manifest.json> [--onchain]");
  const manifest = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
  const errors = validateManifest(manifest);
  if (process.argv.includes("--onchain")) errors.push(...await validateOnChain(manifest));
  if (errors.length) {
    console.error(`Project DYNO manifest rejected (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Project DYNO ${manifest.environment} manifest is structurally valid${process.argv.includes("--onchain") ? " and matches chain reads" : " (on-chain checks not requested)"}.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateManifest, validateOnChain };
