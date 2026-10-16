"use strict";
// Unsigned CREATE plan only. No provider, signer, private key or broadcast path.
const fs = require("fs");
const path = require("path");
const { ContractFactory, Interface, getCreateAddress, isAddress, ZeroAddress, id, keccak256 } = require("ethers");
const { validateManifest } = require("./validate-manifest");
const { validateApprovedTerms } = require("./terms-approval");
function artifact(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, `../../artifacts/contracts/dyno/${name}.sol/${name}.json`), "utf8")); }
function buildPlan(input, deployer, nonce) {
  if (!isAddress(deployer || "") || deployer.toLowerCase() === ZeroAddress) throw new Error("A nonzero public deployer address is required, not a private key.");
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > Number.MAX_SAFE_INTEGER - 5) throw new Error("An exact nonnegative deployment nonce is required.");
  // The legacy vault is initialized for ABI/storage compatibility but never receives ticket funds.
  const names = ["ProjectDynoBuybackVault", "ProjectDynoRaffleManager", "ProjectDynoProxy", "ProjectDynoProxy", "ProjectDynoVRFRefundReceiver"];
  const predicted = names.map((_, i) => getCreateAddress({ from: deployer, nonce: nonce + i }));
  const manifest = { ...input, swapAdapter: null, priceGuard: null, buybackImplementation: predicted[0], raffleImplementation: predicted[1], buybackProxy: predicted[2], raffleProxy: predicted[3], vrfRefundReceiver: predicted[4] };
  const errors = validateManifest(manifest);
  if (manifest.environment === "production") errors.push(...validateApprovedTerms(manifest.termsHash));
  for (const field of ["reviewer", "backupKeeper"]) if (!isAddress(manifest[field] || "") || manifest[field].toLowerCase() === ZeroAddress) errors.push(`${field} must be a nonzero address`);
  if (manifest.operatorApprovalStatus !== "approved") errors.push("reviewer, identity signer and primary/backup keepers require owner approval");
  if (manifest.environment === "production" && (!isAddress(manifest.emergencyAdmin || "") || manifest.emergencyAdmin.toLowerCase() === ZeroAddress || manifest.emergencyAdminMode !== "full-unilateral-contract-admin")) errors.push("owner-approved full unilateral emergencyAdmin is required");
  if (isAddress(manifest.keeper || "") && isAddress(manifest.backupKeeper || "") && manifest.keeper.toLowerCase() === manifest.backupKeeper.toLowerCase()) errors.push("primary and backup keepers must use separate wallets");
  for (const field of ["keeper", "backupKeeper", "identitySigner"]) if (isAddress(manifest[field] || "") && manifest[field].toLowerCase() === String(manifest.multisig).toLowerCase()) errors.push(`${field} cannot reuse the treasury multisig`);
  if (!Number.isInteger(manifest.vrfCallbackGasLimit) || manifest.vrfCallbackGasLimit < 100000) errors.push("measured vrfCallbackGasLimit is required");
  if (!/^\d+$/.test(String(manifest.vrfGasPrice || "")) || BigInt(manifest.vrfGasPrice || 0) < 21000000000n) errors.push("vrfGasPrice must be an exact integer at least 21 GWEI, checked against current base fee");
  if (!/^0x[0-9a-fA-F]{64}$/.test(manifest.termsHash || "") || /^0x0{64}$/.test(manifest.termsHash)) errors.push("approved nonzero termsHash is required");
  const header = { dryRun: true, broadcast: false, targetChainId: manifest.chainId, deployer, startingNonce: nonce, predictedAddressesOnly: true, readyForReview: false };
  if (errors.length) return { ...header, blockers: errors, transactions: [], warning: "Nothing deployed. Predicted addresses must never be published as existing contracts." };
  const vault = artifact(names[0]), manager = artifact(names[1]);
  for (const implementation of [vault, manager]) if ((implementation.deployedBytecode.length - 2) / 2 > 24576) throw new Error("Implementation exceeds EIP-170 code-size limit");
  const vInit = new Interface(vault.abi).encodeFunctionData("initialize", [manifest.multisig, predicted[3], manifest.keeper]);
  const rInit = new Interface(manager.abi).encodeFunctionData("initialize", [manifest.multisig, manifest.identitySigner, predicted[2], manifest.reviewer]);
  const argumentsList = [
    [], [], [predicted[0], vInit], [predicted[1], rInit], [predicted[3]]
  ];
  // ContractFactory encodes deployment bytes locally. No wallet or provider is attached.
  const transactions = names.map((name, i) => {
    const a = artifact(name), factory = new ContractFactory(a.abi, a.bytecode);
    const data = a.bytecode + factory.interface.encodeDeploy(argumentsList[i]).slice(2);
    return { order: i, contract: name, chainId: manifest.chainId, from: deployer, nonce: nonce + i, to: null, value: "0", data, initCodeHash: keccak256(data), predictedAddress: predicted[i], meaning: i === 2 || i === 3 ? "ERC1967 proxy with atomic initializer; no uninitialized proxy window" : "Deploy implementation or VRF refund receiver; does not open sales" };
  });
  const managerInterface = new Interface(manager.abi);
  const safeActions = [{ to: predicted[3], value: "0", data: managerInterface.encodeFunctionData("setVrfRefundReceiver", [predicted[4]]), meaning: "Bind the immutable VRF refund receiver to the raffle; requestDraw remains unavailable until this executes" }];
  if (manifest.emergencyAdmin) {
    safeActions.push({ to: predicted[3], value: "0", data: managerInterface.encodeFunctionData("setEmergencyAdmin", [manifest.emergencyAdmin]), meaning: "Activate unilateral emergency admin for raffle and vault; can bypass 2-of-3 and upgrade active logic. No asset withdrawal or transfer is performed by this grant." });
  }
  const round = manifest.round;
  const config = {
    matt: manifest.matt, nftCollection: manifest.nftCollection, nftTokenId: manifest.nftTokenId, nftDepositor: manifest.nftDepositor,
    treasury: manifest.multisig, swapAdapter: ZeroAddress, priceGuard: ZeroAddress, vrfCoordinator: manifest.vrfCoordinator,
    ticketRon: round.ticketRon, ticketMatt: round.ticketMatt, capacity: round.capacity, ronPrizes: round.ronPrizes,
    nextDynoReserve: round.nextDynoReserve, saleSlippageBps: round.saleSlippageBps, buybackSlippageBps: round.buybackSlippageBps,
    reviewDuration: round.reviewDurationSeconds, vrfCallbackGasLimit: manifest.vrfCallbackGasLimit, vrfGasPrice: manifest.vrfGasPrice,
    minimumOperationsFunding: manifest.operationsBudget, termsHash: manifest.termsHash
  };
  safeActions.push({ to: predicted[3], value: "0", data: managerInterface.encodeFunctionData("createRound", [config, manifest.nftChainId]), meaning: "Create no-sale draft round with manual prize delivery and published fixed quantities; not open for purchases" });
  return { ...header, readyForReview: true, blockers: [], transactions, safeActions, proposedManifest: manifest, warning: "Unsigned preparation only. No live deployment authorized. Re-read nonce/code/finality/NFT ownership/VRF fee, simulate transactions, verify UUPS storage and implementations before execution. Opening and funding are intentionally separate." };
}
if (require.main === module) {
  try {
    const [file, deployer, nonce] = process.argv.slice(2);
    if (!file || nonce === undefined) throw new Error("Usage: node scripts/dyno/prepare-deployment.js <manifest.json> <public-deployer-address> <nonce>");
    const result = buildPlan(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")), deployer, Number(nonce));
    console.log(JSON.stringify(result, null, 2)); if (result.blockers.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildPlan };
