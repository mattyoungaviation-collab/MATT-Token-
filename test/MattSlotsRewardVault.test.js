const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MattSlotsRewardVault", function () {
  let token, converter, vault, controller, player, owner;
  beforeEach(async function () {
    [owner, controller, player] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockMattToken")).deploy();
    converter = await (await ethers.getContractFactory("MockSlotsLossConverter")).deploy();
    vault = await (await ethers.getContractFactory("MattSlotsRewardVault")).deploy(
      await token.getAddress(), await converter.getAddress(), owner.address
    );
    // Vault requires a contract controller; use a deployed mock source and impersonate through helper is not needed here.
  });

  it("starts with no unprotected MATT and rejects a non-contract controller", async function () {
    await expect(vault.setController(controller.address)).to.be.revertedWithCustomError(vault, "InvalidAddress");
    expect(await vault.protectedBalance()).to.equal(0);
    expect(await vault.availableBankroll()).to.equal(0);
  });
});
