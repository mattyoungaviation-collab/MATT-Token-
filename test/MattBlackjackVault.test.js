const { expect } = require("chai");
const { ethers } = require("hardhat");

const parse = ethers.parseEther;

async function deployFixture() {
  const [treasury, operator, player, other] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MattToken");
  const token = await Token.deploy(treasury.address);
  await token.waitForDeployment();

  const Vault = await ethers.getContractFactory("MattBlackjackVault");
  const vault = await Vault.deploy(await token.getAddress(), treasury.address, operator.address);
  await vault.waitForDeployment();

  const bankroll = parse("1000000");
  await token.connect(treasury).approve(await vault.getAddress(), bankroll);
  await vault.connect(treasury).fundBankroll(bankroll);
  await vault.connect(treasury).unpause();

  const playerFunds = parse("100000");
  await token.connect(treasury).transfer(player.address, playerFunds);
  await token.connect(player).approve(await vault.getAddress(), playerFunds);

  return { treasury, operator, player, other, token, vault, bankroll };
}

function round(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function open(vault, player, label, amount) {
  const roundId = round(label);
  const wagerId = ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "address"],
    [(await ethers.provider.getNetwork()).chainId, await vault.getAddress(), roundId, player.address]
  );
  await vault.connect(player).openWager(roundId, amount);
  return wagerId;
}

describe("MattBlackjackVault", function () {
  it("starts paused and owned by the treasury", async function () {
    const [treasury, operator] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MattToken");
    const token = await Token.deploy(treasury.address);
    const Vault = await ethers.getContractFactory("MattBlackjackVault");
    const vault = await Vault.deploy(await token.getAddress(), treasury.address, operator.address);
    expect(await vault.paused()).to.equal(true);
    expect(await vault.owner()).to.equal(treasury.address);
  });

  it("burns the full wager on a loss", async function () {
    const { operator, player, token, vault } = await deployFixture();
    const amount = parse("1000");
    const supplyBefore = await token.totalSupply();
    const wagerId = await open(vault, player, "loss", amount);

    await vault.connect(operator).settleWager(wagerId, 0);

    expect(await token.totalSupply()).to.equal(supplyBefore - amount);
    expect(await vault.totalBurned()).to.equal(amount);
    expect(await vault.claimable(player.address)).to.equal(0);
  });

  it("returns half and burns half on surrender", async function () {
    const { operator, player, token, vault } = await deployFixture();
    const amount = parse("1001");
    const wagerId = await open(vault, player, "surrender", amount);
    const supplyBefore = await token.totalSupply();

    await vault.connect(operator).settleWager(wagerId, 1);

    const returned = amount / 2n;
    expect(await vault.claimable(player.address)).to.equal(returned);
    expect(await token.totalSupply()).to.equal(supplyBefore - (amount - returned));
  });

  it("returns principal on a push", async function () {
    const { operator, player, vault } = await deployFixture();
    const amount = parse("1000");
    const wagerId = await open(vault, player, "push", amount);

    await vault.connect(operator).settleWager(wagerId, 2);
    expect(await vault.claimable(player.address)).to.equal(amount);
  });

  it("credits principal plus equal profit on a win", async function () {
    const { operator, player, vault } = await deployFixture();
    const amount = parse("1000");
    const wagerId = await open(vault, player, "win", amount);

    await vault.connect(operator).settleWager(wagerId, 3);
    expect(await vault.claimable(player.address)).to.equal(amount * 2n);
  });

  it("credits principal plus 3:2 profit on blackjack", async function () {
    const { operator, player, vault } = await deployFixture();
    const amount = parse("1000");
    const wagerId = await open(vault, player, "blackjack", amount);

    await vault.connect(operator).settleWager(wagerId, 4);
    expect(await vault.claimable(player.address)).to.equal(amount + (amount * 3n) / 2n);
  });

  it("prevents treasury withdrawals from consuming reserved profit", async function () {
    const { treasury, player, vault, bankroll } = await deployFixture();
    const amount = parse("1000");
    await open(vault, player, "reserved", amount);
    const reserved = (amount * 3n) / 2n;

    await expect(vault.connect(treasury).withdrawBankroll(bankroll - reserved + 1n))
      .to.be.revertedWithCustomError(vault, "InsufficientBankroll");
  });

  it("rejects wagers when free bankroll cannot cover maximum blackjack profit", async function () {
    const { treasury, operator, player, token } = await ethers.getSigners().then(async signers => {
      const [treasury, operator, player] = signers;
      const Token = await ethers.getContractFactory("MattToken");
      const token = await Token.deploy(treasury.address);
      return { treasury, operator, player, token };
    });
    const Vault = await ethers.getContractFactory("MattBlackjackVault");
    const vault = await Vault.deploy(await token.getAddress(), treasury.address, operator.address);
    await token.connect(treasury).approve(await vault.getAddress(), parse("100"));
    await vault.connect(treasury).fundBankroll(parse("100"));
    await vault.connect(treasury).unpause();
    await token.connect(treasury).transfer(player.address, parse("100"));
    await token.connect(player).approve(await vault.getAddress(), parse("100"));

    await expect(vault.connect(player).openWager(round("too-large"), parse("100")))
      .to.be.revertedWithCustomError(vault, "InsufficientBankroll");
  });

  it("allows an expired wager refund and player withdrawal", async function () {
    const { player, token, vault } = await deployFixture();
    const amount = parse("1000");
    const wagerId = await open(vault, player, "refund", amount);
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine");

    await vault.connect(player).refundExpiredWager(wagerId);
    const before = await token.balanceOf(player.address);
    await vault.connect(player).withdraw();
    expect(await token.balanceOf(player.address)).to.equal(before + amount);
  });

  it("blocks settlement replay and unauthorized settlement", async function () {
    const { operator, player, other, vault } = await deployFixture();
    const wagerId = await open(vault, player, "replay", parse("1000"));

    await expect(vault.connect(other).settleWager(wagerId, 2))
      .to.be.revertedWithCustomError(vault, "Unauthorized");
    await vault.connect(operator).settleWager(wagerId, 2);
    await expect(vault.connect(operator).settleWager(wagerId, 2))
      .to.be.revertedWithCustomError(vault, "WagerNotOpen");
  });
});
