const { expect } = require("chai");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { ethers, network } = require("hardhat");

const BET_AMOUNT = ethers.parseEther("100");
const REWARD_AMOUNT = ethers.parseEther("2000000");

function commitmentFor({ secret, player, choice, amount, game, chainId }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "uint8", "uint256", "address", "uint256"],
      [secret, player, choice, amount, game, chainId]
    )
  );
}

async function deployFixture({ fundRewards = true } = {}) {
  const [owner, treasury, player, other] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MattToken");
  const token = await Token.deploy(treasury.address);
  await token.waitForDeployment();

  const Game = await ethers.getContractFactory("MattCoinFlip");
  const game = await Game.deploy(token.target, treasury.address, owner.address);
  await game.waitForDeployment();

  const Rewards = await ethers.getContractFactory("MattDailyRewards");
  const rewards = await Rewards.deploy(token.target, game.target, owner.address);
  await rewards.waitForDeployment();

  await token.connect(treasury).transfer(player.address, ethers.parseEther("3000000"));
  await token.connect(treasury).transfer(other.address, ethers.parseEther("3000000"));
  await token.connect(treasury).approve(game.target, ethers.parseEther("5000000"));
  await game.connect(treasury).fundBankroll(ethers.parseEther("5000000"));
  await token.connect(player).approve(game.target, ethers.MaxUint256);
  await token.connect(other).approve(game.target, ethers.MaxUint256);

  if (fundRewards) {
    await token.connect(treasury).approve(rewards.target, ethers.parseEther("10000000"));
    await rewards.connect(treasury).fund(ethers.parseEther("10000000"));
  }

  const chainId = (await ethers.provider.getNetwork()).chainId;
  return { owner, treasury, player, other, token, game, rewards, chainId };
}

async function placeAndSettle({ game, player, chainId, label, choice = 0 }) {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  const commitment = commitmentFor({
    secret,
    player: player.address,
    choice,
    amount: BET_AMOUNT,
    game: game.target,
    chainId,
  });

  const tx = await game.connect(player).placeBet(choice, BET_AMOUNT, commitment);
  const receipt = await tx.wait();
  const placed = receipt.logs
    .map(log => {
      try { return game.interface.parseLog(log); } catch { return null; }
    })
    .find(parsed => parsed?.name === "BetPlaced");
  const betId = placed.args.betId;
  const bet = await game.bets(betId);
  const current = await ethers.provider.getBlockNumber();
  const blocks = Number(bet.entropyBlock) + 1 - current;
  if (blocks > 0) await network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
  await game.connect(player).revealAndSettle(betId, secret);
  return betId;
}

describe("MattDailyRewards", function () {
  it("pays exactly 2,000,000 MATT for a newly settled player bet", async function () {
    const { player, token, game, rewards, chainId } = await deployFixture();
    const betId = await placeAndSettle({ game, player, chainId, label: "daily-one" });
    const before = await token.balanceOf(player.address);

    await expect(rewards.connect(player).claim(betId, true))
      .to.emit(rewards, "RewardClaimed")
      .withArgs(player.address, betId, REWARD_AMOUNT, anyValue, anyValue);

    expect(await token.balanceOf(player.address)).to.equal(before + REWARD_AMOUNT);
    expect(await rewards.lastUsedBetId(player.address)).to.equal(betId);
    expect(await rewards.usedBetId(betId)).to.equal(true);
    expect(await rewards.totalClaims()).to.equal(1);
  });

  it("requires the follow confirmation and a settled bet owned by the caller", async function () {
    const { player, other, game, rewards, chainId } = await deployFixture();
    const betId = await placeAndSettle({ game, player, chainId, label: "daily-two" });

    await expect(rewards.connect(player).claim(betId, false))
      .to.be.revertedWithCustomError(rewards, "FollowNotConfirmed");
    await expect(rewards.connect(other).claim(betId, true))
      .to.be.revertedWithCustomError(rewards, "BetNotOwnedByCaller");
  });

  it("rejects pending and reused bets", async function () {
    const { player, game, rewards, chainId } = await deployFixture();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("pending"));
    const commitment = commitmentFor({
      secret,
      player: player.address,
      choice: 0,
      amount: BET_AMOUNT,
      game: game.target,
      chainId,
    });
    await game.connect(player).placeBet(0, BET_AMOUNT, commitment);

    await expect(rewards.connect(player).claim(1, true))
      .to.be.revertedWithCustomError(rewards, "BetNotSettled");

    const bet = await game.bets(1);
    const current = await ethers.provider.getBlockNumber();
    const blocks = Number(bet.entropyBlock) + 1 - current;
    if (blocks > 0) await network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
    await game.connect(player).revealAndSettle(1, secret);
    await rewards.connect(player).claim(1, true);

    await network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await network.provider.send("evm_mine");
    await expect(rewards.connect(player).claim(1, true))
      .to.be.revertedWithCustomError(rewards, "BetAlreadyUsed");
  });

  it("enforces the full 24-hour cooldown and accepts a new settled bet afterward", async function () {
    const { player, game, rewards, chainId } = await deployFixture();
    const firstBetId = await placeAndSettle({ game, player, chainId, label: "cooldown-one" });
    await rewards.connect(player).claim(firstBetId, true);

    const secondBetId = await placeAndSettle({ game, player, chainId, label: "cooldown-two", choice: 1 });
    await expect(rewards.connect(player).claim(secondBetId, true))
      .to.be.revertedWithCustomError(rewards, "CooldownActive");

    await network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await network.provider.send("evm_mine");
    await expect(rewards.connect(player).claim(secondBetId, true)).to.emit(rewards, "RewardClaimed");
    expect(await rewards.totalClaims()).to.equal(2);
  });

  it("fails safely when the reward pool is underfunded", async function () {
    const { player, game, rewards, chainId } = await deployFixture({ fundRewards: false });
    const betId = await placeAndSettle({ game, player, chainId, label: "empty-pool" });
    await expect(rewards.connect(player).claim(betId, true))
      .to.be.revertedWithCustomError(rewards, "InsufficientRewardPool");
  });
});
