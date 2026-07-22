const { expect } = require("chai");
const { ethers } = require("hardhat");

const e = value => ethers.parseEther(String(value));
const b32 = text => ethers.keccak256(ethers.toUtf8Bytes(text));

async function fixture() {
  const [deployer, treasury, operator, rewards, player, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockBurnableToken");
  const token = await Token.deploy();
  const Vault = await ethers.getContractFactory("MattCrashVault");
  const vault = await Vault.deploy(await token.getAddress(), treasury.address, operator.address, rewards.address);

  await token.mint(treasury.address, e(2_000_000_000));
  await token.mint(player.address, e(100_000_000));
  await token.connect(treasury).approve(await vault.getAddress(), e(2_000_000_000));
  await vault.connect(treasury).fundBankroll(e(1_000_000_000));
  await token.connect(player).approve(await vault.getAddress(), ethers.MaxUint256);
  await vault.connect(treasury).unpause();
  await vault.connect(treasury).setLimits(e(1_000), e(10_000_000), 10n * 10_000n);

  return { token, vault, treasury, operator, rewards, player, stranger };
}

async function commitAndBet(ctx, label = "round-1", amount = e(100_000)) {
  const roundId = b32(label);
  const seed = b32(`${label}-seed`);
  const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [seed]));
  const block = await ethers.provider.getBlock("latest");
  await ctx.vault.connect(ctx.operator).commitRound(roundId, commitment, block.timestamp + 60);
  await ctx.vault.connect(ctx.player).openWager(roundId, amount);
  const wagerId = ethers.keccak256(ethers.solidityPacked(
    ["uint256", "address", "bytes32", "address"],
    [(await ethers.provider.getNetwork()).chainId, await ctx.vault.getAddress(), roundId, ctx.player.address]
  ));
  return { roundId, seed, wagerId, amount };
}

describe("MattCrashVault", function () {
  it("starts paused and only owner can unpause", async function () {
    const [deployer, treasury, operator, rewards, stranger] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockBurnableToken");
    const token = await Token.deploy();
    const Vault = await ethers.getContractFactory("MattCrashVault");
    const vault = await Vault.deploy(await token.getAddress(), treasury.address, operator.address, rewards.address);
    expect(await vault.paused()).to.equal(true);
    await expect(vault.connect(stranger).unpause()).to.be.reverted;
  });

  it("rejects unauthorized round commitments and duplicate player bets", async function () {
    const ctx = await fixture();
    const roundId = b32("dup");
    const seed = b32("seed");
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [seed]));
    const block = await ethers.provider.getBlock("latest");
    await expect(ctx.vault.connect(ctx.stranger).commitRound(roundId, commitment, block.timestamp + 60)).to.be.revertedWithCustomError(ctx.vault, "Unauthorized");
    await ctx.vault.connect(ctx.operator).commitRound(roundId, commitment, block.timestamp + 60);
    await ctx.vault.connect(ctx.player).openWager(roundId, e(100_000));
    await expect(ctx.vault.connect(ctx.player).openWager(roundId, e(100_000))).to.be.revertedWithCustomError(ctx.vault, "WagerAlreadyExists");
  });

  it("verifies the reveal and calculates the crash point on-chain", async function () {
    const ctx = await fixture();
    const data = await commitAndBet(ctx);
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine");
    await expect(ctx.vault.connect(ctx.operator).revealRound(data.roundId, b32("wrong"))).to.be.revertedWithCustomError(ctx.vault, "InvalidReveal");
    await ctx.vault.connect(ctx.operator).revealRound(data.roundId, data.seed);
    const round = await ctx.vault.rounds(data.roundId);
    expect(round.revealed).to.equal(true);
    expect(round.crashPointBps).to.be.gte(10_000n);
  });

  it("pays a valid cash-out and blocks cash-outs at or above the crash", async function () {
    const ctx = await fixture();
    const data = await commitAndBet(ctx, "win");
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine");
    await ctx.vault.connect(ctx.operator).revealRound(data.roundId, data.seed);
    const round = await ctx.vault.rounds(data.roundId);
    if (round.crashPointBps > 10_001n) {
      await ctx.vault.connect(ctx.operator).settleWager(data.wagerId, 10_001n);
      expect(await ctx.vault.claimable(ctx.player.address)).to.equal((data.amount * 10_001n) / 10_000n);
    }

    const data2 = await commitAndBet(ctx, "invalid-cashout");
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine");
    await ctx.vault.connect(ctx.operator).revealRound(data2.roundId, data2.seed);
    const round2 = await ctx.vault.rounds(data2.roundId);
    await expect(ctx.vault.connect(ctx.operator).settleWager(data2.wagerId, round2.crashPointBps)).to.be.revertedWithCustomError(ctx.vault, "InvalidCashout");
  });

  it("allocates losses to burn and rewards while preserving solvency", async function () {
    const ctx = await fixture();
    const data = await commitAndBet(ctx, "loss", e(1_000_000));
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine");
    await ctx.vault.connect(ctx.operator).revealRound(data.roundId, data.seed);
    const supplyBefore = await ctx.token.totalSupply();
    await ctx.vault.connect(ctx.operator).settleWager(data.wagerId, 0);
    expect(supplyBefore - await ctx.token.totalSupply()).to.equal(e(100_000));
    expect(await ctx.token.balanceOf(ctx.rewards.address)).to.equal(e(50_000));
    expect(await ctx.vault.isSolvent()).to.equal(true);
  });

  it("allows an expired wager refund and protects reserved bankroll", async function () {
    const ctx = await fixture();
    const data = await commitAndBet(ctx, "refund");
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 61]);
    await ethers.provider.send("evm_mine");
    await ctx.vault.connect(ctx.player).refundExpiredWager(data.wagerId);
    expect(await ctx.vault.claimable(ctx.player.address)).to.equal(data.amount);
    await expect(ctx.vault.connect(ctx.treasury).withdrawBankroll(await ctx.token.balanceOf(await ctx.vault.getAddress()))).to.be.revertedWithCustomError(ctx.vault, "InsufficientBankroll");
  });

  it("uses pull withdrawals for player payouts", async function () {
    const ctx = await fixture();
    const data = await commitAndBet(ctx, "withdraw");
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 61]);
    await ethers.provider.send("evm_mine");
    await ctx.vault.connect(ctx.player).refundExpiredWager(data.wagerId);
    const before = await ctx.token.balanceOf(ctx.player.address);
    await ctx.vault.connect(ctx.player).withdraw();
    expect(await ctx.token.balanceOf(ctx.player.address) - before).to.equal(data.amount);
    expect(await ctx.vault.claimable(ctx.player.address)).to.equal(0);
  });
});
