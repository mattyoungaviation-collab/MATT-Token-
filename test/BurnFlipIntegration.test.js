const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BurnFlip integration", function () {
  it("wires asset pool, game, treasury, and vault without retaining wager assets", async function () {
    const [admin, treasury, player] = await ethers.getSigners();
    const Matt = await ethers.getContractFactory("MockBurnableToken");
    const matt = await Matt.deploy();
    const Token = await ethers.getContractFactory("MockMattToken");
    const wager = await Token.deploy();
    const wrappedRon = await Token.deploy();
    const Vault = await ethers.getContractFactory("MattRewardVault");
    const vault = await Vault.deploy(matt.target, admin.address);
    const Game = await ethers.getContractFactory("MattCoinFlipBurn");
    const game = await Game.deploy(
      matt.target,
      wrappedRon.target,
      admin.address,
      treasury.address,
      vault.target,
      admin.address,
    );
    await vault.configureBurnFlip(game.target);
    await matt.mint(admin.address, ethers.parseEther("10000"));
    await matt.approve(vault.target, ethers.MaxUint256);
    await vault.ownerRefill(ethers.parseEther("10000"));
    await vault.unpause();

    const Pool = await ethers.getContractFactory("MockKatanaV3Pool");
    const pool = await Pool.deploy(
      admin.address,
      wager.target,
      matt.target,
      0,
      ethers.parseEther("1000000"),
    );
    await game.addSupportedAsset(wager.target, pool.target, 1);
    await game.unpause();

    const amount = ethers.parseEther("500");
    await wager.mint(player.address, amount);
    await wager.connect(player).approve(game.target, amount);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const secret = ethers.keccak256(ethers.toUtf8Bytes("integration"));
    const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint8", "uint256", "address", "uint256"],
      [secret, player.address, wager.target, 0, amount, game.target, chainId],
    ));
    await game.connect(player).placeBet(wager.target, 0, amount, commitment);

    expect(await wager.balanceOf(treasury.address)).to.equal(amount);
    expect(await wager.balanceOf(game.target)).to.equal(0);
    expect(await matt.balanceOf(game.target)).to.equal(0);
    expect(await game.reservedPayouts()).to.equal(amount * 2n);
    expect(await matt.balanceOf(vault.target)).to.equal(ethers.parseEther("10000"));
  });

  it("reuses a funded vault when migrating to MATT-enabled BurnFlip", async function () {
    const [admin, treasury, player] = await ethers.getSigners();
    const Matt = await ethers.getContractFactory("MockBurnableToken");
    const matt = await Matt.deploy();
    const Token = await ethers.getContractFactory("MockMattToken");
    const wrappedRon = await Token.deploy();
    const Vault = await ethers.getContractFactory("MattRewardVault");
    const vault = await Vault.deploy(matt.target, admin.address);
    const Game = await ethers.getContractFactory("MattCoinFlipBurn");
    const previous = await Game.deploy(
      matt.target,
      wrappedRon.target,
      admin.address,
      treasury.address,
      vault.target,
      admin.address,
    );
    await vault.configureBurnFlip(previous.target);
    await matt.mint(admin.address, ethers.parseEther("20000"));
    await matt.approve(vault.target, ethers.MaxUint256);
    await vault.ownerRefill(ethers.parseEther("20000"));

    const replacement = await Game.deploy(
      matt.target,
      wrappedRon.target,
      admin.address,
      treasury.address,
      vault.target,
      admin.address,
    );
    await replacement.addSupportedAsset(matt.target, ethers.ZeroAddress, 0);
    await vault.configureBurnFlip(replacement.target);
    await vault.unpause();
    await replacement.unpause();

    const amount = ethers.parseEther("500");
    await matt.mint(player.address, amount);
    await matt.connect(player).approve(replacement.target, amount);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const secret = ethers.keccak256(ethers.toUtf8Bytes("matt-migration"));
    const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint8", "uint256", "address", "uint256"],
      [secret, player.address, matt.target, 0, amount, replacement.target, chainId],
    ));
    const treasuryBefore = await matt.balanceOf(treasury.address);
    await replacement.connect(player).placeBet(
      matt.target,
      0,
      amount,
      commitment,
    );

    expect(await vault.burnFlip()).to.equal(replacement.target);
    expect(await matt.balanceOf(vault.target)).to.equal(ethers.parseEther("20000"));
    expect(await matt.balanceOf(treasury.address)).to.equal(treasuryBefore + amount);
    expect(await matt.balanceOf(replacement.target)).to.equal(0);
    expect(await replacement.reservedPayouts()).to.equal(amount * 2n);
  });
});
