"use strict";

// Exercises the deployed MATT token against a raffle deployed only inside an
// ephemeral Hardhat fork. This script cannot broadcast to Ronin.
const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { installForkRuntimeCompatibility } = require("./fork-runtime-compat");

async function main() {
  if (hre.network.name !== "hardhat") throw new Error("FORK_ONLY_NO_LIVE_NETWORK");
  const block = Number(process.env.DYNO_FORK_BLOCK);
  if (!process.env.DYNO_FORK_RPC_URL || !process.env.DYNO_FORK_MANIFEST || !Number.isSafeInteger(block) || block < 43254600) {
    throw new Error("PINNED_RONIN_FORK_CONFIGURATION_REQUIRED");
  }
  if (hre.config.networks.hardhat.forking?.blockNumber !== block) throw new Error("FORK_BLOCK_MISMATCH");
  await installForkRuntimeCompatibility(hre);
  const { ethers, network } = hre;
  await network.provider.request({ method: "eth_chainId", params: [] });
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.env.DYNO_FORK_MANIFEST), "utf8"));
  if (manifest.chainId !== 2020 || manifest.paymentModel !== "RON_AND_HELD_MATT") throw new Error("WRONG_SOURCE_CONFIGURATION");
  const source = new ethers.JsonRpcProvider(process.env.DYNO_FORK_RPC_URL, 2020, { staticNetwork: true, batchMaxCount: 1 });
  if (Number(BigInt(await source.send("eth_chainId", []))) !== 2020 || !(await source.getBlock(block))?.hash) throw new Error("WRONG_OR_MISSING_SOURCE_BLOCK");
  if (await source.getCode(manifest.matt, block) === "0x") throw new Error("MATT_HAS_NO_SOURCE_CODE");

  const [admin, identitySigner, reviewer, treasury, keeper] = await ethers.getSigners();
  const originalWallet = manifest.nftDepositor;
  await network.provider.send("hardhat_impersonateAccount", [originalWallet]);
  await network.provider.send("hardhat_setBalance", [originalWallet, ethers.toBeHex(ethers.parseEther("100"))]);
  const buyer = await ethers.getSigner(originalWallet);
  const token = new ethers.Contract(manifest.matt, [
    "function balanceOf(address) view returns(uint256)",
    "function decimals() view returns(uint8)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
  ], buyer);
  const ticketMatt = ethers.parseEther("700000");
  const originalMatt = await token.balanceOf(originalWallet);
  if (Number(await token.decimals()) !== 18 || originalMatt < ticketMatt) throw new Error("SOURCE_WALLET_CANNOT_FUND_ONE_TICKET");

  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const managerProxyAddress = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 3 });
  const Vault = await ethers.getContractFactory("ProjectDynoBuybackVault");
  const Manager = await ethers.getContractFactory("ProjectDynoRaffleManager");
  const Proxy = await ethers.getContractFactory("ProjectDynoProxy");
  const vaultImplementation = await Vault.deploy();
  const managerImplementation = await Manager.deploy();
  const vaultAddress = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
  const vault = await Proxy.deploy(vaultImplementation.target, Vault.interface.encodeFunctionData("initialize", [admin.address, managerProxyAddress, keeper.address]));
  const managerProxy = await Proxy.deploy(managerImplementation.target, Manager.interface.encodeFunctionData("initialize", [admin.address, identitySigner.address, vaultAddress, reviewer.address]));
  if (vault.target.toLowerCase() !== vaultAddress.toLowerCase() || managerProxy.target.toLowerCase() !== managerProxyAddress.toLowerCase()) throw new Error("PROXY_ADDRESS_MISMATCH");
  const manager = Manager.attach(managerProxy.target);
  const RefundReceiver = await ethers.getContractFactory("ProjectDynoVRFRefundReceiver");
  const receiver = await RefundReceiver.deploy(managerProxy.target);
  await (await manager.setVrfRefundReceiver(receiver.target)).wait();
  const MockVRF = await ethers.getContractFactory("MockRoninVRFCoordinator");
  const vrf = await MockVRF.deploy();

  const ron = ethers.parseEther;
  await (await manager.createRound({
    matt: manifest.matt, nftCollection: manifest.nftCollection, nftTokenId: 1358,
    nftDepositor: originalWallet, treasury: treasury.address, swapAdapter: ethers.ZeroAddress,
    priceGuard: ethers.ZeroAddress, vrfCoordinator: vrf.target,
    ticketRon: ron("35"), ticketMatt, capacity: 1000,
    ronPrizes: ["70.2247", "140.4494", "1404.4944", "3511.2360", "7022.4719"].map(ron),
    nextDynoReserve: ron("10000"), saleSlippageBps: 0, buybackSlippageBps: 0,
    reviewDuration: 86400, vrfCallbackGasLimit: 250000, vrfGasPrice: 22000000000,
    minimumOperationsFunding: ron("0.02"), termsHash: manifest.termsHash,
  }, 1)).wait();
  await (await manager.fundOperations(1, { value: ron("0.02") })).wait();
  await (await manager.openRound(1)).wait();
  const allowance = await token.allowance(originalWallet, manager.target);
  if (allowance !== 0n) await (await token.approve(manager.target, 0)).wait();
  await (await token.approve(manager.target, ticketMatt)).wait();

  const timestamp = (await ethers.provider.getBlock("latest")).timestamp;
  const dayIndex = Math.floor(timestamp / 86400);
  const voucher = {
    roundId: 1, accountCommitment: ethers.id("fork-only-discord-account"), wallet: originalWallet,
    quantity: 1, identityVersion: 1, nonce: ethers.id("fork-only-voucher"), dayIndex,
    expiry: Math.min(timestamp + 300, (dayIndex + 1) * 86400 - 1),
  };
  const domain = { name: "Project DYNO", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: manager.target };
  const types = { PurchaseVoucher: [
    { name: "roundId", type: "uint256" }, { name: "accountCommitment", type: "bytes32" },
    { name: "wallet", type: "address" }, { name: "quantity", type: "uint8" },
    { name: "identityVersion", type: "uint32" }, { name: "nonce", type: "bytes32" },
    { name: "dayIndex", type: "uint64" }, { name: "expiry", type: "uint64" },
  ] };
  const signature = await identitySigner.signTypedData(domain, types, voucher);
  await (await manager.connect(buyer).buyTickets(voucher, signature, { value: ron("35") })).wait();
  const afterBuy = await token.balanceOf(originalWallet);
  const managerAfterBuy = await token.balanceOf(manager.target);
  if (originalMatt - afterBuy !== ticketMatt || managerAfterBuy !== ticketMatt) throw new Error("MATT_PURCHASE_NOT_EXACT");
  const ticket = await manager.getTicket(1);
  if (ticket.originalWallet.toLowerCase() !== originalWallet.toLowerCase() || ticket.saleRon !== 0n) throw new Error("TICKET_LEDGER_MISMATCH");

  await (await manager.disqualifyTicket(1, ethers.id("FORK_TEST_ONLY"), ethers.id("FORK_TEST_EVIDENCE"))).wait();
  await (await manager.connect(buyer).claimRefund(1)).wait();
  if (await token.balanceOf(originalWallet) !== originalMatt || await token.balanceOf(manager.target) !== 0n) throw new Error("MATT_REFUND_NOT_EXACT");
  console.log(JSON.stringify({ forkOnly: true, sourceChainId: 2020, sourceBlock: block, paymentModel: manifest.paymentModel,
    purchaseMatt: ticketMatt.toString(), refundMatt: ticketMatt.toString(), ticketSaleRon: "0", exactInboundAndOutbound: true,
    liveTransactionSent: false }));
}

main().catch(() => { console.error("Fork MATT transfer/refund check failed; RPC details withheld"); process.exitCode = 1; });
