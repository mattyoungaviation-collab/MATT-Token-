"use strict";

const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, isAddress, getAddress, Contract } = require("ethers");
const { APPROVED_TERMS_HASH } = require("./terms-approval");

const ADDRESS_FIELDS = ["multisig", "raffleProxy", "raffleImplementation", "buybackProxy", "buybackImplementation", "matt", "nftCollection", "nftDepositor", "vrfCoordinator", "identitySigner", "keeper"];
const CODE_FIELDS = ["raffleProxy", "raffleImplementation", "buybackProxy", "buybackImplementation", "matt", "vrfCoordinator"];
const SLOTS_VRF_SUBSCRIPTION_ID = "44587871477121098669588994745676805184143715799081698934925948057858200430032";

function validateManifest(manifest, { production = manifest.environment === "production" } = {}) {
  const errors = [];
  if (manifest.schemaVersion !== 2 || manifest.paymentModel !== "RON_AND_HELD_MATT") errors.push("schemaVersion 2 and RON_AND_HELD_MATT payment model are required");
  if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0) errors.push("chainId must be a positive integer");
  if (production && manifest.chainId !== 2020) errors.push("production raffle chainId must be Ronin 2020");
  if (production && manifest.mock) errors.push("production manifest cannot enable mocks");
  if (production && (!isAddress(manifest.emergencyAdmin || "") || manifest.emergencyAdmin === "0x0000000000000000000000000000000000000000" || manifest.emergencyAdminMode !== "full-unilateral-contract-admin")) errors.push("owner-selected nonzero full unilateral emergencyAdmin is required");
  if (production && manifest.indexerFinalityMode !== "rpc-finalized") errors.push("production indexerFinalityMode must be rpc-finalized; verify provider finalized-tag support before enabling indexing");
  if (production && (!/^0x[0-9a-fA-F]{64}$/.test(manifest.termsHash || "") || /^0x0{64}$/.test(manifest.termsHash))) errors.push("approved nonzero no-sale termsHash is required");
  else if (production && manifest.termsHash.toLowerCase() !== APPROVED_TERMS_HASH.toLowerCase()) errors.push("production termsHash must match the exact owner-approved no-sale terms");
  if (production && (!Number.isInteger(manifest.vrfCallbackGasLimit) || manifest.vrfCallbackGasLimit < 100000)) errors.push("measured vrfCallbackGasLimit is required");
  const subscriptionVrf = manifest.vrfMode === "chainlink-v2.5-subscription";
  if (production && !subscriptionVrf && !/^[1-9][0-9]*$/.test(String(manifest.vrfGasPrice || ""))) errors.push("exact nonzero vrfGasPrice is required");
  if (subscriptionVrf) {
    if (manifest.vrfGasPrice !== "0") errors.push("subscription VRF requires zero manager vrfGasPrice");
    if (!isAddress(manifest.vrfUnderlyingCoordinator || "")) errors.push("vrfUnderlyingCoordinator must be a valid address");
    if (!isAddress(manifest.vrfSubscriptionOwner || "") || manifest.vrfSubscriptionOwner === "0x0000000000000000000000000000000000000000") errors.push("vrfSubscriptionOwner must be a nonzero address");
    if (!/^[1-9][0-9]*$/.test(String(manifest.vrfSubscriptionId || ""))) errors.push("dedicated vrfSubscriptionId is required");
    if (String(manifest.vrfSubscriptionId) === SLOTS_VRF_SUBSCRIPTION_ID) errors.push("DYNO cannot spend the existing Slots VRF subscription");
    if (!/^0x[0-9a-fA-F]{64}$/.test(manifest.vrfKeyHash || "") || /^0x0{64}$/.test(manifest.vrfKeyHash || "")) errors.push("nonzero vrfKeyHash is required");
    if (!Number.isInteger(manifest.vrfConfirmations) || manifest.vrfConfirmations < 3 || manifest.vrfConfirmations > 200) errors.push("vrfConfirmations must be 3-200");
    if (!Number.isInteger(manifest.vrfAdapterCallbackGasLimit) || !Number.isInteger(manifest.vrfMaximumConsumerGasLimit) || manifest.vrfAdapterCallbackGasLimit <= manifest.vrfMaximumConsumerGasLimit || manifest.vrfMaximumConsumerGasLimit < manifest.vrfCallbackGasLimit) errors.push("VRF adapter gas limits must cover the measured manager callback");
    if (manifest.operationsBudget !== "0") errors.push("manager operationsBudget must be zero in subscription mode; fund the dedicated subscription separately");
  }
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
    if (!subscriptionVrf && BigInt(manifest.operationsBudget || 0) <= 0n) errors.push("operationsBudget must be nonzero");
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
  if (manifest.vrfMode === "chainlink-v2.5-subscription") {
    try {
      if (await provider.getCode(manifest.vrfUnderlyingCoordinator) === "0x") throw new Error("underlying coordinator has no code");
      const coordinator = new Contract(manifest.vrfUnderlyingCoordinator, ["function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)", "function s_config() view returns(uint16 minimumRequestConfirmations,uint32 maxGasLimit,uint32 stalenessSeconds,uint32 gasAfterPaymentCalculation,int256 fallbackWeiPerUnitLink,uint32 fulfillmentFlatFeeNativePPM,uint32 fulfillmentFlatFeeLinkDiscountPPM,uint8 nativePremiumPercentage,uint8 linkPremiumPercentage)", "function s_provingKeyHashes(uint256) view returns(bytes32)"], provider);
      const sub = await coordinator.getSubscription(manifest.vrfSubscriptionId);
      if (sub.subOwner.toLowerCase() !== manifest.vrfSubscriptionOwner.toLowerCase()) errors.push("dedicated VRF subscription owner mismatch");
      if (sub.nativeBalance === 0n) errors.push("dedicated VRF subscription has no native RON balance");
      const config = await coordinator.s_config();
      if (manifest.vrfAdapterCallbackGasLimit > Number(config.maxGasLimit)) errors.push("VRF adapter callback gas exceeds coordinator limit");
      let registeredKey = false;
      for (let index = 0; index < 32; index++) {
        try { if ((await coordinator.s_provingKeyHashes(index)).toLowerCase() === manifest.vrfKeyHash.toLowerCase()) registeredKey = true; }
        catch { break; }
      }
      if (!registeredKey) errors.push("VRF key hash is not registered with the coordinator");
      if (isAddress(manifest.vrfCoordinator || "") && await provider.getCode(manifest.vrfCoordinator) !== "0x") {
        const adapter = new Contract(manifest.vrfCoordinator, ["function consumer() view returns(address)", "function vrfCoordinator() view returns(address)", "function subscriptionId() view returns(uint256)"], provider);
        if ((await adapter.consumer()).toLowerCase() !== manifest.raffleProxy.toLowerCase()) errors.push("VRF adapter is not bound to DYNO manager");
        if ((await adapter.vrfCoordinator()).toLowerCase() !== manifest.vrfUnderlyingCoordinator.toLowerCase() || (await adapter.subscriptionId()) !== BigInt(manifest.vrfSubscriptionId)) errors.push("VRF adapter coordinator/subscription mismatch");
        if (!sub.consumers.some(value => value.toLowerCase() === manifest.vrfCoordinator.toLowerCase())) errors.push("DYNO VRF adapter is not registered as subscription consumer");
      }
    } catch { errors.push("dedicated VRF subscription/coordinator could not be verified"); }
  }
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
