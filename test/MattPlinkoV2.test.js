const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MattPlinkoV2", function () {
  let token, coordinator, plinko, treasury, alice, stranger;
  const COIN_PRICE = ethers.parseEther("10000");
  const VRF_FEE = ethers.parseEther("0.01");
  const BANKROLL = ethers.parseEther("300000000");

  beforeEach(async function () {
    [, treasury, alice, stranger] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockMattToken")).deploy();
    coordinator = await (await ethers.getContractFactory("MockRoninVRFCoordinator")).deploy();
    plinko = await (await ethers.getContractFactory("MattPlinkoV2")).deploy(
      await token.getAddress(),
      treasury.address,
      await coordinator.getAddress()
    );

    await token.mint(treasury.address, ethers.parseEther("500000000"));
    await token.mint(alice.address, ethers.parseEther("2000000"));
    await token.connect(treasury).approve(await plinko.getAddress(), ethers.MaxUint256);
    await token.connect(alice).approve(await plinko.getAddress(), ethers.MaxUint256);
    await plinko.connect(treasury).fundBankroll(BANKROLL);
    await plinko.connect(treasury).unpause();
  });

  async function purchase(player, coinCount) {
    const tx = await plinko.connect(player).purchaseBatch(coinCount, { value: VRF_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs
      .map(log => {
        try { return plinko.interface.parseLog(log); } catch { return null; }
      })
      .find(log => log?.name === "BatchRequested");
    return event.args.requestHash;
  }

  it("sells 1–100 coins at exactly 10,000 MATT each", async function () {
    expect(await plinko.batchPrice(1)).to.equal(COIN_PRICE);
    expect(await plinko.batchPrice(100)).to.equal(ethers.parseEther("1000000"));
    await expect(plinko.batchPrice(0)).to.be.revertedWithCustomError(plinko, "InvalidBatchSize");
    await expect(plinko.batchPrice(101)).to.be.revertedWithCustomError(plinko, "InvalidBatchSize");
  });

  it("maps sixteen decisions into seventeen physical slots", async function () {
    expect(await plinko.slotFromSeed(0)).to.equal(0);
    expect(await plinko.slotFromSeed(0x00ff)).to.equal(8);
    expect(await plinko.slotFromSeed(0xffff)).to.equal(16);
  });

  it("uses the final sustainable symmetric payout scale", async function () {
    const expected = [
      2000000, 1620000, 380000, 90000, 30000, 15000, 5000, 2500, 1000,
      2500, 5000, 15000, 30000, 90000, 380000, 1620000, 2000000
    ];
    for (let slot = 0; slot < expected.length; slot++) {
      expect(await plinko.multiplierForSlot(slot)).to.equal(expected[slot]);
    }
  });

  it("keeps the 16-row board at the intended sustainable RTP", async function () {
    const combinations = [
      1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870,
      11440, 8008, 4368, 1820, 560, 120, 16, 1
    ];
    const multipliers = [
      2000000, 1620000, 380000, 90000, 30000, 15000, 5000, 2500, 1000,
      2500, 5000, 15000, 30000, 90000, 380000, 1620000, 2000000
    ];
    const weighted = combinations.reduce(
      (sum, combinationsAtSlot, slot) => sum + BigInt(combinationsAtSlot) * BigInt(multipliers[slot]),
      0n
    );
    expect(weighted).to.equal(638230000n);
    expect(Number(weighted) / (65536 * 10000)).to.equal(0.9738616943359375);
  });

  it("uses one VRF request to settle and pack a 100-coin batch", async function () {
    const request = await purchase(alice, 100);
    expect(await coordinator.nonce()).to.equal(1);
    expect(await plinko.lockedWagers()).to.equal(ethers.parseEther("1000000"));
    expect(await plinko.reservedLiability()).to.equal(ethers.parseEther("199000000"));
    expect(await plinko.isSolvent()).to.equal(true);

    const fulfillment = await coordinator.fulfill(request, 123456789);
    const fulfillmentReceipt = await fulfillment.wait();
    const batch = await plinko.batches(request);
    const slots = await plinko.batchSlots(request);

    expect(batch.status).to.equal(2);
    expect(slots).to.have.length(100);
    expect(slots.every(slot => slot >= 0 && slot <= 16)).to.equal(true);
    expect(await plinko.totalCoinsSettled()).to.equal(100);
    expect(await plinko.lockedWagers()).to.equal(0);
    expect(await plinko.reservedLiability()).to.equal(0);
    expect(await plinko.claimable(alice.address)).to.equal(batch.payout);
    expect(fulfillmentReceipt.gasUsed).to.be.lessThan(420000);
    for (let i = 0; i < slots.length; i++) {
      expect(await plinko.slotAt(request, i)).to.equal(slots[i]);
    }
  });

  it("derives stable but distinct coin outcomes from the single batch seed", async function () {
    const request = await purchase(alice, 25);
    await coordinator.fulfill(request, 42);
    const firstRead = [...await plinko.batchSlots(request)];
    const secondRead = [...await plinko.batchSlots(request)];
    expect(secondRead).to.deep.equal(firstRead);
    expect(new Set(firstRead.map(Number)).size).to.be.greaterThan(1);
  });

  it("credits the exact sum represented by every stored slot", async function () {
    const request = await purchase(alice, 40);
    await coordinator.fulfill(request, 987654321);
    const batch = await plinko.batches(request);
    const slots = await plinko.batchSlots(request);
    let expectedPayout = 0n;
    for (const slot of slots) {
      expectedPayout += COIN_PRICE * await plinko.multiplierForSlot(slot) / 10000n;
    }
    expect(batch.payout).to.equal(expectedPayout);
    expect(await plinko.claimable(alice.address)).to.equal(expectedPayout);
  });

  it("caps the worst-case 100-coin batch at 200 million MATT", async function () {
    expect(await plinko.maxPayout(100)).to.equal(ethers.parseEther("200000000"));
    expect(await plinko.maxAdditionalLiability(100)).to.equal(ethers.parseEther("199000000"));
  });

  it("rejects a batch when the bankroll cannot reserve its maximum payout", async function () {
    await plinko.connect(treasury).pause();
    const withdrawable = await plinko.unreservedBankroll();
    await plinko.connect(treasury).withdrawBankroll(withdrawable - ethers.parseEther("1000000"));
    await plinko.connect(treasury).unpause();
    await expect(plinko.connect(alice).purchaseBatch(100, { value: VRF_FEE }))
      .to.be.revertedWithCustomError(plinko, "InsufficientBankroll");
  });

  it("refunds a stale batch and safely ignores a late fulfillment", async function () {
    const request = await purchase(alice, 10);
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await plinko.connect(alice).refundStaleBatch(request);

    expect(await plinko.claimable(alice.address)).to.equal(ethers.parseEther("100000"));
    expect((await plinko.batches(request)).status).to.equal(3);
    await expect(coordinator.fulfill(request, 77))
      .to.emit(plinko, "LateFulfillmentIgnored")
      .withArgs(request);
    expect(await plinko.claimable(alice.address)).to.equal(ethers.parseEther("100000"));
  });

  it("rejects callbacks from anyone except the configured coordinator", async function () {
    const request = await purchase(alice, 1);
    await expect(plinko.connect(stranger).rawFulfillRandomSeed(request, 0))
      .to.be.revertedWithCustomError(plinko, "OnlyCoordinatorCanFulfill");
  });

  it("protects pending and claimable MATT from treasury withdrawals", async function () {
    const request = await purchase(alice, 100);
    await expect(
      plinko.connect(treasury).withdrawBankroll((await plinko.unreservedBankroll()) + 1n)
    ).to.be.revertedWithCustomError(plinko, "InsufficientBankroll");

    await coordinator.fulfill(request, 123);
    await expect(
      plinko.connect(treasury).withdrawBankroll((await plinko.unreservedBankroll()) + 1n)
    ).to.be.revertedWithCustomError(plinko, "InsufficientBankroll");
  });

  it("lets the player withdraw the entire settled batch payout", async function () {
    const request = await purchase(alice, 10);
    await coordinator.fulfill(request, 54321);
    const amount = await plinko.claimable(alice.address);
    const before = await token.balanceOf(alice.address);
    await plinko.connect(alice).withdraw();
    expect(await token.balanceOf(alice.address) - before).to.equal(amount);
    expect(await plinko.claimable(alice.address)).to.equal(0);
  });
});
