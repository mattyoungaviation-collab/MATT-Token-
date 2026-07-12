const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE_MATT = ethers.parseEther("1");
const BET_AMOUNT = ethers.parseEther("100");

function commitmentFor({ secret, player, choice, amount, game, chainId }) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint8", "uint256", "address", "uint256"],
    [secret, player, choice, amount, game, chainId]
  );
  return ethers.keccak256(encoded);
}

async function mineUntilAfter(blockNumber) {
  const current = await ethers.provider.getBlockNumber();
  const blocks = Number(blockNumber) + 1 - current;
  if (blocks > 0) {
    await network.provider.send("hardhat_mine", [`0x${blocks.toString(16)}`]);
  }
}

async function deployFixture() {
  const [owner, treasury, player, other] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MattToken");
  const token = await Token.deploy(treasury.address);
  await token.waitForDeployment();

  const Game = await ethers.getContractFactory("MattCoinFlip");
  const game = await Game.deploy(token.target, treasury.address, owner.address);
  await game.waitForDeployment();

  await token.connect(treasury).transfer(player.address, ethers.parseEther("3000000"));
  await token.connect(treasury).approve(game.target, ethers.parseEther("5000000"));
  await game.connect(treasury).fundBankroll(ethers.parseEther("5000000"));
  await token.connect(player).approve(game.target, ethers.MaxUint256);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  return { owner, treasury, player, other, token, game, chainId };
}

