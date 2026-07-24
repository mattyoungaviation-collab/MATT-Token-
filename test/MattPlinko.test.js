const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MattPlinko", function () {
  let token, coordinator, plinko, treasury, alice;
  const BET_10K = ethers.parseEther("10000");
  const BET_100K = ethers.parseEther("100000");
  const VRF_FEE = ethers.parseEther("0.01");

  beforeEach(async function () {
    [, treasury, alice] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockMattToken")).deploy();
    coordinator = await (await ethers.getContractFactory("MockRoninVRFCoordinator")).deploy();
    plinko = await (await ethers.getContractFactory("MattPlinko")).deploy(
      await token.getAddress(),
      treasury.address,
      await coordinator.getAddress()
    );

    await token.mint(treasury.address, ethers.parseEther("10000000"));
    await token.mint(alice.address, ethers.parseEther("1000000"));
    await token.connect(treasury).approve(await plinko.getAddress(), ethers.MaxUint256);
    await token.connect(alice).approve(await plinko.getAddress(), ethers.MaxUint256);
    await plinko.connect(treasury).fundBankroll(ethers.parseEther("5000000"));
    await plinko.connect(treasury).unpause();
  });

  async function play(player, amount) {
    const tx = await plinko.connect(player).play(amount, { value: VRF_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs
      .map(log => { try { return plinko.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === "DropRequested");
    return event.args.requestHash;
  }

  it("accepts only the five approved wager sizes", async function () {
    for (const amount of ["10000", "25000", "50000", "75000", "100000"]) {
      expect(await plinko.isAllowedBet(ethers.parseEther(amount))).to.equal(true);
    }
    await expect(plinko.connect(alice).play(ethers.parseEther("9999"), { value: VRF_FEE }))
      .to.be.revertedWithCustomError(plinko, "InvalidBet");
  });

  it("maps the ten peg decisions into eleven physical slots", async function () {
    expect(await plinko.slotFromSeed(0)).to.equal(0);
    expect(await plinko.slotFromSeed(0b11111)).to.equal(5);
    expect(await plinko.slotFromSeed(0b1111111111)).to.equal(10);
  });

  it("uses the fixed symmetric multiplier board", async function () {
    const expected = [2000, 800, 300, 150, 25, 25, 25, 150, 300, 800, 2000];
    for (let slot = 0; slot < expected.length; slot++) {
      expect(await plinko.multiplierForSlot(slot)).to.equal(expected[slot]);
    }
  });

  it("keeps the fixed ten-row board at 97.4609375% RTP", async function () {
    const combinations = [1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1];
    const multipliers = [2000, 800, 300, 150, 25, 25, 25, 150, 300, 800, 2000];
    const weightedMultiplier = combinations.reduce(
      (sum, combinationsAtSlot, slot) => sum + combinationsAtSlot * multipliers[slot],
      0
    );
    expect(weightedMultiplier).to.equal(99800);
    expect(weightedMultiplier / (1024 * 100)).to.equal(0.974609375);
  });

  it("caps the maximum 100,000 MATT payout at 2,000,000 MATT", async function () {
    expect(await plinko.maxPayout(BET_100K)).to.equal(ethers.parseEther("2000000"));
    const request = await play(alice, BET_100K);
    await coordinator.fulfill(request, 0);
    expect(await plinko.claimable(alice.address)).to.equal(ethers.parseEther("2000000"));
    expect((await plinko.drops(request)).slot).to.equal(0);
  });

  it("routes a losing wager to treasury and credits the 0.25x payout from bankroll", async function () {
    const treasuryBefore = await token.balanceOf(treasury.address);
    const request = await play(alice, BET_100K);
    await coordinator.fulfill(request, 0b11111);

    expect(await token.balanceOf(treasury.address) - treasuryBefore).to.equal(BET_100K);
    expect(await plinko.claimable(alice.address)).to.equal(ethers.parseEther("25000"));
    const drop = await plinko.drops(request);
    expect(drop.slot).to.equal(5);
    expect(drop.multiplier).to.equal(25);
  });

  it("lets a player withdraw credited winnings", async function () {
    const request = await play(alice, BET_10K);
    await coordinator.fulfill(request, 0);
    const before = await token.balanceOf(alice.address);
    await plinko.connect(alice).withdraw();
    expect(await token.balanceOf(alice.address) - before).to.equal(ethers.parseEther("200000"));
    expect(await plinko.claimable(alice.address)).to.equal(0);
  });

  it("reserves 19x additional liability for every pending drop", async function () {
    const request = await play(alice, BET_100K);
    expect(await plinko.lockedWagers()).to.equal(BET_100K);
    expect(await plinko.reservedLiability()).to.equal(ethers.parseEther("1900000"));
    expect(await plinko.isSolvent()).to.equal(true);
    await coordinator.fulfill(request, 0);
    expect(await plinko.reservedLiability()).to.equal(0);
  });

  it("refunds a request that Ronin VRF did not fulfill within two hours", async function () {
    const request = await play(alice, BET_10K);
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await plinko.connect(alice).refundStaleDrop(request);
    expect(await plinko.claimable(alice.address)).to.equal(BET_10K);
  });

  it("rejects callbacks from anyone except the configured coordinator", async function () {
    const request = await play(alice, BET_10K);
    await expect(plinko.connect(alice).rawFulfillRandomSeed(request, 0))
      .to.be.revertedWithCustomError(plinko, "OnlyCoordinatorCanFulfill");
  });

  it("prevents treasury withdrawals from touching reserved funds", async function () {
    await play(alice, BET_100K);
    const unreserved = await plinko.unreservedBankroll();
    await expect(plinko.connect(treasury).withdrawBankroll(unreserved + 1n))
      .to.be.revertedWithCustomError(plinko, "InsufficientBankroll");
  });
});
