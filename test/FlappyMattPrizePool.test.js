const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const ENTRY = ethers.parseEther("50000");
const TREASURY_FEE = ethers.parseEther("1000");
const PRIZE = ethers.parseEther("49000");

async function moveToNextUtcDay() {
  const block = await ethers.provider.getBlock("latest");
  const nextUtcDay = (Math.floor(Number(block.timestamp) / DAY) + 1) * DAY;
  await ethers.provider.send("evm_setNextBlockTimestamp", [nextUtcDay]);
  await ethers.provider.send("evm_mine", []);
}

describe("FlappyMattPrizePool", function () {
  async function deployFixture() {
    const [owner, operator, treasury, player, first, second, third] = await ethers.getSigners();
    const token = await ethers.deployContract("MockMattToken");
    const pool = await ethers.deployContract("FlappyMattPrizePool", [
      await token.getAddress(), treasury.address, operator.address, owner.address
    ]);
    await token.mint(player.address, ENTRY * 3n);
    await token.connect(player).approve(await pool.getAddress(), ENTRY * 3n);
    return { owner, operator, treasury, player, first, second, third, token, pool };
  }

  it("sends 1,000 MATT to treasury and records 49,000 MATT in the round pot", async function () {
    const { treasury, player, token, pool } = await deployFixture();
    const roundId = await pool.currentRoundId();
    await expect(pool.connect(player).enter())
      .to.emit(pool, "EntryPaid")
      .withArgs(roundId, player.address, 1n, TREASURY_FEE, PRIZE, PRIZE);
    expect(await token.balanceOf(treasury.address)).to.equal(TREASURY_FEE);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(PRIZE);
    expect(await pool.roundEntries(roundId)).to.equal(1n);
    expect(await pool.roundPot(roundId)).to.equal(PRIZE);
  });

  it("pays 50/35/15 after the UTC round closes", async function () {
    const { operator, player, first, second, third, token, pool } = await deployFixture();
    const roundId = await pool.currentRoundId();
    await pool.connect(player).enter();
    await moveToNextUtcDay();
    await pool.connect(operator).settleRound(roundId, first.address, second.address, third.address);
    const firstPrize = PRIZE * 50n / 100n;
    const secondPrize = PRIZE * 35n / 100n;
    expect(await token.balanceOf(first.address)).to.equal(firstPrize);
    expect(await token.balanceOf(second.address)).to.equal(secondPrize);
    expect(await token.balanceOf(third.address)).to.equal(PRIZE - firstPrize - secondPrize);
    expect(await pool.roundSettled(roundId)).to.equal(true);
  });

  it("carries an unclaimed third-place share into the current round", async function () {
    const { operator, player, first, second, token, pool } = await deployFixture();
    const roundId = await pool.currentRoundId();
    await pool.connect(player).enter();
    await moveToNextUtcDay();
    const carryRoundId = await pool.currentRoundId();
    await pool.connect(operator).settleRound(roundId, first.address, second.address, ethers.ZeroAddress);
    const expectedCarry = PRIZE - (PRIZE * 50n / 100n) - (PRIZE * 35n / 100n);
    expect(await pool.roundCarryover(carryRoundId)).to.equal(expectedCarry);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(expectedCarry);
  });

  it("carries the entire pot when nobody submits an eligible score", async function () {
    const { operator, player, token, pool } = await deployFixture();
    const roundId = await pool.currentRoundId();
    await pool.connect(player).enter();
    await moveToNextUtcDay();
    const carryRoundId = await pool.currentRoundId();
    await pool.connect(operator).settleRound(roundId, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress);
    expect(await pool.roundCarryover(carryRoundId)).to.equal(PRIZE);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(PRIZE);
  });

  it("rejects early, duplicate, and unauthorized settlement", async function () {
    const { owner, operator, player, first, second, pool } = await deployFixture();
    const roundId = await pool.currentRoundId();
    await pool.connect(player).enter();
    await expect(pool.connect(operator).settleRound(roundId, first.address, second.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(pool, "RoundStillOpen");
    await moveToNextUtcDay();
    await expect(pool.connect(owner).settleRound(roundId, first.address, second.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(pool, "NotOperator");
    await expect(pool.connect(operator).settleRound(roundId, first.address, first.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(pool, "DuplicateWinner");
    await pool.connect(operator).settleRound(roundId, first.address, second.address, ethers.ZeroAddress);
    await expect(pool.connect(operator).settleRound(roundId, first.address, second.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(pool, "RoundAlreadySettled");
  });
});
