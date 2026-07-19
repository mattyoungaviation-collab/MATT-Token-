const { expect } = require("chai");
const { ethers } = require("hardhat");

async function advance(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("MattRockPaperScissors", function () {
  let token, rps, owner, treasury, alice, bob;
  const WAGER = ethers.parseEther("25000");

  beforeEach(async function () {
    [owner, treasury, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockMattToken");
    token = await Token.deploy();
    const RPS = await ethers.getContractFactory("MattRockPaperScissors");
    rps = await RPS.deploy(await token.getAddress(), treasury.address, owner.address);
    for (const player of [alice, bob]) {
      await token.mint(player.address, ethers.parseEther("100000"));
      await token.connect(player).approve(await rps.getAddress(), ethers.MaxUint256);
    }
  });

  async function fundedGame() {
    await rps.connect(alice).createGame();
    await rps.connect(bob).acceptGame(1);
    await rps.connect(alice).fundGame(1);
    await rps.connect(bob).fundGame(1);
  }

  function salt(label) { return ethers.keccak256(ethers.toUtf8Bytes(label)); }

  async function commit(player, move, secret) {
    const game = await rps.getGame(1);
    const hash = await rps.makeCommitment(1, game.round, player.address, move, secret);
    await rps.connect(player).commitMove(1, hash);
  }

  it("does not collect MATT until players fund after acceptance", async function () {
    await rps.connect(alice).createGame();
    expect(await token.balanceOf(await rps.getAddress())).to.equal(0);
    await rps.connect(bob).acceptGame(1);
    expect(await token.balanceOf(await rps.getAddress())).to.equal(0);
    await rps.connect(alice).fundGame(1);
    expect(await token.balanceOf(await rps.getAddress())).to.equal(WAGER);
  });

  it("pays 90% to the winner and 10% to treasury", async function () {
    await fundedGame();
    const aSalt = salt("alice-rock");
    const bSalt = salt("bob-scissors");
    await commit(alice, 1, aSalt);
    await commit(bob, 3, bSalt);
    await rps.connect(alice).revealMove(1, 1, aSalt);
    await rps.connect(bob).revealMove(1, 3, bSalt);
    expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther("5000"));
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("120000"));
    expect((await rps.getGame(1)).winner).to.equal(alice.address);
  });

  it("refunds the only funded player after funding timeout", async function () {
    await rps.connect(alice).createGame();
    await rps.connect(bob).acceptGame(1);
    await rps.connect(alice).fundGame(1);
    await advance(61);
    await rps.claimFundingTimeout(1);
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("100000"));
  });

  it("awards a commit-timeout win to the only player who committed", async function () {
    await fundedGame();
    await commit(alice, 1, salt("only-alice"));
    await advance(31);
    await rps.claimCommitTimeout(1);
    expect((await rps.getGame(1)).winner).to.equal(alice.address);
  });

  it("awards a reveal-timeout win to the only player who revealed", async function () {
    await fundedGame();
    const aSalt = salt("a");
    const bSalt = salt("b");
    await commit(alice, 1, aSalt);
    await commit(bob, 2, bSalt);
    await rps.connect(alice).revealMove(1, 1, aSalt);
    await advance(31);
    await rps.claimRevealTimeout(1);
    expect((await rps.getGame(1)).winner).to.equal(alice.address);
  });

  it("starts a new hidden-choice round after a tie", async function () {
    await fundedGame();
    const aSalt = salt("tie-a");
    const bSalt = salt("tie-b");
    await commit(alice, 2, aSalt);
    await commit(bob, 2, bSalt);
    await rps.connect(alice).revealMove(1, 2, aSalt);
    await rps.connect(bob).revealMove(1, 2, bSalt);
    const game = await rps.getGame(1);
    expect(game.round).to.equal(2);
    expect(game.status).to.equal(3);
    expect(game.creatorCommitment).to.equal(ethers.ZeroHash);
  });

  it("rejects a reveal that does not match the commitment", async function () {
    await fundedGame();
    const aSalt = salt("real-secret");
    const bSalt = salt("b-secret");
    await commit(alice, 1, aSalt);
    await commit(bob, 2, bSalt);
    await expect(rps.connect(alice).revealMove(1, 2, aSalt)).to.be.revertedWithCustomError(rps, "InvalidReveal");
  });

  it("prevents owner withdrawal of escrowed MATT", async function () {
    await expect(rps.recoverToken(await token.getAddress(), owner.address, 1)).to.be.revertedWithCustomError(rps, "MattLocked");
  });
});
