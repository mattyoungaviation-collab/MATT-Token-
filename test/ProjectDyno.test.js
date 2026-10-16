const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const RON = ethers.parseEther;
const MATT = ethers.parseEther;

async function deployProxyPair() {
  const [admin, identitySigner, reviewer, buyer, treasury, keeper] = await ethers.getSigners();
  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedVaultProxy = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
  const predictedManagerProxy = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 3 });

  const Vault = await ethers.getContractFactory("ProjectDynoBuybackVault");
  const Manager = await ethers.getContractFactory("ProjectDynoRaffleManager");
  const Proxy = await ethers.getContractFactory("ProjectDynoProxy");
  const vaultImpl = await Vault.deploy();
  const managerImpl = await Manager.deploy();
  const vaultInit = Vault.interface.encodeFunctionData("initialize", [admin.address, predictedManagerProxy, keeper.address]);
  const vaultProxy = await Proxy.deploy(await vaultImpl.getAddress(), vaultInit);
  expect(await vaultProxy.getAddress()).to.equal(predictedVaultProxy);
  const managerInit = Manager.interface.encodeFunctionData("initialize", [admin.address, identitySigner.address, predictedVaultProxy, reviewer.address]);
  const managerProxy = await Proxy.deploy(await managerImpl.getAddress(), managerInit);
  expect(await managerProxy.getAddress()).to.equal(predictedManagerProxy);
  const RefundReceiver = await ethers.getContractFactory("ProjectDynoVRFRefundReceiver");
  const refundReceiver = await RefundReceiver.deploy(predictedManagerProxy);
  await Manager.attach(predictedManagerProxy).setVrfRefundReceiver(await refundReceiver.getAddress());
  return {
    admin, identitySigner, reviewer, buyer, treasury, keeper,
    manager: Manager.attach(predictedManagerProxy), vault: Vault.attach(predictedVaultProxy),
    managerImpl, vaultImpl, refundReceiver,
  };
}

function defaultPrizes() {
  return ["70.2247", "140.4494", "1404.4944", "3511.2360", "7022.4719"].map(RON);
}

async function deployRound({ remoteCollection, nftChainId = 31337, open = true } = {}) {
  const fixture = await deployProxyPair();
  const { admin, buyer, treasury, manager } = fixture;
  const Token = await ethers.getContractFactory("MockMattToken");
  const NFT = await ethers.getContractFactory("MockProjectDynoNFT");
  const Guard = await ethers.getContractFactory("MockProjectDynoPriceGuard");
  const Adapter = await ethers.getContractFactory("MockProjectDynoSwapAdapter");
  const Vrf = await ethers.getContractFactory("MockRoninVRFCoordinator");
  const token = await Token.deploy();
  const nft = await NFT.deploy();
  const guard = await Guard.deploy(RON("20"), MATT("30510"));
  const adapter = await Adapter.deploy(await token.getAddress(), RON("20"), MATT("30510"));
  const vrf = await Vrf.deploy();
  await admin.sendTransaction({ to: await adapter.getAddress(), value: RON("500") });
  await token.mint(await adapter.getAddress(), MATT("1000000000"));
  await token.mint(buyer.address, MATT("3000000"));
  await nft.mint(admin.address, 1358);

  const config = {
    matt: await token.getAddress(), nftCollection: remoteCollection || await nft.getAddress(), nftTokenId: 1358,
    nftDepositor: admin.address, treasury: treasury.address, swapAdapter: ethers.ZeroAddress,
    priceGuard: ethers.ZeroAddress, vrfCoordinator: await vrf.getAddress(),
    ticketRon: RON("35"), ticketMatt: MATT("700000"), capacity: 1000, ronPrizes: defaultPrizes(),
    nextDynoReserve: RON("10000"), saleSlippageBps: 0, buybackSlippageBps: 0,
    reviewDuration: 86400, vrfCallbackGasLimit: 250000, vrfGasPrice: 22_000_000_000,
    minimumOperationsFunding: RON("0.02"), termsHash: ethers.keccak256(ethers.toUtf8Bytes("Project DYNO local terms v1")),
  };
  await manager.createRound(config, nftChainId);
  await manager.fundOperations(1, { value: RON("0.02") });
  if (open) await manager.openRound(1);
  return { ...fixture, token, nft, guard, adapter, vrf, config };
}

async function signVoucher(f, quantity, nonce = ethers.randomBytes(32)) {
  const block = await ethers.provider.getBlock("latest");
  const dayIndex = Math.floor(block.timestamp / 86400);
  const expiry = Math.min(block.timestamp + 300, (dayIndex + 1) * 86400 - 1);
  const voucher = {
    roundId: 1, accountCommitment: ethers.keccak256(ethers.toUtf8Bytes("discord:stable-test-id")),
    wallet: f.buyer.address, quantity, identityVersion: 1, nonce: ethers.hexlify(nonce), dayIndex, expiry,
  };
  const networkInfo = await ethers.provider.getNetwork();
  const domain = { name: "Project DYNO", version: "1", chainId: networkInfo.chainId, verifyingContract: await f.manager.getAddress() };
  const types = { PurchaseVoucher: [
    { name: "roundId", type: "uint256" }, { name: "accountCommitment", type: "bytes32" },
    { name: "wallet", type: "address" }, { name: "quantity", type: "uint8" },
    { name: "identityVersion", type: "uint32" }, { name: "nonce", type: "bytes32" },
    { name: "dayIndex", type: "uint64" }, { name: "expiry", type: "uint64" },
  ] };
  return { voucher, signature: await f.identitySigner.signTypedData(domain, types, voucher) };
}

