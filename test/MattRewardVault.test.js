const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MattRewardVault", function () {
  async function fixture() {
    const [owner, burnFlip, winner, other] = await ethers.getSigners();
    const Matt = await ethers.getContractFactory("MockBurnableToken");
    const matt = await Matt.deploy();
    const Vault = await ethers.getContractFactory("MattRewardVault");
    const vault = await Vault.deploy(matt.target, owner.address);
    await vault.configureBurnFlip(burnFlip.address);
    await matt.mint(owner.address, ethers.parseEther("1000"));
    await matt.approve(vault.target, ethers.MaxUint256);
    await vault.ownerRefill(ethers.parseEther("1000"));
    await vault.unpause();
    return { owner, burnFlip, winner, other, matt, vault };
  }

  it("allows only BurnFlip to pay winners and burn vault-owned MATT", async function () {
    const { burnFlip, winner, other, matt, vault } = await fixture();
    await expect(vault.connect(other).payWinner(winner.address, 1))
      .to.be.revertedWithCustomError(vault, "UnauthorizedBurnFlip");
    await vault.connect(burnFlip).payWinner(winner.address, ethers.parseEther("20"));
    expect(await matt.balanceOf(winner.address)).to.equal(ethers.parseEther("20"));

    const supplyBefore = await matt.totalSupply();
    await vault.connect(burnFlip).burnMatt(ethers.parseEther("15"));
    expect(await matt.totalSupply()).to.equal(supplyBefore - ethers.parseEther("15"));
  });

  it("cannot rescue MATT through the accidental-token escape hatch", async function () {
    const { owner, matt, vault } = await fixture();
    await vault.connect(owner).pause();
    await expect(vault.rescueAccidentalToken(matt.target, 1))
      .to.be.revertedWithCustomError(vault, "CannotRescueMatt");
  });

  it("blocks settlement while emergency-paused", async function () {
    const { owner, burnFlip, winner, vault } = await fixture();
    await vault.connect(owner).pause();
    await expect(vault.connect(burnFlip).payWinner(winner.address, 1))
      .to.be.revertedWithCustomError(vault, "EnforcedPause");
  });
});
