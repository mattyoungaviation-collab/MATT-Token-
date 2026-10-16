const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("DYNO V3 reference guard (local mocks, not market verification)", function () {
  async function fixture() {
    const [admin, other, matt, wron] = await ethers.getSigners();
    const factory = await (await ethers.getContractFactory("MockProjectDynoV3Factory")).deploy();
    const Pool = await ethers.getContractFactory("MockProjectDynoV3Pool");
    const pool = await Pool.deploy(await factory.getAddress(), matt.address, wron.address, 10000);
    await factory.setPool(await pool.getAddress());
    const Guard = await ethers.getContractFactory("ProjectDynoKatanaV3PriceGuard");
    const args = [admin.address, matt.address, wron.address, await pool.getAddress(), await factory.getAddress(), 1000];
    const guard = await Guard.deploy(...args);
    return { admin, other, matt, wron, factory, pool, Pool, Guard, guard, args };
  }
  it("deducts verified millionth fees; zero slippage is nonzero protection in both directions", async () => {
    const { guard } = await loadFixture(fixture);
    expect(await guard.poolFee()).to.equal(10000);
    expect(await guard.saleMinOut(10000, 0)).to.equal(9900);
    expect(await guard.buybackMinOut(10000, 0)).to.equal(9900);
    expect(await guard.saleMinOut(10000, 200)).to.equal(9702);
    expect(await guard.buybackMinOut(10000, 1000)).to.equal(8910);
    expect(await guard.saleMinOut(101, 0)).to.equal(99);
  });
  it("rejects counterfeit factory claims, wrong pairs, missing code and invalid fees", async () => {
    const f = await loadFixture(fixture);
    await f.factory.setPool(f.other.address);
    await expect(f.Guard.deploy(...f.args)).to.be.revertedWithCustomError(f.guard, "InvalidConfiguration");
    await f.factory.setPool(await f.pool.getAddress());
    const args = [...f.args]; args[2] = f.other.address;
    await expect(f.Guard.deploy(...args)).to.be.revertedWithCustomError(f.guard, "InvalidConfiguration");
    args[2] = f.wron.address; args[4] = f.other.address;
    await expect(f.Guard.deploy(...args)).to.be.revertedWithCustomError(f.guard, "InvalidConfiguration");
    const bad = await f.Pool.deploy(await f.factory.getAddress(), f.matt.address, f.wron.address, 1000000);
    args[3] = await bad.getAddress(); args[4] = await f.factory.getAddress();
    await f.factory.setPool(args[3]);
    await expect(f.Guard.deploy(...args)).to.be.revertedWithCustomError(f.guard, "InvalidConfiguration");
  });
  it("supports either pool orientation and inverse reference pricing", async () => {
    const f = await loadFixture(fixture);
    const reversed = await f.Pool.deploy(await f.factory.getAddress(), f.wron.address, f.matt.address, 10000);
    await f.factory.setPool(await reversed.getAddress());
    const args = [...f.args]; args[3] = await reversed.getAddress();
    const guard = await f.Guard.deploy(...args);
    await reversed.configure(100, 100, 1000000, 1000000, false, false, true);
    const sale = await guard.saleMinOut(1000000, 0), buy = await guard.buybackMinOut(1000000, 0);
    expect(sale).not.to.equal(buy);
    expect(sale * buy).to.be.lte(990000n ** 2n);
  });
  it("refuses zero/overflow/invalid-slippage inputs instead of a zero minOut", async () => {
    const { guard } = await loadFixture(fixture);
    for (const amount of [0n, 1n, 1n << 128n]) {
      await expect(guard.saleMinOut(amount, 0)).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
      await expect(guard.buybackMinOut(amount, 0)).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
    }
    await expect(guard.saleMinOut(100, 1001)).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
  });
  it("fails closed for missing/malformed history and zero oracle liquidity without spot fallback", async () => {
    const { pool, guard } = await loadFixture(fixture);
    for (const [harmonic, unavailable, malformed] of [[1000000, true, false], [1000000, false, true], [0, false, false]]) {
      await pool.configure(0, 0, harmonic, 1000000, unavailable, malformed, true);
      await expect(guard.saleMinOut(10000, 200)).to.be.reverted;
      await expect(guard.buybackMinOut(10000, 200)).to.be.reverted;
    }
  });
  it("requires both active and harmonic liquidity", async () => {
    const { pool, guard } = await loadFixture(fixture);
    for (const [harmonic, active] of [[100, 1000000], [1000000, 100]]) {
      await pool.configure(0, 0, harmonic, active, false, false, true);
      await expect(guard.validate()).to.be.revertedWithCustomError(guard, "InsufficientLiquidity");
    }
  });
  it("rejects transient spot manipulation and a locked pool", async () => {
    const { pool, guard } = await loadFixture(fixture);
    await pool.configure(0, 2000, 1000000, 1000000, false, false, true);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "ExcessiveDeviation");
    await pool.configure(0, 0, 1000000, 1000000, false, false, false);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
  });
  it("zero deviation rejects even a sub-basis-point difference", async () => {
    const { pool, guard } = await loadFixture(fixture);
    await guard.setProtection(3600, 0, 1000);
    await pool.configure(0, 1, 1000000, 1000000, false, false, true);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "ExcessiveDeviation");
  });
  it("logs old/new protection values and restricts administration", async () => {
    const { admin, other, guard } = await loadFixture(fixture);
    await expect(guard.connect(other).setProtection(3600, 200, 1000)).to.be.revertedWithCustomError(guard, "Unauthorized");
    await expect(guard.setProtection(0, 200, 1000)).to.emit(guard, "ProtectionUpdated").withArgs(3600, 0, 1000, 200, 1000, 1000, admin.address);
    await expect(guard.setProtection(7200, 500, 2000)).to.emit(guard, "ProtectionUpdated").withArgs(0, 7200, 200, 500, 1000, 2000, admin.address);
    await expect(guard.transferAdmin(other.address)).to.emit(guard, "AdminChanged").withArgs(admin.address, other.address);
    await expect(guard.setProtection(3600, 200, 1000)).to.be.revertedWithCustomError(guard, "Unauthorized");
  });
  it("does not claim to detect sustained manipulation shared by spot and TWAP", async () => {
    const { pool, guard } = await loadFixture(fixture);
    await pool.configure(2000, 2000, 1000000, 1000000, false, false, true);
    await expect(guard.validate()).not.to.be.reverted;
  });
  it("spot-only mode survives missing history but keeps active liquidity, pool lock and a nonzero floor", async () => {
    const { pool, guard } = await loadFixture(fixture);
    await guard.setProtection(0, 1000, 1000);
    await pool.configure(0, 0, 0, 1000000, true, true, true);
    expect(await guard.saleMinOut(10000, 200)).to.equal(9702);
    expect(await guard.buybackMinOut(10000, 300)).to.equal(9603);
    await pool.configure(0, 0, 0, 999, true, true, true);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "InsufficientLiquidity");
    await pool.configure(0, 0, 0, 1000000, true, true, false);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
  });
  it("allows immediate higher/lower tolerance without changing pool state or disabling output protection", async () => {
    const { admin, pool, guard } = await loadFixture(fixture);
    await pool.configure(0, 1500, 1000000, 1000000, false, false, true);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "ExcessiveDeviation");
    await expect(guard.setProtection(1800, 2000, 1000)).to.emit(guard, "ProtectionUpdated").withArgs(3600, 1800, 1000, 2000, 1000, 1000, admin.address);
    await expect(guard.validate()).not.to.be.reverted;
    expect(await guard.saleMinOut(10000, 0)).to.equal(9900);
    expect((await pool.slot0())[1]).to.equal(1500);
    await guard.setProtection(3600, 500, 1000);
    await expect(guard.validate()).to.be.revertedWithCustomError(guard, "ExcessiveDeviation");
    await expect(guard.setProtection(3600, 10001, 1000)).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
    await expect(guard.setProtection(3600, 10000, 0)).to.be.revertedWithCustomError(guard, "InvalidConfiguration");
  });
});
