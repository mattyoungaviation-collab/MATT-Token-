const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const NATIVE_RON = ethers.ZeroAddress;
const BPS = 10_000n;

function commitmentFor({ secret, player, asset, choice, amount, game, chainId }) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "address", "uint8", "uint256", "address", "uint256"],
    [secret, player, asset, choice, amount, game, chainId],
  ));
}

async function mineAfter(blockNumber) {
  const current = await ethers.provider.getBlockNumber();
  const count = Number(blockNumber) + 1 - current;
  if (count > 0) {
    await network.provider.send("hardhat_mine", [`0x${count.toString(16)}`]);
  }
}

async function fixture({ vaultFunds = ethers.parseEther("1000000") } = {}) {
  const [owner, treasury, player, other] = await ethers.getSigners();

  const Matt = await ethers.getContractFactory("MockBurnableToken");
  const matt = await Matt.deploy();
  const Asset = await ethers.getContractFactory("MockMattToken");
  const asset = await Asset.deploy();
  const wrappedRon = await Asset.deploy();

  const Vault = await ethers.getContractFactory("MattRewardVault");
  const vault = await Vault.deploy(matt.target, owner.address);
  const Game = await ethers.getContractFactory("MattCoinFlipBurn");
  const game = await Game.deploy(
    matt.target,
    wrappedRon.target,
    owner.address,
    treasury.address,
    vault.target,
    owner.address,
  );
  await vault.configureBurnFlip(game.target);

  await matt.mint(owner.address, vaultFunds);
  await matt.approve(vault.target, vaultFunds);
  await vault.ownerRefill(vaultFunds);
  await vault.unpause();

  const Pool = await ethers.getContractFactory("MockKatanaV3Pool");
  const assetPool = await Pool.deploy(
    owner.address,
    asset.target,
    matt.target,
    0,
    ethers.parseEther("1000000"),
  );
  const ronPool = await Pool.deploy(
    owner.address,
    matt.target,
    wrappedRon.target,
    0,
    ethers.parseEther("1000000"),
  );
  await game.addSupportedAsset(asset.target, assetPool.target, 1);
  await game.addSupportedAsset(NATIVE_RON, ronPool.target, 1);
  await game.unpause();

  await asset.mint(player.address, ethers.parseEther("100000"));
  await asset.connect(player).approve(game.target, ethers.MaxUint256);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return {
    owner,
    treasury,
    player,
    other,
    matt,
    asset,
    wrappedRon,
    vault,
    game,
    assetPool,
    ronPool,
    chainId,
  };
}

async function placeErc20({
  game,
  asset,
  player,
  chainId,
  amount,
  choice = 0,
  label = "secret",
}) {
  const secret = ethers.keccak256(ethers.toUtf8Bytes(label));
  const commitment = commitmentFor({
    secret,
    player: player.address,
    asset: asset.target,
    choice,
    amount,
    game: game.target,
    chainId,
  });
  const tx = await game.connect(player).placeBet(
    asset.target,
    choice,
    amount,
    commitment,
  );
  const receipt = await tx.wait();
  const event = receipt.logs.map((log) => {
    try { return game.interface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "BetPlaced");
  return { betId: event.args.betId, secret };
}

async function settleDesiredOutcome(context, desiredWin) {
  const amount = ethers.parseEther("100");
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const placed = await placeErc20({
      ...context,
      amount,
      choice: 0,
      label: `${desiredWin ? "win" : "loss"}-${attempt}`,
    });
    const bet = await context.game.bets(placed.betId);
    await mineAfter(bet.entropyBlock);
    const entropy = await ethers.provider.getBlock(Number(bet.entropyBlock));
    const random = BigInt(ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "uint256", "address", "uint256"],
      [
        placed.secret,
        entropy.hash,
        placed.betId,
        context.game.target,
        context.chainId,
      ],
    ));
    const willWin = (random & 1n) === 0n;
    await context.game.connect(context.player).revealAndSettle(
      placed.betId,
      placed.secret,
    );
    if (willWin === desiredWin) return { ...placed, amount };
  }
  throw new Error(`Could not obtain desired ${desiredWin ? "win" : "loss"}`);
}