describe("Project DYNO", function () {
  this.timeout(180000);

  it("gives emergency admin unilateral control and immediately rotates/revokes it across manager, vault and guard", async function () {
    const f = await deployRound(), emergency = f.treasury, replacement = f.keeper;
    await expect(f.manager.connect(emergency).setEmergencyAdmin(emergency.address)).to.be.reverted;
    await expect(f.manager.setEmergencyAdmin(emergency.address)).to.emit(f.manager, "EmergencyAdminChanged").withArgs(ethers.ZeroAddress, emergency.address, f.admin.address);
    const factory = await (await ethers.getContractFactory("MockProjectDynoV3Factory")).deploy();
    const pool = await (await ethers.getContractFactory("MockProjectDynoV3Pool")).deploy(factory.target, f.token.target, f.buyer.address, 10000);
    await factory.setPool(pool.target);
    const guard = await (await ethers.getContractFactory("ProjectDynoKatanaV3PriceGuard")).deploy(f.admin.address, f.token.target, f.buyer.address, pool.target, factory.target, 1000);
    await guard.bindGovernanceManager(f.manager.target);
    await expect(guard.bindGovernanceManager(f.manager.target)).to.be.reverted;
    await f.manager.connect(emergency).setSubsystemPaused(ethers.id("CHECKOUT"), true);
    await f.manager.connect(emergency).setReviewer(f.buyer.address, true);
    await f.vault.connect(emergency).setSlippageBps(400);
    await f.vault.connect(emergency).grantRole(await f.vault.KEEPER_ROLE(), f.buyer.address);
    await guard.connect(emergency).setProtection(3600, 2000, 1000);
    expect(await f.vault.hasRole(ethers.ZeroHash, emergency.address)).to.equal(true);
    await expect(f.vault.revokeRole(ethers.ZeroHash, emergency.address)).to.be.revertedWithCustomError(f.vault, "InvalidConfiguration");
    await expect(f.vault.connect(emergency).renounceRole(ethers.ZeroHash, emergency.address)).to.be.revertedWithCustomError(f.vault, "InvalidConfiguration");
    await f.manager.connect(emergency).setEmergencyAdmin(replacement.address);
    expect(await f.vault.hasRole(ethers.ZeroHash, emergency.address)).to.equal(false);
    expect(await guard.isAdmin(emergency.address)).to.equal(false);
    await expect(f.manager.connect(emergency).setSubsystemPaused(ethers.id("CHECKOUT"), false)).to.be.reverted;
    await expect(f.vault.connect(emergency).setSlippageBps(200)).to.be.reverted;
    await expect(guard.connect(emergency).setProtection(3600, 1000, 1000)).to.be.reverted;
    await f.vault.connect(replacement).setSlippageBps(200);
    await f.manager.setEmergencyAdmin(ethers.ZeroAddress);
    await expect(f.vault.connect(replacement).setSlippageBps(300)).to.be.reverted;
    await expect(guard.connect(replacement).setProtection(3600, 1000, 1000)).to.be.reverted;
    await f.manager.setSubsystemPaused(ethers.id("CHECKOUT"), false); // multisig remains authorized
    expect(await f.manager.isAdmin(ethers.ZeroAddress)).to.equal(false);
  });

  it("allows unilateral emergency upgrades with pending refund and active DCA without changing liabilities or schedule", async function () {
    const f = await deployRound(), emergency = f.treasury;
    const signed = await signVoucher(f, 1);
    await f.token.connect(f.buyer).approve(f.manager.target, MATT("700000"));
    await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("35") });
    await f.manager.setEmergencyAdmin(emergency.address);
    await f.manager.connect(emergency).disqualifyTicket(1, ethers.id("REVIEW"), ethers.id("EVIDENCE"));
    const before = await f.manager.getTicket(1), balance = await ethers.provider.getBalance(f.manager.target);
    const M2 = await ethers.getContractFactory("ProjectDynoRaffleManagerV2Mock"), mi = await M2.deploy();
    await expect(f.manager.connect(f.buyer).upgradeToAndCall(mi.target, "0x")).to.be.reverted;
    await f.manager.connect(emergency).upgradeToAndCall(mi.target, "0x");
    const upgraded = M2.attach(f.manager.target);
    expect(await upgraded.getTicket(1)).to.deep.equal(before);
    expect(await ethers.provider.getBalance(upgraded.target)).to.equal(balance);
    expect(await upgraded.emergencyAdmin()).to.equal(emergency.address);
    // Local-only manager impersonation isolates vault upgrade storage behavior.
    await network.provider.send("hardhat_setBalance", [f.manager.target, ethers.toBeHex(RON("200"))]);
    await network.provider.send("hardhat_impersonateAccount", [f.manager.target]);
    const managerCaller = await ethers.getSigner(f.manager.target);
    await f.vault.connect(managerCaller).startBuyback(1, f.treasury.address, f.token.target, f.adapter.target, f.guard.target, 200, { value: RON("168") });
    await network.provider.send("hardhat_stopImpersonatingAccount", [f.manager.target]);
    const schedule = await f.vault.getSchedule();
    const V2 = await ethers.getContractFactory("ProjectDynoBuybackVaultV2Mock"), vi = await V2.deploy();
    await f.vault.connect(emergency).upgradeToAndCall(vi.target, "0x");
    expect(await V2.attach(f.vault.target).getSchedule()).to.deep.equal(schedule);
    expect(await V2.attach(f.vault.target).implementationVersion()).to.equal(2);
  });

  it("holds exact MATT and never calls the swap adapter during checkout", async function () {
    const f = await deployRound();
    await f.adapter.configure(RON("20"), MATT("30510"), true, false);
    const { voucher, signature } = await signVoucher(f, 1);
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), MATT("700000"));
    await f.manager.connect(f.buyer).buyTickets(voucher, signature, { value: RON("35") });
    expect((await f.manager.getRoundStatus(1)).directActive).to.equal(RON("35"));
    expect((await f.manager.getRoundStatus(1)).saleActive).to.equal(0);
    expect(await f.manager.mattActive(1)).to.equal(MATT("700000"));
    expect(await f.token.balanceOf(f.manager.target)).to.equal(MATT("700000"));
  });

  it("locks implementations and atomically initializes both UUPS proxies", async function () {
    const f = await deployProxyPair();
    await expect(f.managerImpl.initialize(f.admin.address, f.identitySigner.address, await f.vault.getAddress(), f.reviewer.address)).to.be.reverted;
    await expect(f.vaultImpl.initialize(f.admin.address, await f.manager.getAddress(), f.keeper.address)).to.be.reverted;
    expect(await f.manager.multisig()).to.equal(f.admin.address);
  });
  it("opens the owner-selected Ethereum NFT round without Ronin escrow and forbids delivery reports before settlement", async function () {
    const collection = "0xd1b248DEE3a4a0E9215e349dCe237D4B6d6bB8A3";
    const f = await deployRound({ remoteCollection: collection, nftChainId: 1 });
    expect(await ethers.provider.getCode(collection)).to.equal("0x");
    const prize = await f.manager.getNftPrize(1);
    expect(prize.chainId).to.equal(1); expect(prize.collection).to.equal(collection);
    expect(prize.winner).to.equal(ethers.ZeroAddress);
    expect((await f.manager.getRoundStatus(1)).phase).to.equal(2);
    await expect(f.manager.reportManualNftDelivery(1, ethers.id("unverified-tx"))).to.be.revertedWithCustomError(f.manager, "InvalidPhase");
    await expect(f.nft["safeTransferFrom(address,address,uint256)"](f.admin.address, await f.manager.getAddress(), 1358)).to.be.reverted;
    expect(await f.nft.ownerOf(1358)).to.equal(f.admin.address);
  });

  it("buys three fixed-price tickets atomically without selling MATT and preserves quotas", async function () {
    const f = await deployRound();
    const { voucher, signature } = await signVoucher(f, 3);
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), MATT("2100000"));
    await expect(f.manager.connect(f.buyer).buyTickets(voucher, signature, { value: RON("105") }))
      .to.emit(f.manager, "TicketPurchased").withArgs(1, 1, f.buyer.address, voucher.accountCommitment, voucher.dayIndex, RON("35"), 0);
    const round = await f.manager.getRoundStatus(1);
    expect(round.eligibleCount).to.equal(3);
    expect(round.directActive).to.equal(RON("105"));
    expect(round.saleActive).to.equal(0);
    expect(await f.manager.mattActive(1)).to.equal(MATT("2100000"));
    expect((await f.manager.getTicket(2)).saleRon).to.equal(0);
    const second = await signVoucher(f, 1);
    await expect(f.manager.connect(f.buyer).buyTickets(second.voucher, second.signature, { value: RON("35") })).to.be.revertedWithCustomError(f.manager, "InvalidVoucher");
  });

  it("rolls back nonce, quota and funds when the exact MATT transfer fails", async function () {
    const f = await deployRound();
    const signed = await signVoucher(f, 2);
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), MATT("1400000"));
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), 0);
    await expect(f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("70") })).to.be.reverted;
    expect(await f.manager.accountDayCount(signed.voucher.accountCommitment, signed.voucher.dayIndex)).to.equal(0);
    expect(await f.manager.usedVoucherNonce(signed.voucher.accountCommitment, signed.voucher.nonce)).to.equal(false);
    expect((await f.manager.getRoundStatus(1)).eligibleCount).to.equal(0);
  });

  it("disqualifies with swap-and-pop and credits the original RON and MATT", async function () {
    const f = await deployRound();
    const signed = await signVoucher(f, 3);
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), MATT("2100000"));
    await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("105") });
    await f.manager.connect(f.reviewer).flagTicket(1, ethers.id("REVIEW_ONE"), ethers.id("evidence-one"));
    await f.manager.resolveFlag(1, true);
    await f.manager.connect(f.reviewer).flagTicket(2, ethers.id("REVIEW_TWO"), ethers.id("evidence-two"));
    await expect(f.manager.disqualifyTicket(2, ethers.id("DUPLICATE_ACCOUNT"), ethers.id("private-evidence")))
      .to.emit(f.manager, "RefundCredited").withArgs(1, 2, f.buyer.address, RON("35"));
    const round = await f.manager.getRoundStatus(1);
    expect(round.eligibleCount).to.equal(2);
    expect(round.directActive).to.equal(RON("70"));
    expect(round.saleActive).to.equal(0);
    expect(round.refundLiability).to.equal(RON("35"));
    expect(await f.manager.mattActive(1)).to.equal(MATT("1400000"));
    expect(await f.manager.mattRefundLiability(1)).to.equal(MATT("700000"));
    expect(await f.manager.getFlagCounts(1)).to.deep.equal([0n, 1n]);
    expect((await f.manager.getTicket(3)).eligibleIndex).to.equal(1);
    const V2 = await ethers.getContractFactory("ProjectDynoRaffleManagerV2Mock");
    const v2Impl = await V2.deploy();
    await f.manager.upgradeToAndCall(await v2Impl.getAddress(), "0x");
    const upgraded = V2.attach(await f.manager.getAddress());
    expect(await upgraded.implementationVersion()).to.equal(2);
    expect((await upgraded.getRoundStatus(1)).refundLiability).to.equal(RON("35"));
    await upgraded.connect(f.buyer).claimRefund(2);
    expect((await upgraded.getRoundStatus(1)).refundLiability).to.equal(0);
    expect(await upgraded.mattRefundLiability(1)).to.equal(0);
  });

  it("pays an alternate refund receiver only with the original wallet's EIP-712 authorization", async function () {
    const f = await deployRound(), signed = await signVoucher(f, 1);
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), MATT("700000"));
    await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("35") });
    await f.manager.disqualifyTicket(1, ethers.id("REVIEW"), ethers.id("evidence"));
    const block = await ethers.provider.getBlock("latest"), chain = await ethers.provider.getNetwork();
    const expiry = block.timestamp + 300;
    const domain = { name: "Project DYNO", version: "1", chainId: chain.chainId, verifyingContract: await f.manager.getAddress() };
    const types = { ClaimAuthorization: [
      { name: "kind", type: "bytes32" }, { name: "itemId", type: "uint256" },
      { name: "receiver", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" },
    ] };
    const authorization = { kind: ethers.id("REFUND"), itemId: 1, receiver: f.keeper.address, nonce: 0, expiry };
    const signature = await f.buyer.signTypedData(domain, types, authorization);
    await expect(f.manager.connect(f.reviewer).claimRefundTo(1, f.keeper.address, expiry, signature))
      .to.emit(f.manager, "RefundPaid").withArgs(1, 1, f.keeper.address, RON("35"));
    expect(await f.token.balanceOf(f.keeper.address)).to.equal(MATT("700000"));
    expect(await f.manager.refundPaid(1)).to.equal(true);
    await expect(f.manager.connect(f.reviewer).claimRefundTo(1, f.keeper.address, expiry, signature)).to.be.reverted;
  });

  it("keeps both refund assets credited if the alternate receiver rejects RON", async function () {
    const f = await deployRound(), signed = await signVoucher(f, 1);
    await f.token.connect(f.buyer).approve(f.manager.target, MATT("700000"));
    await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("35") });
    await f.manager.disqualifyTicket(1, ethers.id("REVIEW"), ethers.id("evidence"));
    const receiver = await (await ethers.getContractFactory("MockRejectingReceiver")).deploy();
    const expiry = (await ethers.provider.getBlock("latest")).timestamp + 300;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const signature = await f.buyer.signTypedData(
      { name: "Project DYNO", version: "1", chainId, verifyingContract: f.manager.target },
      { ClaimAuthorization: [
        { name: "kind", type: "bytes32" }, { name: "itemId", type: "uint256" },
        { name: "receiver", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" },
      ] },
      { kind: ethers.id("REFUND"), itemId: 1, receiver: receiver.target, nonce: 0, expiry },
    );
    await expect(f.manager.claimRefundTo(1, receiver.target, expiry, signature)).to.be.revertedWithCustomError(f.manager, "TransferFailed");
    expect(await f.token.balanceOf(receiver.target)).to.equal(0);
    expect(await f.manager.ticketRefundMatt(1)).to.equal(MATT("700000"));
    expect((await f.manager.getRoundStatus(1)).refundLiability).to.equal(RON("35"));
    await f.manager.connect(f.buyer).claimRefund(1);
    expect(await f.manager.refundPaid(1)).to.equal(true);
  });

  it("cancels in bounded batches and credits each active ticket once in both assets", async function () {
    const f = await deployRound(), signed = await signVoucher(f, 3);
    await f.token.connect(f.buyer).approve(f.manager.target, MATT("2100000"));
    await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("105") });
    await f.manager.disqualifyTicket(2, ethers.id("REVIEW"), ethers.id("evidence"));
    await f.manager.cancelRound(1, ethers.id("CANCEL"));
    await f.manager.processCancellationRefunds(1, 1);
    await f.manager.processCancellationRefunds(1, 2);
    expect(await f.manager.mattActive(1)).to.equal(0);
    expect(await f.manager.mattRefundLiability(1)).to.equal(MATT("2100000"));
    expect((await f.manager.getRoundStatus(1)).refundLiability).to.equal(RON("105"));
    for (const ticketId of [1, 2, 3]) await f.manager.connect(f.buyer).claimRefund(ticketId);
    expect(await f.manager.mattRefundLiability(1)).to.equal(0);
    expect(await f.token.balanceOf(f.buyer.address)).to.equal(MATT("3000000"));
    expect((await f.manager.getRoundStatus(1)).refundLiability).to.equal(0);
    await expect(f.manager.processCancellationRefunds(1, 1)).to.be.revertedWithCustomError(f.manager, "InvalidPhase");
  });

  it("requires new-wallet proof for admin-approved identity relinks and retains daily usage", async function () {
    const f = await deployRound(), signed = await signVoucher(f, 1);
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), MATT("700000"));
    await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON("35") });
    const account = signed.voucher.accountCommitment;
    const block = await ethers.provider.getBlock("latest"), chain = await ethers.provider.getNetwork();
    const expiry = block.timestamp + 300;
    const domain = { name: "Project DYNO", version: "1", chainId: chain.chainId, verifyingContract: await f.manager.getAddress() };
    const types = { RelinkAuthorization: [
      { name: "accountCommitment", type: "bytes32" }, { name: "newWallet", type: "address" },
      { name: "expectedVersion", type: "uint32" }, { name: "expiry", type: "uint64" },
    ] };
    const authorization = { accountCommitment: account, newWallet: f.keeper.address, expectedVersion: 1, expiry };
    const proof = await f.keeper.signTypedData(domain, types, authorization);
    const wrongProof = await f.reviewer.signTypedData(domain, types, authorization);
    const wrongChainProof = await f.keeper.signTypedData({ ...domain, chainId: chain.chainId + 1n }, types, authorization);
    await expect(f.manager.relinkIdentity(account, f.keeper.address, 1, expiry, wrongProof)).to.be.revertedWithCustomError(f.manager, "InvalidClaim");
    await expect(f.manager.relinkIdentity(account, f.keeper.address, 1, expiry, wrongChainProof)).to.be.revertedWithCustomError(f.manager, "InvalidClaim");
    await expect(f.manager.relinkIdentity(account, f.keeper.address, 1, block.timestamp - 1, proof)).to.be.revertedWithCustomError(f.manager, "InvalidConfiguration");
    await expect(f.manager.connect(f.reviewer).relinkIdentity(account, f.keeper.address, 1, expiry, proof)).to.be.revertedWithCustomError(f.manager, "Unauthorized");
    await expect(f.manager.relinkIdentity(account, f.keeper.address, 1, expiry, proof))
      .to.emit(f.manager, "IdentityRelinked").withArgs(account, f.buyer.address, f.keeper.address, 2);
    expect(await f.manager.walletForAccount(account)).to.equal(f.keeper.address);
    expect(await f.manager.accountForWallet(f.buyer.address)).to.equal(ethers.ZeroHash);
    expect(await f.manager.accountDayCount(account, signed.voucher.dayIndex)).to.equal(1);
    expect(await f.manager.walletDayCount(f.buyer.address, signed.voucher.dayIndex)).to.equal(1);
    await expect(f.manager.relinkIdentity(account, f.keeper.address, 1, expiry, proof)).to.be.revertedWithCustomError(f.manager, "InvalidConfiguration");
  });

  it("uses the updated 12,148.8764 RON fixture and exact 12,851.1236 remainder", async function () {
    const prizes = defaultPrizes();
    expect(prizes.reduce((a, b) => a + b, 0n)).to.equal(RON("12148.8764"));
    expect(RON("35000") - RON("10000") - prizes.reduce((a, b) => a + b, 0n)).to.equal(RON("12851.1236"));
  });

  it("allows a revised five-prize schedule before opening but rejects nonascending draws", async function () {
    const f = await deployRound();
    await f.manager.cancelRound(1, ethers.id("LOCAL_TEST_CANCEL"));
    const cancelled = await f.manager.getRoundStatus(1);
    expect(cancelled.operationsBalance).to.equal(0);
    expect(cancelled.treasuryLiability).to.equal(RON("0.02"));
    await expect(f.manager.connect(f.treasury).claimTreasuryLiability(1))
      .to.emit(f.manager, "TreasuryLiabilityClaimed").withArgs(1, f.treasury.address, RON("0.02"));
    expect((await f.manager.getRoundStatus(1)).treasuryLiability).to.equal(0);
    const revised = { ...f.config, ronPrizes: ["100", "200", "300", "400", "500"].map(RON) };
    await expect(f.manager.createRound(revised, 31337)).to.emit(f.manager, "RoundCreated");
    await f.manager.cancelRound(2, ethers.id("LOCAL_TEST_CANCEL"));
    await expect(f.manager.createRound({ ...revised, ronPrizes: [RON("100"), RON("100"), RON("300"), RON("400"), RON("500")] }, 31337)).to.be.revertedWithCustomError(f.manager, "InvalidConfiguration");
  });

  it("enforces successful, failed, missed and dust-preserving buyback slots", async function () {
    const [admin, treasury, keeper, publicCaller] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockMattToken");
    const Guard = await ethers.getContractFactory("MockProjectDynoPriceGuard");
    const Adapter = await ethers.getContractFactory("MockProjectDynoSwapAdapter");
    const Vault = await ethers.getContractFactory("ProjectDynoBuybackVault");
    const Proxy = await ethers.getContractFactory("ProjectDynoProxy");
    const token = await Token.deploy();
    const guard = await Guard.deploy(RON("20"), MATT("10"));
    const adapter = await Adapter.deploy(await token.getAddress(), RON("20"), MATT("10"));
    await token.mint(await adapter.getAddress(), MATT("1000000"));
    const impl = await Vault.deploy();
    const init = Vault.interface.encodeFunctionData("initialize", [admin.address, admin.address, keeper.address]);
    const proxy = await Proxy.deploy(await impl.getAddress(), init);
    const vault = Vault.attach(await proxy.getAddress());
    const budget = RON("168.000000000000000001");
    await vault.startBuyback(1, treasury.address, await token.getAddress(), await adapter.getAddress(), await guard.getAddress(), 200, { value: budget });
    expect(await vault.slice()).to.equal(RON("1"));
    expect(await vault.dust()).to.equal(1);
    const VaultV2 = await ethers.getContractFactory("ProjectDynoBuybackVaultV2Mock");
    const vaultV2Impl = await VaultV2.deploy();
    await vault.upgradeToAndCall(await vaultV2Impl.getAddress(), "0x");
    const upgradedVault = VaultV2.attach(await vault.getAddress());
    expect(await upgradedVault.implementationVersion()).to.equal(2);
    expect(await upgradedVault.originalBudget()).to.equal(budget);
    const fixedEnd = await upgradedVault.endTime(), fixedStart = await upgradedVault.t0();
    await expect(upgradedVault.connect(publicCaller).setSlippageBps(500)).to.be.reverted;
    await upgradedVault.setSlippageBps(500);
    expect(await upgradedVault.slippageBps()).to.equal(500);
    expect(await upgradedVault.slice()).to.equal(RON("1"));
    expect(await upgradedVault.treasury()).to.equal(treasury.address);
    expect(await upgradedVault.endTime()).to.equal(fixedEnd);
    expect(await upgradedVault.t0()).to.equal(fixedStart);
    await upgradedVault.connect(publicCaller).executeCurrentSlot();
    expect(await upgradedVault.getSlotStatus(0)).to.equal(1);
    await network.provider.send("evm_increaseTime", [3600]);
    await network.provider.send("evm_mine");
    await adapter.configure(RON("20"), MATT("10"), false, true);
    await expect(upgradedVault.connect(keeper).executeCurrentSlot({ gasLimit: 500_000 })).to.be.revertedWithCustomError(upgradedVault, "InsufficientExecutionGas");
    expect(await upgradedVault.getSlotStatus(1)).to.equal(0);
    await expect(upgradedVault.connect(publicCaller).executeCurrentSlot()).to.be.revertedWithCustomError(upgradedVault, "PublicAttemptFailed");
    expect(await upgradedVault.getSlotStatus(1)).to.equal(0);
    await upgradedVault.connect(keeper).executeCurrentSlot();
    expect(await upgradedVault.getSlotStatus(1)).to.equal(2);
    await upgradedVault.setSlippageBps(0);
    expect(await upgradedVault.getSlotStatus(1)).to.equal(2);
    await expect(upgradedVault.connect(keeper).executeCurrentSlot()).to.be.revertedWithCustomError(upgradedVault, "InvalidSlot");
    await network.provider.send("evm_increaseTime", [7200]);
    await network.provider.send("evm_mine");
    await upgradedVault.markExpiredSlots(10);
    expect(await upgradedVault.getSlotStatus(2)).to.equal(3);
    await network.provider.send("evm_increaseTime", [166 * 3600]);
    await network.provider.send("evm_mine");
    await upgradedVault.closeBuyback();
    expect(await upgradedVault.returnedAmount()).to.equal(budget - RON("1"));
    expect(await upgradedVault.mattDelivered()).to.equal(MATT("10"));
  });

  it("reproduces the full 1,000-ticket no-sale lifecycle with replacement, VRF and claims", async function () {
    this.timeout(600000);
    const f = await deployRound();
    await network.provider.send("hardhat_setBalance", [f.admin.address, ethers.toBeHex(RON("100000"))]);
    await network.provider.send("hardhat_setBalance", [f.buyer.address, ethers.toBeHex(RON("100000"))]);
    await f.admin.sendTransaction({ to: await f.adapter.getAddress(), value: RON("19520") });
    await f.token.mint(f.buyer.address, MATT("700000000"));
    await f.token.connect(f.buyer).approve(await f.manager.getAddress(), ethers.MaxUint256);

    let purchased = 0;
    const stableCommitment = ethers.keccak256(ethers.toUtf8Bytes("discord:stable-test-id"));
    expect(await f.manager.identityVersion(stableCommitment)).to.equal(0);
    expect(await f.manager.walletForAccount(stableCommitment)).to.equal(ethers.ZeroAddress);
    expect(await f.manager.accountForWallet(f.buyer.address)).to.equal(ethers.ZeroHash);
    while (purchased < 1000) {
      if (purchased > 0) {
        const block = await ethers.provider.getBlock("latest");
        await network.provider.send("evm_setNextBlockTimestamp", [(Math.floor(block.timestamp / 86400) + 1) * 86400]);
        await network.provider.send("evm_mine");
      }
      const quantity = Math.min(3, 1000 - purchased);
      const signed = await signVoucher(f, quantity);
      try {
        await f.manager.connect(f.buyer).buyTickets(signed.voucher, signed.signature, { value: RON(String(35 * quantity)) });
      } catch (error) {
        throw new Error(`full lifecycle purchase failed after ${purchased} tickets: ${error.message}`);
      }
      purchased += quantity;
    }
    expect((await f.manager.getRoundStatus(1)).phase).to.equal(3);
    await f.manager.disqualifyTicket(500, ethers.id("REPLACEMENT_REQUIRED"), ethers.id("evidence-500"));
    await f.manager.connect(f.buyer).claimRefund(500);
    expect((await f.manager.getRoundStatus(1)).phase).to.equal(2);
    const block = await ethers.provider.getBlock("latest");
    await network.provider.send("evm_setNextBlockTimestamp", [(Math.floor(block.timestamp / 86400) + 1) * 86400]);
    await network.provider.send("evm_mine");
    const replacement = await signVoucher(f, 1);
    await f.manager.connect(f.buyer).buyTickets(replacement.voucher, replacement.signature, { value: RON("35") });
    expect(await f.manager.getEligibleTicketId(1, 499)).to.equal(1000);
    expect(await f.manager.getEligibleTicketId(1, 999)).to.equal(1001);
    await network.provider.send("evm_increaseTime", [86400]);
    await network.provider.send("evm_mine");
    await f.manager.finalizeEligibility(1);
    const frozen = await f.manager.getRoundStatus(1);
    expect(frozen.phase).to.equal(4);
    expect(frozen.snapshotDigest).to.not.equal(ethers.ZeroHash);

    const requestReceipt = await (await f.manager.requestDraw(1)).wait();
    const requestEvent = requestReceipt.logs.map(log => { try { return f.manager.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === "RandomnessRequested");
    const refundReceiver = await f.manager.vrfRefundReceiverForRound(1);
    expect(refundReceiver).to.not.equal(ethers.ZeroAddress);
    const operationsBeforeRefund = (await f.manager.getRoundStatus(1)).operationsBalance;
    await f.admin.sendTransaction({ to: await f.vrf.getAddress(), value: RON("0.001") });
    await f.vrf.setFulfillmentRefund(RON("0.001"));
    await f.vrf.fulfill(requestEvent.args.requestHash, 123456789);
    expect(await ethers.provider.getBalance(refundReceiver)).to.equal(RON("0.001"));
    await f.manager.finalizeWinners(1);
    expect(await ethers.provider.getBalance(refundReceiver)).to.equal(0n);
    expect((await f.manager.getRoundStatus(1)).operationsBalance).to.equal(operationsBeforeRefund + RON("0.001"));
    await f.manager.settleRound(1);
    expect(await f.vault.originalBudget()).to.equal(0);
    expect(await f.manager.treasuryMattLiability(1)).to.equal(MATT("700000000"));
    expect(await f.nft.ownerOf(1358)).to.equal(f.admin.address);
    const { preparePrizePayouts } = require("../scripts/dyno/prepare-prize-payouts");
    const payoutManifest = { chainId: 31337, raffleProxy: await f.manager.getAddress(), multisig: f.admin.address };
    const prepared = await preparePrizePayouts(payoutManifest, 1, ethers.provider);
    expect(prepared.ronTransactions).to.have.length(5);
    expect(prepared.ronTransactions.every(tx => tx.value === "0" && tx.receiver === f.buyer.address && tx.submitted === false)).to.equal(true);
    expect(prepared.nftTransaction.receiver).to.equal(f.buyer.address);
    expect(prepared.nftTransaction.target).to.equal(await f.nft.getAddress());
    for (let i = 0; i < 5; i++) expect(prepared.ronTransactions[i].prizeAmount).to.equal(f.config.ronPrizes[i].toString());
    await expect(f.manager.connect(f.keeper).attemptPrizePayout(1, 0)).to.be.revertedWithCustomError(f.manager, "Unauthorized");
    await expect(f.manager.attemptPrizePayout(1, 5)).to.be.revertedWithCustomError(f.manager, "InvalidClaim");
    const claimBlock = await ethers.provider.getBlock("latest"), claimChain = await ethers.provider.getNetwork();
    const claimExpiry = claimBlock.timestamp + 300;
    const claimDomain = { name: "Project DYNO", version: "1", chainId: claimChain.chainId, verifyingContract: await f.manager.getAddress() };
    const claimTypes = { ClaimAuthorization: [
      { name: "kind", type: "bytes32" }, { name: "itemId", type: "uint256" },
      { name: "receiver", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint64" },
    ] };
    const itemId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint8"], [1, 0])));
    const prizeAuthorization = { kind: ethers.id("PRIZE"), itemId, receiver: f.keeper.address, nonce: await f.manager.claimNonce(f.buyer.address), expiry: claimExpiry };
    const prizeSignature = await f.buyer.signTypedData(claimDomain, claimTypes, prizeAuthorization);
    await expect(f.manager.connect(f.keeper).claimPrizeTo(1, 0, f.keeper.address, claimExpiry, prizeSignature))
      .to.emit(f.manager, "PrizePaid").withArgs(1, 0, await f.manager.getWinnerTicketId(1, 0), f.keeper.address, f.config.ronPrizes[0], false);
    expect((await preparePrizePayouts(payoutManifest, 1, ethers.provider)).ronTransactions).to.have.length(4);
    await expect(f.manager.connect(f.keeper).claimPrizeTo(1, 0, f.keeper.address, claimExpiry, prizeSignature)).to.be.revertedWithCustomError(f.manager, "InvalidClaim");
    for (let prizeIndex = 1; prizeIndex < 5; prizeIndex += 1) await f.manager.attemptPrizePayout(1, prizeIndex);
    expect((await preparePrizePayouts(payoutManifest, 1, ethers.provider)).ronTransactions).to.have.length(0);
    const nftReceipt = await (await f.nft["safeTransferFrom(address,address,uint256)"](f.admin.address, f.buyer.address, 1358)).wait();
    await expect(f.manager.reportManualNftDelivery(1, nftReceipt.hash)).to.emit(f.manager, "NFTDeliveryReported");
    await expect(f.manager.connect(f.keeper).reportManualNftDelivery(1, ethers.id("false-report"))).to.be.revertedWithCustomError(f.manager, "Unauthorized");
    expect(await f.manager.reportedNftDelivery(1)).to.equal(nftReceipt.hash);
    expect(await f.manager.prizePaid(1, 5)).to.equal(false); // A report is never an on-chain verified cross-chain payment.
    await expect(f.manager.reportManualNftDelivery(1, nftReceipt.hash)).to.be.revertedWithCustomError(f.manager, "InvalidClaim");
    await expect(f.manager.attemptPrizePayout(1, 0)).to.be.revertedWithCustomError(f.manager, "InvalidClaim");
    expect(await f.nft.ownerOf(1358)).to.equal(f.buyer.address);
    expect((await f.manager.getRoundStatus(1)).prizeLiability).to.equal(0);

    // Public readers exercise actual local contracts, not fabricated database balances.
    const { readRound, readWinners, readTicket, readBuyback } = require("../services/dyno-api/public-state");
    const latest = await ethers.provider.getBlock("latest");
    const publicOptions = { provider: ethers.provider, manager: f.manager, vault: f.vault, chainId: 31337, nowSeconds: latest.timestamp, roundId: "1" };
    const publicRound = await readRound(publicOptions);
    expect(publicRound.phase).to.equal("SETTLED");
    expect(publicRound.prizeLiability).to.equal("0");
    expect(publicRound.reserveTransferred).to.equal(null);
    const publicWinners = await readWinners(publicOptions);
    expect(publicWinners.winners).to.have.length(6);
    expect(publicWinners.winners.slice(0, 5).every(winner => winner.paid)).to.equal(true);
    expect(publicWinners.winners[5].paid).to.equal(null);
    const refunded = await readTicket({ ...publicOptions, ticketId: "500" });
    expect(refunded.status).to.equal("REFUND_PAID");
    expect(refunded.refundAmount).to.equal(RON("35").toString());
    const publicBuyback = await readBuyback({ ...publicOptions, offset: 0, limit: 3 });
    expect(publicBuyback.available).to.equal(false);
    await f.manager.connect(f.treasury).claimTreasuryMatt(1);
    expect(await f.manager.treasuryMattLiability(1)).to.equal(0);
    expect(await f.token.balanceOf(f.treasury.address)).to.equal(MATT("700000000"));
  });
});
