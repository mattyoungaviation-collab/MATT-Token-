const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MattSlotsTreasuryConverter", function () {
  let matt, wron, pool, router, source, converter, owner, keeper, treasury, stranger;
  const AMOUNT = ethers.parseEther("1000");

  beforeEach(async function () {
    [owner, keeper, treasury, stranger] = await ethers.getSigners();
    matt = await (await ethers.getContractFactory("MockMattToken")).deploy();
    wron = await (await ethers.getContractFactory("MockWrappedRon")).deploy();
    router = await (await ethers.getContractFactory("MockSlotsRouter")).deploy();
    source = await (await ethers.getContractFactory("MockSlotsSourceVault")).deploy();
    pool = await (await ethers.getContractFactory("MockKatanaV3Pool")).deploy(
      owner.address, await matt.getAddress(), await wron.getAddress()
    );
    converter = await (await ethers.getContractFactory("MattSlotsTreasuryConverter")).deploy(
      await matt.getAddress(), await wron.getAddress(), owner.address, await pool.getAddress(),
      treasury.address, await router.getAddress(), keeper.address, 500, 1, owner.address
    );
    await converter.configureSourceVault(await source.getAddress());
    await converter.unpause();
    await matt.mint(await source.getAddress(), AMOUNT);
    await wron.connect(owner).deposit({ value: ethers.parseEther("2000") });
  });

  it("accepts backed losses only from the configured vault", async function () {
    await expect(converter.connect(stranger).recordLoss(AMOUNT))
      .to.be.revertedWithCustomError(converter, "Unauthorized");
    await source.sendLoss(await matt.getAddress(), await converter.getAddress(), AMOUNT);
    expect(await converter.pendingMatt()).to.equal(AMOUNT);
    expect(await matt.balanceOf(await converter.getAddress())).to.equal(AMOUNT);
  });

  it("swaps exact MATT, unwraps WRON, and forwards every RON to the immutable treasury", async function () {
    await source.sendLoss(await matt.getAddress(), await converter.getAddress(), AMOUNT);
    const out = AMOUNT;
    const call = router.interface.encodeFunctionData("swapExact", [
      await matt.getAddress(), await wron.getAddress(), AMOUNT, out, await converter.getAddress()
    ]);
    const before = await ethers.provider.getBalance(treasury.address);
    await converter.connect(keeper).convert(AMOUNT, out, call);
    expect(await converter.pendingMatt()).to.equal(0);
    expect(await converter.totalMattConverted()).to.equal(AMOUNT);
    expect(await converter.totalRonForwarded()).to.equal(out);
    expect(await ethers.provider.getBalance(treasury.address) - before).to.equal(out);
  });

  it("rejects a caller-supplied minimum below the 30-minute TWAP floor", async function () {
    await source.sendLoss(await matt.getAddress(), await converter.getAddress(), AMOUNT);
    const call = router.interface.encodeFunctionData("swapExact", [
      await matt.getAddress(), await wron.getAddress(), AMOUNT, AMOUNT, await converter.getAddress()
    ]);
    await expect(converter.connect(keeper).convert(AMOUNT, ethers.parseEther("900"), call))
      .to.be.revertedWithCustomError(converter, "MinimumOutputTooLow");
  });
});
