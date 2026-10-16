const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("DYNO fixed Katana aggregate route (local command mock)", function () {
  async function fixture() {
    const [buyer, treasury] = await ethers.getSigners();
    const matt = await (await ethers.getContractFactory("MockMattToken")).deploy();
    const wron = await (await ethers.getContractFactory("MockDynoWrappedRon")).deploy();
    const router = await (await ethers.getContractFactory("MockDynoAggregateRouter")).deploy();
    const adapter = await (await ethers.getContractFactory("ProjectDynoKatanaAggregateAdapter")).deploy(matt.target, wron.target, router.target, 10000);
    await matt.mint(buyer.address, 1000n);
    await matt.mint(router.target, 1000n); // unrelated router balance must survive
    await wron.deposit({ value: 1000n }); await wron.transfer(router.target, 1000n);
    await matt.approve(adapter.target, 1000n);
    return { buyer, treasury, matt, wron, router, adapter };
  }
  it("measures sale and treasury delivery, preserves unrelated funds and has no router approval", async () => {
    const f = await loadFixture(fixture);
    await expect(f.adapter.sellExactMatt(100n, 98n)).to.changeEtherBalance(f.adapter, 0n);
    expect(await f.matt.balanceOf(f.router.target)).to.equal(1000n);
    expect(await f.matt.allowance(f.adapter.target, f.router.target)).to.equal(0n);
    await f.adapter.buyMatt(f.treasury.address, 98n, { value: 100n });
    expect(await f.matt.balanceOf(f.treasury.address)).to.equal(100n);
    expect(await f.wron.allowance(f.adapter.target, f.router.target)).to.equal(0n);
    expect(await ethers.provider.getBalance(f.adapter.target)).to.equal(0n);
  });
  it("rolls back token intake and router effects for a partial fill or failed swap", async () => {
    const f = await loadFixture(fixture);
    await f.router.configure(false, true);
    await expect(f.adapter.sellExactMatt(100n, 98n)).to.be.revertedWithCustomError(f.adapter, "IncompleteSpend");
    expect(await f.matt.balanceOf(f.buyer.address)).to.equal(1000n);
    expect(await f.matt.balanceOf(f.router.target)).to.equal(1000n);
    await f.router.configure(true, false);
    await expect(f.adapter.buyMatt(f.treasury.address, 98n, { value: 100n })).to.be.reverted;
    expect(await f.wron.balanceOf(f.adapter.target)).to.equal(0n);
  });
  it("refuses zero protection, invalid route configuration and unsolicited RON", async () => {
    const f = await loadFixture(fixture);
    await expect(f.adapter.sellExactMatt(100n, 0n)).to.be.revertedWithCustomError(f.adapter, "InvalidConfiguration");
    await expect(f.buyer.sendTransaction({ to: f.adapter.target, value: 1n })).to.be.reverted;
    await expect((await ethers.getContractFactory("ProjectDynoKatanaAggregateAdapter")).deploy(f.matt.target, f.wron.target, f.buyer.address, 10000)).to.be.reverted;
  });
});