describe("MattCoinFlipBurn", function () {
  it("forwards ERC-20 wagers directly to treasury and stores a MATT TWAP quote", async function () {
    const context = await fixture();
    const amount = ethers.parseEther("500");
    const treasuryBefore = await context.asset.balanceOf(context.treasury.address);
    const { betId } = await placeErc20({ ...context, amount });
    const bet = await context.game.bets(betId);

    expect(await context.asset.balanceOf(context.game.target)).to.equal(0);
    expect(await context.asset.balanceOf(context.treasury.address))
      .to.equal(treasuryBefore + amount);
    expect(bet.asset).to.equal(context.asset.target);
    expect(bet.wagerAmount).to.equal(amount);
    expect(bet.mattEquivalent).to.equal(amount);
    expect(bet.payoutAmount).to.equal(amount * 2n);
    expect(bet.burnAmount).to.equal(amount * 75n / 100n);
  });

  it("forwards native RON to treasury in the placement transaction", async function () {
    const context = await fixture();
    const amount = ethers.parseEther("2");
    const secret = ethers.keccak256(ethers.toUtf8Bytes("ron-secret"));
    const commitment = commitmentFor({
      secret,
      player: context.player.address,
      asset: NATIVE_RON,
      choice: 1,
      amount,
      game: context.game.target,
      chainId: context.chainId,
    });
    const before = await ethers.provider.getBalance(context.treasury.address);
    await context.game.connect(context.player).placeRonBet(1, commitment, {
      value: amount,
    });
    expect(await ethers.provider.getBalance(context.treasury.address))
      .to.equal(before + amount);
    expect(await ethers.provider.getBalance(context.game.target)).to.equal(0);
  });

  it("pays a winner only in MATT from the reward vault", async function () {
    const context = await fixture();
    const playerMattBefore = await context.matt.balanceOf(context.player.address);
    const result = await settleDesiredOutcome(context, true);
    expect(await context.matt.balanceOf(context.player.address))
      .to.equal(playerMattBefore + result.amount * 2n);
    expect(await context.game.totalMattPaid()).to.be.gte(result.amount * 2n);
    expect(await context.game.reservedPayouts()).to.equal(0);
  });

  it("burns 75% of the stored MATT equivalent after a loss", async function () {
    const context = await fixture();
    const supplyBefore = await context.matt.totalSupply();
    const result = await settleDesiredOutcome(context, false);
    const burned = result.amount * 7_500n / BPS;
    expect(await context.matt.totalSupply()).to.equal(supplyBefore - burned);
    expect(await context.game.totalMattBurned()).to.be.gte(burned);
  });

  it("burns the configured loss amount when an unrevealed bet expires", async function () {
    const context = await fixture();
    const amount = ethers.parseEther("200");
    const { betId } = await placeErc20({ ...context, amount, label: "expire" });
    const bet = await context.game.bets(betId);
    await mineAfter(bet.revealDeadlineBlock);
    const supplyBefore = await context.matt.totalSupply();
    await context.game.connect(context.other).expireBet(betId);
    expect(await context.matt.totalSupply())
      .to.equal(supplyBefore - amount * 75n / 100n);
    expect((await context.game.bets(betId)).state).to.equal(4);
  });

  it("rejects unsupported assets, noncanonical pools, and thin TWAP liquidity", async function () {
    const context = await fixture();
    await expect(context.game.quoteMatt(context.other.address, 1))
      .to.be.revertedWithCustomError(context.game, "UnsupportedAsset");

    await context.game.pause();
    const Pool = await ethers.getContractFactory("MockKatanaV3Pool");
    const wrongFactory = await Pool.deploy(
      context.other.address,
      context.asset.target,
      context.matt.target,
      0,
      1000,
    );
    await expect(context.game.addSupportedAsset(
      context.other.address,
      wrongFactory.target,
      1,
    )).to.be.revertedWithCustomError(context.game, "InvalidPoolFactory");

    await context.assetPool.setOracle(0, 10);
    await context.game.updateV3Pool(context.asset.target, context.assetPool.target, 11);
    await context.game.unpause();
    await expect(context.game.quoteMatt(context.asset.target, 100))
      .to.be.revertedWithCustomError(context.game, "OracleLiquidityTooLow");
  });

  it("reserves maximum winner liabilities and rejects underfunded wagers", async function () {
    const context = await fixture({ vaultFunds: ethers.parseEther("100") });
    await expect(placeErc20({
      ...context,
      amount: ethers.parseEther("51"),
      label: "too-large",
    })).to.be.revertedWithCustomError(context.game, "InsufficientRewardVault");
  });

  it("restricts administration and starts safely paused", async function () {
    const [owner, treasury, other] = await ethers.getSigners();
    const Matt = await ethers.getContractFactory("MockBurnableToken");
    const matt = await Matt.deploy();
    const Asset = await ethers.getContractFactory("MockMattToken");
    const wrapped = await Asset.deploy();
    const Vault = await ethers.getContractFactory("MattRewardVault");
    const vault = await Vault.deploy(matt.target, owner.address);
    const Game = await ethers.getContractFactory("MattCoinFlipBurn");
    const game = await Game.deploy(
      matt.target,
      wrapped.target,
      owner.address,
      treasury.address,
      vault.target,
      owner.address,
    );
    expect(await game.paused()).to.equal(true);
    expect(await vault.paused()).to.equal(true);
    await expect(game.connect(other).configureBurnBps(5000))
      .to.be.revertedWithCustomError(game, "OwnableUnauthorizedAccount");
    await expect(vault.connect(other).configureBurnFlip(game.target))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });
});