async function placeBet({ game, player, chainId, choice, amount = BET_AMOUNT, secret }) {
  const commitment = commitmentFor({
    secret,
    player: player.address,
    choice,
    amount,
    game: game.target,
    chainId,
  });

  const tx = await game.connect(player).placeBet(choice, amount, commitment);
  const receipt = await tx.wait();
  const event = receipt.logs
    .map(log => {
      try {
        return game.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(parsed => parsed?.name === "BetPlaced");

  return { betId: event.args.betId, commitment };
}

async function predictedOutcome({ game, betId, secret, chainId }) {
  const bet = await game.bets(betId);
  await mineUntilAfter(bet.entropyBlock);
  const entropyBlock = await ethers.provider.getBlock(Number(bet.entropyBlock));
  const randomHash = ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32", "uint256", "address", "uint256"],
    [secret, entropyBlock.hash, betId, game.target, chainId]
  );
  return Number(BigInt(randomHash) & 1n);
}

describe("MattCoinFlip", function () {
  it("uses fixed MATT bet limits and immutable treasury routing", async function () {
    const { owner, treasury, token, game } = await deployFixture();

    expect(await game.matt()).to.equal(token.target);
    expect(await game.treasury()).to.equal(treasury.address);
    expect(await game.owner()).to.equal(owner.address);
    expect(await game.MIN_BET()).to.equal(ONE_MATT);
    expect(await game.MAX_BET()).to.equal(ethers.parseEther("1000000"));
    expect(await game.REVEAL_WINDOW_BLOCKS()).to.equal(200);
  });

  it("settles wins at 2x and routes losses to treasury", async function () {
    const { treasury, player, token, game, chainId } = await deployFixture();
    let sawWin = false;
    let sawLoss = false;

    for (let attempt = 0; attempt < 20 && !(sawWin && sawLoss); attempt += 1) {
      const secret = ethers.keccak256(ethers.toUtf8Bytes(`secret-${attempt}`));
      const choice = 0;
      const { betId } = await placeBet({ game, player, chainId, choice, secret });
      const outcome = await predictedOutcome({ game, betId, secret, chainId });

      const playerBefore = await token.balanceOf(player.address);
      const treasuryBefore = await token.balanceOf(treasury.address);
      const tx = await game.connect(player).revealAndSettle(betId, secret);
      const receipt = await tx.wait();
      const settled = receipt.logs
        .map(log => {
          try {
            return game.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find(parsed => parsed?.name === "BetSettled");

      expect(Number(settled.args.outcome)).to.equal(outcome);
      expect(await game.activeBetOf(player.address)).to.equal(0);

      if (outcome === choice) {
        sawWin = true;
        expect(settled.args.won).to.equal(true);
        expect(settled.args.payout).to.equal(BET_AMOUNT * 2n);
        expect(await token.balanceOf(player.address)).to.equal(playerBefore + BET_AMOUNT * 2n);
        expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore);
      } else {
        sawLoss = true;
        expect(settled.args.won).to.equal(false);
        expect(settled.args.payout).to.equal(0);
        expect(await token.balanceOf(player.address)).to.equal(playerBefore);
        expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + BET_AMOUNT);
      }
    }

    expect(sawWin).to.equal(true);
    expect(sawLoss).to.equal(true);
  });

  it("supports ERC-2612 permit when placing a bet", async function () {
    const { player, token, game, chainId } = await deployFixture();
    await token.connect(player).approve(game.target, 0);

    const secret = ethers.keccak256(ethers.toUtf8Bytes("permit-secret"));
    const choice = 1;
    const commitment = commitmentFor({
      secret,
      player: player.address,
      choice,
      amount: BET_AMOUNT,
      game: game.target,
      chainId,
    });

    const nonce = await token.nonces(player.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await player.signTypedData(
      {
        name: "Matt",
        version: "1",
        chainId,
        verifyingContract: token.target,
      },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        owner: player.address,
        spender: game.target,
        value: BET_AMOUNT,
        nonce,
        deadline,
      }
    );
    const parsed = ethers.Signature.from(signature);

    await expect(
      game
        .connect(player)
        .placeBetWithPermit(choice, BET_AMOUNT, commitment, deadline, parsed.v, parsed.r, parsed.s)
    ).to.emit(game, "BetPlaced");

    expect(await game.activeBetOf(player.address)).to.equal(1);
  });

  it("forfeits an unrevealed bet to treasury after the reveal window", async function () {
    const { treasury, player, other, token, game, chainId } = await deployFixture();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("expire-secret"));
    const { betId } = await placeBet({ game, player, chainId, choice: 0, secret });
    const bet = await game.bets(betId);

    await mineUntilAfter(Number(bet.revealDeadlineBlock));
    const treasuryBefore = await token.balanceOf(treasury.address);

    await expect(game.connect(other).expireBet(betId))
      .to.emit(game, "BetExpired")
      .withArgs(betId, player.address, BET_AMOUNT);

    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + BET_AMOUNT);
    expect((await game.bets(betId)).state).to.equal(4);
    expect(await game.activeBetOf(player.address)).to.equal(0);
  });

  it("protects pending liabilities from owner withdrawals", async function () {
    const { owner, player, game, chainId } = await deployFixture();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("reserve-secret"));
    await placeBet({ game, player, chainId, choice: 0, secret });

    const available = await game.availableBankroll();
    await expect(
      game.connect(owner).withdrawAvailableBankroll(owner.address, available + 1n)
    ).to.be.revertedWithCustomError(game, "WithdrawalExceedsAvailable");
  });

  it("rejects bets above one million MATT and multiple active bets", async function () {
    const { player, game, chainId } = await deployFixture();
    const tooLarge = ethers.parseEther("1000001");
    const secret = ethers.keccak256(ethers.toUtf8Bytes("too-large"));
    const badCommitment = commitmentFor({
      secret,
      player: player.address,
      choice: 0,
      amount: tooLarge,
      game: game.target,
      chainId,
    });

    await expect(game.connect(player).placeBet(0, tooLarge, badCommitment))
      .to.be.revertedWithCustomError(game, "BetAboveMaximum");

    await placeBet({
      game,
      player,
      chainId,
      choice: 0,
      secret: ethers.keccak256(ethers.toUtf8Bytes("first-active")),
    });

    await expect(
      placeBet({
        game,
        player,
        chainId,
        choice: 1,
        secret: ethers.keccak256(ethers.toUtf8Bytes("second-active")),
      })
    ).to.be.revertedWithCustomError(game, "ActiveBetExists");
  });
});
