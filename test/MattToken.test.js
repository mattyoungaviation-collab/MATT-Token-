const { expect } = require("chai");
const { ethers } = require("hardhat");

const SUPPLY = ethers.parseEther("10000000000");

describe("MattToken", function () {
  async function deployFixture() {
    const [deployer, treasury, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MattToken");
    const token = await Factory.deploy(treasury.address);
    await token.waitForDeployment();
    return { token, deployer, treasury, alice };
  }

  it("uses the intended identity and fixed supply", async function () {
    const { token, treasury } = await deployFixture();
    expect(await token.name()).to.equal("Matt");
    expect(await token.symbol()).to.equal("MATT");
    expect(await token.decimals()).to.equal(18);
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(treasury.address)).to.equal(SUPPLY);
  });

  it("allows holders to burn their own tokens", async function () {
    const { token, treasury } = await deployFixture();
    await token.connect(treasury).burn(ethers.parseEther("100"));
    expect(await token.totalSupply()).to.equal(SUPPLY - ethers.parseEther("100"));
  });

  it("supports ERC-2612 permit nonces and domain separator", async function () {
    const { token, treasury } = await deployFixture();
    expect(await token.nonces(treasury.address)).to.equal(0);
    expect(await token.DOMAIN_SEPARATOR()).to.not.equal(ethers.ZeroHash);
  });

  it("rejects a zero-address treasury", async function () {
    const Factory = await ethers.getContractFactory("MattToken");
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("MATT: zero treasury");
  });

  it("contains no owner or external mint function", async function () {
    const { token } = await deployFixture();
    const names = token.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(names).not.to.include("owner");
    expect(names).not.to.include("mint");
    expect(names).not.to.include("pause");
  });
});
