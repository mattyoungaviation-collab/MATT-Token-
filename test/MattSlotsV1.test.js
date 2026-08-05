const { expect } = require("chai");
const { ethers } = require("hardhat");
const math = require("../website/lib/slots-math-v1");

const REELS = [
  0x2113512304164206210541750401134332064123050804077105080329329621n,
  0x2783712042131124612010004816211220045036514403503060330495273519n,
  0x3502273479460800049521031233114733600151064482051162112120453200n,
  0x7744451803904221492001300406310228253512335221130600141760130615n,
  0x0232101910112403151530933687402330025910064235704421142466078521n
];
const LINE_PAYS = [
  3500,8750,26250, 4375,12250,35000, 5250,15750,52500,
  7000,21000,78750, 8750,31500,122500, 13125,52500,210000,
  21000,105000,437500, 35000,175000,875000, 350000,1750000,8750000,
  0,0,0
];
const SCATTER_PAYS = [20000,100000,250000];
const BONUS_AWARDS = [10,15,25];
const VRF_FEE = ethers.parseEther("0.01");

function parseEvent(receipt, contract, name) {
  return receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === name);
}

function gridForSeed(seed, requestHash, spinId, bonus = false) {
  let wildReel = -1;
  if (bonus) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32", "uint256", "string"], [seed, requestHash, spinId, "WILD_REEL"]
    );
    wildReel = Number(BigInt(ethers.keccak256(encoded)) % 5n);
  }
  const stops = [];
  for (let reel = 0; reel < 5; reel += 1) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "bytes32", "uint256", "uint8"], [seed, requestHash, spinId, reel]
    );
    stops.push(Number(BigInt(ethers.keccak256(encoded)) & 63n));
  }
  return math.gridFromStops(stops, wildReel);
}

function seedWithBonus(requestHash, spinId) {
  for (let seed = 1n; seed < 200_000n; seed += 1n) {
    const result = math.evaluateGrid(gridForSeed(seed, requestHash, spinId));
    if (result.freeSpins > 0 && result.multiplierBps < math.MAX_MULTIPLIER_BPS) return seed;
  }
  throw new Error("bonus seed not found");
}

