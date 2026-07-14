const { expect } = require("chai");
const { ethers, network } = require("hardhat");

function commitmentFor({ secret, player, choice, amount, game, chainId }) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint8", "uint256", "address", "uint256"],
    [secret, player, choice, amount, game, chainId]
  ));
}

async function mineAfter(blockNumber) {
  const current = await ethers.provider.getBlockNumber();
  const count = Number(blockNumber) + 1 - current;
  if (count > 0) await network.provider.send("hardhat_mine", [`0x${count.toString(16)}`]);
}

async function fixture() {
  const [owner, treasury, player, other] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MattToken");
  const token = await Token.deploy(treasury.address);
  await token.waitForDeployment();
  const Game = await ethers.getContractFactory("MattCoinFlipBurn");
  const game = await Game.deploy(token.target, owner.address);
  await game.waitForDeployment();

  const bankroll = ethers.parseEther("3000000000");
  await token.connect(treasury).approve(game.target, bankroll);
  await game.connect(treasury).fundBankroll(bankroll);
  await token.connect(treasury).transfer(player.address, ethers.parseEther("2000000000"));
  await token.connect(player).approve(game.target, ethers.MaxUint256);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return { owner, treasury, player, other, token, game, chainId };
}

async function place({ game, player, chainId, amount, choice = 0, label = "secret" }) {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  const commitment = commitmentFor({ secret, player: player.address, choice, amount, game: game.target, chainId });
  const tx = await game.connect(player).placeBet(choice, amount, commitment);
  const receipt = await tx.wait();
  const event = receipt.logs.map(log => { try { return game.interface.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === "BetPlaced");
  return { betId: event.args.betId, secret };
}

describe("MattCoinFlipBurn", function () {
  it("accepts bets above the old one-million cap when bankroll supports them", async function () {
    const { player, game, chainId } = await fixture();
    const amount = ethers.parseEther("1000000000");
    await expect(place({ game, player, chainId, amount, label: "large" })).to.not.be.rejected;
    expect(await game.reservedPayouts()).to.equal(amount * 2n);
  });

  it("limits the maximum bet only by available bankroll", async function () {
    const { game } = await fixture();
    expect(await game.maxAcceptableBet()).to.equal(ethers.parseEther("3000000000"));
  });

  it("permanently burns a losing stake and reduces total supply", async function () {
    const { player, token, game, chainId } = await fixture();
    const amount = ethers.parseEther("10000000");
    let foundLoss = false;

    for (let i = 0; i < 20 && !foundLoss; i += 1) {
      const { betId, secret } = await place({ game, player, chainId, amount, choice: 0, label: `loss-${i}` });
      const bet = await game.bets(betId);
      await mineAfter(bet.entropyBlock);
      const entropy = await ethers.provider.getBlock(Number(bet.entropyBlock));
      const random = BigInt(ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32", "uint256", "address", "uint256"],
        [secret, entropy.hash, betId, game.target, chainId]
      ));
      const supplyBefore = await token.totalSupply();
      await game.connect(player).revealAndSettle(betId, secret);
      if (Number(random & 1n) === 1) {
        foundLoss = true;
        expect(await token.totalSupply()).to.equal(supplyBefore - amount);
        expect(await game.totalBurnedByGame()).to.be.gte(amount);
      }
    }
    expect(foundLoss).to.equal(true);
  });

  it("burns expired stakes and protects reserved liabilities", async function () {
    const { owner, player, token, game, chainId } = await fixture();
    const amount = ethers.parseEther("5000000");
    const { betId } = await place({ game, player, chainId, amount, label: "expire" });
    const available = await game.availableBankroll();
    await expect(game.connect(owner).withdrawAvailableBankroll(owner.address, available + 1n))
      .to.be.revertedWithCustomError(game, "WithdrawalExceedsAvailable");

    const bet = await game.bets(betId);
    await mineAfter(bet.revealDeadlineBlock);
    const supplyBefore = await token.totalSupply();
    await game.expireBet(betId);
    expect(await token.totalSupply()).to.equal(supplyBefore - amount);
    expect((await game.bets(betId)).state).to.equal(4);
  });
});
