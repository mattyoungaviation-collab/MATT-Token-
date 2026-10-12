"use strict";

const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, isAddress, getAddress, Contract } = require("ethers");

const ADDRESS_FIELDS = ["multisig", "raffleProxy", "raffleImplementation", "buybackProxy", "buybackImplementation", "matt", "wron", "router", "pool", "swapAdapter", "priceGuard", "nftCollection", "nftDepositor", "vrfCoordinator", "identitySigner", "keeper"];
const CODE_FIELDS = ["raffleProxy", "raffleImplementation", "buybackProxy", "buybackImplementation", "matt", "wron", "router", "pool", "swapAdapter", "priceGuard", "vrfCoordinator"];

function validateManifest(manifest, { production = manifest.environment === "production" } = {}) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0) errors.push("chainId must be a positive integer");
  if (production && manifest.mock) errors.push("production manifest cannot enable mocks");
  if (manifest.prizeDelivery !== "manual") errors.push("prizeDelivery must be manual for the owner-selected delivery implementation");
  if (!Number.isSafeInteger(manifest.nftChainId) || manifest.nftChainId <= 0) errors.push("nftChainId must identify the external NFT delivery chain");
  if (!manifest.nftRpcUrlEnv) errors.push("nftRpcUrlEnv is required for manual NFT receipt verification");
  if (!Number.isSafeInteger(manifest.nftFinalityBlocks) || manifest.nftFinalityBlocks < (production ? 12 : 1)) errors.push("nftFinalityBlocks is insufficient for delivery verification");
  if (production && (manifest.multisigThreshold !== 2 || manifest.multisigOwnerCount !== 3)) errors.push("owner-selected multisig must be 2-of-3");
  for (const field of ADDRESS_FIELDS) {
    const value = manifest[field];
    if (!isAddress(value || "") || getAddress(value) === "0x0000000000000000000000000000000000000000") errors.push(`${field} must be a nonzero address`);
  }
  for (const field of ["minimumLiquidity", "operationsBudget", "discordGuildId", "discordApplicationId", "publicOAuthRedirectUri"]) {
    if (manifest[field] === null || manifest[field] === undefined || String(manifest[field]).trim() === "") errors.push(`${field} is required`);
  }
  if (!Number.isInteger(manifest.mattDecimals) || manifest.mattDecimals < 0 || manifest.mattDecimals > 36) errors.push("mattDecimals is invalid");
  const round = manifest.round || {};
  try {
    if (round.capacity !== 1000) errors.push("round.capacity must be exactly 1000");
    if (BigInt(round.ticketRon) !== 35n * 10n ** 18n) errors.push("ticketRon must be exactly 35 RON");
    if (BigInt(round.ticketMatt) !== 700000n * 10n ** BigInt(manifest.mattDecimals)) errors.push("ticketMatt must be exactly 700,000 MATT");
    const prizes = (round.ronPrizes || []).map(BigInt);
    if (prizes.length !== 5) errors.push("exactly five RON prizes are required");
    else {
      const expected = ["70224700000000000000", "140449400000000000000", "1404494400000000000000", "3511236000000000000000", "7022471900000000000000"].map(BigInt);
      if (prizes.some((value, index) => value !== expected[index])) errors.push("active prize fixture must be 70.2247, 140.4494, 1,404.4944, 3,511.2360, 7,022.4719 RON");
      const total = prizes.reduce((sum, value) => sum + value, 0n);
      if (total !== 12148876400000000000000n) errors.push("RON prize total must be 12,148.8764");
      if (total + BigInt(round.nextDynoReserve) > BigInt(round.ticketRon) * 1000n) errors.push("prizes plus reserve exceed direct receipts");
    }
    if (BigInt(manifest.minimumLiquidity || 0) <= 0n) errors.push("minimumLiquidity must be nonzero");
    if (BigInt(manifest.operationsBudget || 0) <= 0n) errors.push("operationsBudget must be nonzero");
  } catch (error) { errors.push(`integer field is malformed: ${error.message}`); }
  if (round.reviewDurationSeconds < 86400) errors.push("reviewDurationSeconds must be at least 86400");
  for (const field of ["saleSlippageBps", "buybackSlippageBps"]) if (!Number.isInteger(round[field]) || round[field] < 0 || round[field] > 1000) errors.push(`${field} must be 0..1000`);
  if (manifest.referenceWindowSeconds !== 3600) errors.push("referenceWindowSeconds must be 3600 for the initial manifest");
  if (manifest.maximumDeviationBps !== 1000) errors.push("maximumDeviationBps must be 1000 for the initial manifest");
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
