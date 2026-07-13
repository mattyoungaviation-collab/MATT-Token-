const { expect } = require("chai");
const { ethers, network } = require("hardhat");

async function deployFixture() {
  const [owner, treasury, player, other, verifier] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MattToken");
  const token = await Token.deploy(treasury.address);
  const Game = await ethers.getContractFactory("MattCoinFlip");
  const game = await Game.deploy(token.target, treasury.address, owner.address);
  const Rewards = await ethers.getContractFactory("MattDailyRewardsV2");
  const rewards = await Rewards.deploy(token.target, game.target, verifier.address, owner.address);

  await token.connect(treasury).transfer(player.address, ethers.parseEther("10000"));
  await token.connect(treasury).transfer(other.address, ethers.parseEther("10000"));
  await token.connect(treasury).transfer(rewards.target, ethers.parseEther("5000000"));
  await token.connect(treasury).approve(game.target, ethers.parseEther("100000"));
  await game.connect(treasury).fundBankroll(ethers.parseEther("100000"));
  await token.connect(player).approve(game.target, ethers.MaxUint256);
  await token.connect(other).approve(game.target, ethers.MaxUint256);
  return { owner, treasury, player, other, verifier, token, game, rewards };
}

async function settledBet(game, player, label) {
  const amount = ethers.parseEther("1");
  const choice = 0;
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint8", "uint256", "address", "uint256"],
    [secret, player.address, choice, amount, game.target, chainId]
  ));
  const tx = await game.connect(player).placeBet(choice, amount, commitment);
  const receipt = await tx.wait();
  const parsed = receipt.logs.map(log => { try { return game.interface.parseLog(log); } catch { return null; } })
    .find(event => event?.name === "BetPlaced");
  const betId = parsed.args.betId;
  const bet = await game.bets(betId);
  const current = await ethers.provider.getBlockNumber();
  const blocks = Number(bet.entropyBlock) + 1 - current;
  if (blocks > 0) await network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
  await game.connect(player).revealAndSettle(betId, secret);
  return betId;
}

async function proof(rewards, verifier, wallet, betId, xUserId, deadlineOffset = 600) {
  const xUserHash = ethers.keccak256(ethers.toUtf8Bytes(xUserId));
  const block = await ethers.provider.getBlock("latest");
  const deadline = BigInt(block.timestamp + deadlineOffset);
  const digest = await rewards.followProofDigest(wallet, betId, xUserHash, deadline);
  const signature = await verifier.signMessage(ethers.getBytes(digest));
  return { xUserHash, deadline, signature };
}

describe("MattDailyRewardsV2", function () {
  it("pays exactly 1,000,000 MATT with a valid follow proof", async function () {
    const { player, verifier, token, game, rewards } = await deployFixture();
    const betId = await settledBet(game, player, "v2-valid");
    const signed = await proof(rewards, verifier, player.address, betId, "x-user-1");
    const before = await token.balanceOf(player.address);
    await expect(rewards.connect(player).claim(betId, signed.xUserHash, signed.deadline, signed.signature))
      .to.emit(rewards, "RewardClaimed");
    expect(await token.balanceOf(player.address)).to.equal(before + ethers.parseEther("1000000"));
    expect(await rewards.REWARD_AMOUNT()).to.equal(ethers.parseEther("1000000"));
  });

  it("rejects forged and expired proofs", async function () {
    const { player, other, verifier, game, rewards } = await deployFixture();
    const betId = await settledBet(game, player, "v2-forged");
    const signed = await proof(rewards, verifier, player.address, betId, "x-user-2");
    const forged = await other.signMessage(ethers.getBytes(await rewards.followProofDigest(player.address, betId, signed.xUserHash, signed.deadline)));
    await expect(rewards.connect(player).claim(betId, signed.xUserHash, signed.deadline, forged))
      .to.be.revertedWithCustomError(rewards, "InvalidFollowProof");

    const expired = await proof(rewards, verifier, player.address, betId, "x-user-2", -1);
    await expect(rewards.connect(player).claim(betId, expired.xUserHash, expired.deadline, expired.signature))
      .to.be.revertedWithCustomError(rewards, "ProofExpired");
  });

  it("prevents the same X account from being used by another wallet", async function () {
    const { player, other, verifier, game, rewards } = await deployFixture();
    const playerBet = await settledBet(game, player, "v2-player");
    const first = await proof(rewards, verifier, player.address, playerBet, "shared-x-user");
    await rewards.connect(player).claim(playerBet, first.xUserHash, first.deadline, first.signature);

    const otherBet = await settledBet(game, other, "v2-other");
    const second = await proof(rewards, verifier, other.address, otherBet, "shared-x-user");
    await expect(rewards.connect(other).claim(otherBet, second.xUserHash, second.deadline, second.signature))
      .to.be.revertedWithCustomError(rewards, "XAccountAlreadyBound");
  });

  it("still enforces settled bets, one-use bet IDs, and 24-hour cooldown", async function () {
    const { player, verifier, game, rewards } = await deployFixture();
    const firstBet = await settledBet(game, player, "v2-first");
    const first = await proof(rewards, verifier, player.address, firstBet, "x-user-3");
    await rewards.connect(player).claim(firstBet, first.xUserHash, first.deadline, first.signature);
    await expect(rewards.connect(player).claim(firstBet, first.xUserHash, first.deadline, first.signature))
      .to.be.revertedWithCustomError(rewards, "CooldownActive");

    await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await expect(rewards.connect(player).claim(firstBet, first.xUserHash, first.deadline, first.signature))
      .to.be.revertedWithCustomError(rewards, "ProofExpired");
  });
});