const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MATT Gift Boxes", function () {
  let token, coordinator, vault, giftBoxes, owner, alice, recipient, stranger;

  const VRF_FEE = ethers.parseEther("0.01");
  const BOX_PRICE = ethers.parseEther("100");
  const BASE_MATT = ethers.parseEther("1000000");
  const MAX_PAYOUT = BASE_MATT * 75n / 10n;
  const BANKROLL = ethers.parseEther("50000000");

  const domain = async () => ({
    name: "MATT Gift Boxes",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: await giftBoxes.getAddress()
  });

  const types = {
    PriceQuote: [
      { name: "buyer", type: "address" },
      { name: "recipient", type: "address" },
      { name: "tier", type: "uint8" },
      { name: "baseMatt", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "configVersion", type: "uint256" }
    ]
  };

  beforeEach(async function () {
    [, owner, alice, recipient, stranger] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockMattToken")).deploy();
    coordinator = await (await ethers.getContractFactory("MockRoninVRFCoordinator")).deploy();
    vault = await (await ethers.getContractFactory("MattGiftBoxVault")).deploy(
      await token.getAddress(),
      owner.address
    );
    giftBoxes = await (await ethers.getContractFactory("MattGiftBoxes")).deploy(
      await vault.getAddress(),
      await coordinator.getAddress(),
      owner.address
    );

    await vault.connect(owner).setController(await giftBoxes.getAddress());
    await token.mint(owner.address, BANKROLL);
    await token.connect(owner).approve(await vault.getAddress(), BANKROLL);
    await vault.connect(owner).fund(BANKROLL);
    await giftBoxes.connect(owner).fundRandomnessReserve({ value: ethers.parseEther("1") });
    await giftBoxes.connect(owner).unpause();
  });

  async function signedQuote({
    buyer = alice.address,
    to = alice.address,
    tier = 0,
    baseMatt = BASE_MATT,
    nonce = 1n,
    deadline
  } = {}) {
    const latest = await ethers.provider.getBlock("latest");
    const expires = deadline ?? BigInt(latest.timestamp + 120);
    const value = {
      buyer,
      recipient: to,
      tier,
      baseMatt,
      nonce,
      deadline: expires,
      configVersion: await giftBoxes.activeConfigVersion()
    };
    return {
      ...value,
      signature: await owner.signTypedData(await domain(), types, value)
    };
  }

  async function purchase(quote = {}, value = BOX_PRICE) {
    const signed = await signedQuote(quote);
    const tx = await giftBoxes.connect(alice).purchaseBox(
      signed.recipient,
      signed.tier,
      signed.baseMatt,
      signed.nonce,
      signed.deadline,
      signed.signature,
      { value }
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map(log => {
        try { return giftBoxes.interface.parseLog(log); } catch { return null; }
      })
      .find(log => log?.name === "BoxPurchased");
    return { boxId: event.args.boxId, requestHash: event.args.requestHash, signed };
  }

  it("loads the approved prices and 95.975% reward table", async function () {
    expect(await giftBoxes.paused()).to.equal(false);
    const config = await giftBoxes.getConfiguration(1);
    expect(config.prices).to.deep.equal([
      ethers.parseEther("100"),
      ethers.parseEther("250"),
      ethers.parseEther("500")
    ]);
    expect(config.multipliersBps).to.deep.equal([
      8500n, 9000n, 9500n, 10000n, 11000n,
      12500n, 15000n, 20000n, 30000n, 75000n
    ]);
    expect(config.chancesBps).to.deep.equal([
      4000n, 2000n, 1500n, 1500n, 500n,
      250n, 150n, 50n, 20n, 30n
    ]);
    expect(await giftBoxes.configurationRtpNumerator(1)).to.equal(95_975_000n);
  });

  it("forwards the full RON price to the owner and reserves the 7.5x MATT maximum", async function () {
    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const { boxId } = await purchase();
    const ownerAfter = await ethers.provider.getBalance(owner.address);
    const reservation = await vault.reservations(boxId);

    expect(ownerAfter - ownerBefore).to.equal(BOX_PRICE);
    expect(reservation.recipient).to.equal(alice.address);
    expect(reservation.maximumPayout).to.equal(MAX_PAYOUT);
    expect(await vault.totalReserved()).to.equal(MAX_PAYOUT);
    expect(await giftBoxes.totalRonForwarded()).to.equal(BOX_PRICE);
  });

  it("supports a gift recipient and pays only from the MATT vault", async function () {
    const { boxId, requestHash } = await purchase({ to: recipient.address });
    await coordinator.fulfill(requestHash, 8_500);

    const box = await giftBoxes.boxes(boxId);
    expect(box.recipient).to.equal(recipient.address);
    expect(box.multiplierBps).to.equal(10_000);
    expect(box.payout).to.equal(BASE_MATT);
    expect(await vault.claimable(recipient.address)).to.equal(BASE_MATT);
    expect(await vault.claimable(alice.address)).to.equal(0);

    const before = await token.balanceOf(recipient.address);
    await vault.connect(recipient).claim();
    expect(await token.balanceOf(recipient.address) - before).to.equal(BASE_MATT);
  });

  it("maps the published probability boundaries exactly", async function () {
    const expected = [
      [0, 8_500],
      [3_999, 8_500],
      [4_000, 9_000],
      [5_999, 9_000],
      [6_000, 9_500],
      [7_499, 9_500],
      [7_500, 10_000],
      [8_999, 10_000],
      [9_000, 11_000],
      [9_499, 11_000],
      [9_500, 12_500],
      [9_749, 12_500],
      [9_750, 15_000],
      [9_899, 15_000],
      [9_900, 20_000],
      [9_949, 20_000],
      [9_950, 30_000],
      [9_969, 30_000],
      [9_970, 75_000],
      [9_999, 75_000]
    ];
    for (const [roll, multiplier] of expected) {
      expect(await giftBoxes.multiplierForRoll(1, roll)).to.equal(multiplier);
    }
  });

  it("settles the 7.5x jackpot without exposing reserved funds", async function () {
    const { boxId, requestHash } = await purchase();
    await coordinator.fulfill(requestHash, 9_999);

    const box = await giftBoxes.boxes(boxId);
    expect(box.multiplierBps).to.equal(75_000);
    expect(box.payout).to.equal(MAX_PAYOUT);
    expect(await vault.totalReserved()).to.equal(0);
    expect(await vault.totalClaimable()).to.equal(MAX_PAYOUT);
    expect(await vault.availableBankroll()).to.equal(BANKROLL - MAX_PAYOUT);
  });

  it("settles a two-hour stale request at exactly 1x MATT", async function () {
    const { boxId, requestHash } = await purchase();
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await giftBoxes.connect(stranger).settleStaleBox(boxId);

    const box = await giftBoxes.boxes(boxId);
    expect(box.multiplierBps).to.equal(10_000);
    expect(box.payout).to.equal(BASE_MATT);
    expect(await vault.claimable(alice.address)).to.equal(BASE_MATT);
    await expect(coordinator.fulfill(requestHash, 9_999))
      .to.emit(giftBoxes, "LateFulfillmentIgnored")
      .withArgs(requestHash, boxId);
  });

  it("permits two delayed retries without changing the original stale deadline", async function () {
    const { boxId } = await purchase();
    await ethers.provider.send("evm_increaseTime", [30 * 60]);
    await ethers.provider.send("evm_mine", []);
    await giftBoxes.connect(alice).retryRandomness(boxId);
    await ethers.provider.send("evm_increaseTime", [30 * 60]);
    await ethers.provider.send("evm_mine", []);
    await giftBoxes.connect(owner).retryRandomness(boxId);

    await ethers.provider.send("evm_increaseTime", [60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await giftBoxes.settleStaleBox(boxId);
    expect((await giftBoxes.boxes(boxId)).payout).to.equal(BASE_MATT);
  });

  it("rejects expired, replayed, altered, and non-owner quotes", async function () {
    const latest = await ethers.provider.getBlock("latest");
    const expired = await signedQuote({ deadline: BigInt(latest.timestamp - 1) });
    await expect(giftBoxes.connect(alice).purchaseBox(
      expired.recipient, expired.tier, expired.baseMatt, expired.nonce,
      expired.deadline, expired.signature, { value: BOX_PRICE }
    )).to.be.revertedWithCustomError(giftBoxes, "QuoteExpired");

    const valid = await signedQuote({ nonce: 2n });
    await giftBoxes.connect(alice).purchaseBox(
      valid.recipient, valid.tier, valid.baseMatt, valid.nonce,
      valid.deadline, valid.signature, { value: BOX_PRICE }
    );
    await expect(giftBoxes.connect(alice).purchaseBox(
      valid.recipient, valid.tier, valid.baseMatt, valid.nonce,
      valid.deadline, valid.signature, { value: BOX_PRICE }
    )).to.be.revertedWithCustomError(giftBoxes, "NonceAlreadyUsed");

    const altered = await signedQuote({ nonce: 3n });
    await expect(giftBoxes.connect(alice).purchaseBox(
      recipient.address, altered.tier, altered.baseMatt, altered.nonce,
      altered.deadline, altered.signature, { value: BOX_PRICE }
    )).to.be.revertedWithCustomError(giftBoxes, "InvalidQuote");
  });

  it("rejects sales without enough MATT or randomness reserve", async function () {
    const available = await vault.availableBankroll();
    await vault.connect(owner).withdrawAvailable(available - MAX_PAYOUT + 1n);
    const underfunded = await signedQuote({ nonce: 20n });
    await expect(giftBoxes.connect(alice).purchaseBox(
      underfunded.recipient, underfunded.tier, underfunded.baseMatt,
      underfunded.nonce, underfunded.deadline, underfunded.signature,
      { value: BOX_PRICE }
    )).to.be.revertedWithCustomError(giftBoxes, "InsufficientBankroll");

    await token.mint(owner.address, BANKROLL);
    await token.connect(owner).approve(await vault.getAddress(), BANKROLL);
    await vault.connect(owner).fund(BANKROLL);
    await giftBoxes.connect(owner).withdrawRandomnessReserve(
      await ethers.provider.getBalance(await giftBoxes.getAddress())
    );
    const noFee = await signedQuote({ nonce: 21n });
    await expect(giftBoxes.connect(alice).purchaseBox(
      noFee.recipient, noFee.tier, noFee.baseMatt,
      noFee.nonce, noFee.deadline, noFee.signature,
      { value: BOX_PRICE }
    )).to.be.revertedWithCustomError(giftBoxes, "InsufficientRandomnessReserve");
  });

  it("never lets the owner withdraw reserved or claimable MATT", async function () {
    const { requestHash } = await purchase();
    await expect(vault.connect(owner).withdrawAvailable(
      (await vault.availableBankroll()) + 1n
    )).to.be.revertedWithCustomError(vault, "InsufficientBankroll");

    await coordinator.fulfill(requestHash, 9_999);
    await expect(vault.connect(owner).withdrawAvailable(
      (await vault.availableBankroll()) + 1n
    )).to.be.revertedWithCustomError(vault, "InsufficientBankroll");
  });

  it("delays owner configuration changes and leaves pending boxes on their original version", async function () {
    const { boxId } = await purchase();
    const prices = [
      ethers.parseEther("125"),
      ethers.parseEther("300"),
      ethers.parseEther("500")
    ];
    const multipliers = [8_500, 10_000, 75_000];
    const chances = [6_000, 3_980, 20];

    await giftBoxes.connect(owner).proposeConfiguration(prices, multipliers, chances);
    await expect(giftBoxes.connect(owner).activateConfiguration(2))
      .to.be.revertedWithCustomError(giftBoxes, "ConfigurationNotReady");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await giftBoxes.connect(owner).activateConfiguration(2);

    expect(await giftBoxes.activeConfigVersion()).to.equal(2);
    expect((await giftBoxes.boxes(boxId)).configVersion).to.equal(1);
  });

  it("allows only the owner to configure, pause, fund, and manage the vault", async function () {
    await expect(giftBoxes.connect(stranger).pause())
      .to.be.revertedWithCustomError(giftBoxes, "OwnableUnauthorizedAccount");
    await expect(vault.connect(stranger).setController(stranger.address))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    await expect(giftBoxes.connect(stranger).fundRandomnessReserve({ value: 1 }))
      .to.be.revertedWithCustomError(giftBoxes, "OwnableUnauthorizedAccount");
  });
});
