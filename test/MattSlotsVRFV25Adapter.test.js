const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MattSlotsVRFV25Adapter", function () {
  let owner, stranger, coordinator, adapter, consumer;

  beforeEach(async function () {
    [owner, stranger] = await ethers.getSigners();
    coordinator = await (await ethers.getContractFactory("MockVRFV25Coordinator")).deploy();
    adapter = await (await ethers.getContractFactory("MattSlotsVRFV25Adapter")).deploy(
      await coordinator.getAddress(),
      1,
      ethers.id("MATT_SLOTS_TEST_KEY"),
      owner.address,
      3,
      1_400_000,
      1_000_000
    );
    consumer = await (await ethers.getContractFactory("MockSlotsSeedConsumer")).deploy(
      await adapter.getAddress()
    );
    await adapter.setConsumer(await consumer.getAddress());
  });

  it("charges the player no RON and delivers coordinator randomness", async function () {
    expect(await adapter.estimateRequestRandomFee(800_000, 0)).to.equal(0);

    await expect(
      adapter.connect(stranger).requestRandomSeed(
        800_000,
        0,
        await consumer.getAddress(),
        stranger.address
      )
    ).to.be.revertedWithCustomError(adapter, "Unauthorized");

    const requestHash = ethers.zeroPadValue("0x01", 32);
    await expect(consumer.request(800_000))
      .to.emit(adapter, "RandomSeedRequested")
      .withArgs(1, requestHash, await consumer.getAddress());

    expect(await adapter.outstandingRequests()).to.equal(1);
    await coordinator.fulfill(1, 123456789);

    const request = await adapter.requests(1);
    expect(request.fulfilled).to.equal(true);
    expect(request.delivered).to.equal(true);
    expect(await adapter.outstandingRequests()).to.equal(0);
    expect(await consumer.fulfilledRequestHash()).to.equal(requestHash);
    expect(await consumer.fulfilledRandomSeed()).to.equal(123456789);
  });

  it("retains randomness and retries a failed consumer delivery", async function () {
    await consumer.setShouldRevert(true);
    await consumer.request(800_000);
    await coordinator.fulfill(1, 987654321);

    let request = await adapter.requests(1);
    expect(request.fulfilled).to.equal(true);
    expect(request.delivered).to.equal(false);
    expect(request.randomWord).to.equal(987654321);
    expect(await adapter.outstandingRequests()).to.equal(1);

    await consumer.setShouldRevert(false);
    await expect(adapter.retryFulfillment(1))
      .to.emit(adapter, "RandomSeedDelivery")
      .withArgs(1, ethers.zeroPadValue("0x01", 32), true);

    request = await adapter.requests(1);
    expect(request.delivered).to.equal(true);
    expect(await adapter.outstandingRequests()).to.equal(0);
    expect(await consumer.fulfilledRandomSeed()).to.equal(987654321);
  });

  it("rejects direct RON payment and callback gas above the configured ceiling", async function () {
    await expect(consumer.request(800_000, { value: 1 }))
      .to.be.revertedWithCustomError(adapter, "UnexpectedValue");
    await expect(consumer.request(1_000_001))
      .to.be.revertedWithCustomError(adapter, "InvalidConfiguration");
  });
});