describe("MattSlotsV1", function () {
  let token, coordinator, converter, vault, slots, owner, alice, stranger;

  beforeEach(async function () {
    [owner, alice, stranger] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockMattToken")).deploy();
    coordinator = await (await ethers.getContractFactory("MockRoninVRFCoordinator")).deploy();
    converter = await (await ethers.getContractFactory("MockSlotsLossConverter")).deploy();
    vault = await (await ethers.getContractFactory("MattSlotsRewardVault")).deploy(
      await token.getAddress(), await converter.getAddress(), owner.address
    );
    slots = await (await ethers.getContractFactory("MattSlotsV1")).deploy(
      await token.getAddress(), await vault.getAddress(), await coordinator.getAddress(), owner.address,
      REELS, LINE_PAYS, SCATTER_PAYS, BONUS_AWARDS, 9700
    );
    await vault.setController(await slots.getAddress());
    await token.mint(owner.address, ethers.parseEther("100000000"));
    await token.mint(alice.address, ethers.parseEther("5000000"));
    await token.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
    await token.connect(alice).approve(await slots.getAddress(), ethers.MaxUint256);
    await vault.fund(ethers.parseEther("50000000"));
    await slots.unpause();
  });

  async function buy(quantity = 10, wager = ethers.parseEther("5000")) {
    await slots.connect(alice).buySpins(wager, quantity);
    return { index: 0, wager };
  }

  async function playPaid(batchIndex = 0) {
    const tx = await slots.connect(alice).playPaid(batchIndex, { value: VRF_FEE });
    const receipt = await tx.wait();
    const event = parseEvent(receipt, slots, "SpinRequested");
    return { spinId: event.args.spinId, requestHash: event.args.requestHash };
  }

  it("sells 1-25 refundable onchain credits at an adjustable wager", async function () {
    await expect(slots.connect(alice).buySpins(ethers.parseEther("5000"), 0))
      .to.be.revertedWithCustomError(slots, "InvalidQuantity");
    await expect(slots.connect(alice).buySpins(ethers.parseEther("5000"), 26))
      .to.be.revertedWithCustomError(slots, "InvalidQuantity");
    await buy(25);
    let batch = await slots.paidBatchAt(alice.address, 0);
    expect(batch.remaining).to.equal(25n);
    expect(await slots.totalCreditEscrow()).to.equal(ethers.parseEther("125000"));
    const before = await token.balanceOf(alice.address);
    await slots.connect(alice).refundPaidSpins(0, 5);
    batch = await slots.paidBatchAt(alice.address, 0);
    expect(batch.remaining).to.equal(20n);
    expect(await token.balanceOf(alice.address) - before).to.equal(ethers.parseEther("25000"));
  });

  it("keeps old purchased wagers playable after the owner lowers future buy limits", async function () {
    await buy(2, ethers.parseEther("50000"));
    await slots.setBetLimits(ethers.parseEther("500"), ethers.parseEther("10000"));
    await expect(slots.connect(alice).buySpins(ethers.parseEther("50000"), 1))
      .to.be.revertedWithCustomError(slots, "InvalidAmount");
    await expect(slots.connect(alice).playPaid(0, { value: VRF_FEE })).not.to.be.reverted;
  });

  it("consumes one credit per click and allows only one pending spin per wallet", async function () {
    await buy(3);
    await playPaid();
    expect((await slots.paidBatchAt(alice.address, 0)).remaining).to.equal(2n);
    await expect(slots.connect(alice).playPaid(0, { value: VRF_FEE }))
      .to.be.revertedWithCustomError(slots, "ActiveSpinExists");
  });

  it("stores the exact five-by-three grid and pays exactly what that grid evaluates", async function () {
    const { spinId, requestHash } = await (async () => { await buy(1); return playPaid(); })();
    const seed = 123456789n;
    const expectedGrid = gridForSeed(seed, requestHash, spinId);
    const expected = math.evaluateGrid(expectedGrid);
    await coordinator.fulfill(requestHash, seed);
    const grid = await slots.getSpinGrid(spinId);
    expect(grid.map(Number)).to.deep.equal(expectedGrid.flat());
    const spin = await slots.spins(spinId);
    const expectedPayout = ethers.parseEther("5000") * BigInt(expected.multiplierBps) / 10000n;
    expect(spin.payout).to.equal(expectedPayout);
    expect(spin.winningLinesMask).to.equal(BigInt(expected.winningLinesMask));
    expect(spin.scatterCount).to.equal(BigInt(expected.scatterCount));
    expect(await vault.claimable(alice.address)).to.equal(expectedPayout);
  });

  it("creates a fully reserved onchain free-spin session when Vault scatters trigger", async function () {
    await buy(1);
    const { spinId, requestHash } = await playPaid();
    const seed = seedWithBonus(requestHash, spinId);
    const expected = math.evaluateGrid(gridForSeed(seed, requestHash, spinId));
    await coordinator.fulfill(requestHash, seed);
    const spin = await slots.spins(spinId);
    expect(spin.freeSpinsAwarded).to.equal(BigInt(expected.freeSpins));
    expect(spin.sessionId).not.to.equal(0);
    const session = await slots.bonusSessions(spin.sessionId);
    expect(session.remaining).to.equal(BigInt(expected.freeSpins));
    expect(session.wager).to.equal(ethers.parseEther("5000"));
    const reservation = await vault.bonusReservations(spin.sessionId);
    expect(reservation.remainingLiability).to.equal(
      ethers.parseEther("2500000") - spin.payout
    );
  });

  it("restores a paid credit and its MATT principal after stale VRF", async function () {
    await buy(1);
    const { spinId, requestHash } = await playPaid();
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await slots.connect(alice).refundStaleSpin(spinId);
    expect((await slots.paidBatchAt(alice.address, 0)).remaining).to.equal(1n);
    expect(await slots.totalCreditEscrow()).to.equal(ethers.parseEther("5000"));
    await expect(coordinator.fulfill(requestHash, 77))
      .to.emit(slots, "LateFulfillmentIgnored").withArgs(requestHash, spinId);
  });

  it("queues exactly wager minus payout as treasury loss and keeps it protected", async function () {
    await buy(1);
    const { spinId, requestHash } = await playPaid();
    let seed = 1n;
    while (math.evaluateGrid(gridForSeed(seed, requestHash, spinId)).multiplierBps >= 10000) seed += 1n;
    await coordinator.fulfill(requestHash, seed);
    const spin = await slots.spins(spinId);
    expect(spin.treasuryLoss).to.equal(ethers.parseEther("5000") - spin.payout);
    expect(await vault.pendingTreasuryLoss()).to.equal(spin.treasuryLoss);
    expect(await vault.isSolvent()).to.equal(true);
    await vault.flushTreasuryLoss(spin.treasuryLoss);
    expect(await converter.recorded()).to.equal(spin.treasuryLoss);
  });

  it("rejects a previously purchased spin if the vault can no longer cover its 500x cap", async function () {
    await buy(1, ethers.parseEther("5000"));
    const available = await vault.availableBankroll();
    await vault.withdrawAvailable(available - ethers.parseEther("2499999"));
    await expect(slots.connect(alice).playPaid(0, { value: VRF_FEE }))
      .to.be.revertedWithCustomError(slots, "InsufficientBankroll");
    expect((await slots.paidBatchAt(alice.address, 0)).remaining).to.equal(1n);
  });
});
