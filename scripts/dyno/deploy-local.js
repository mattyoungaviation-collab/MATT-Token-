"use strict";

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    throw new Error("deploy-local refuses non-local networks. Use reviewed production scripts and explicit authorization for live deployment.");
  }
  const { ethers } = hre;
  const [admin, identitySigner, reviewer, keeper, treasury] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockMattToken");
  const NFT = await ethers.getContractFactory("MockProjectDynoNFT");
  const Guard = await ethers.getContractFactory("MockProjectDynoPriceGuard");
  const Adapter = await ethers.getContractFactory("MockProjectDynoSwapAdapter");
  const VRF = await ethers.getContractFactory("MockRoninVRFCoordinator");
  const token = await Token.deploy();
  const nft = await NFT.deploy();
  const guard = await Guard.deploy(ethers.parseEther("20"), ethers.parseEther("30510"));
  const adapter = await Adapter.deploy(await token.getAddress(), ethers.parseEther("20"), ethers.parseEther("30510"));
  const vrf = await VRF.deploy();
  await admin.sendTransaction({ to: await adapter.getAddress(), value: ethers.parseEther("1000") });
  await token.mint(await adapter.getAddress(), ethers.parseEther("1000000000"));
  await nft.mint(admin.address, 1358);

  const Vault = await ethers.getContractFactory("ProjectDynoBuybackVault");
  const Manager = await ethers.getContractFactory("ProjectDynoRaffleManager");
  const Proxy = await ethers.getContractFactory("ProjectDynoProxy");
  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedVaultProxy = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
  const predictedManagerProxy = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 3 });
  const vaultImplementation = await Vault.deploy();
  const managerImplementation = await Manager.deploy();
  const vaultProxy = await Proxy.deploy(await vaultImplementation.getAddress(), Vault.interface.encodeFunctionData("initialize", [admin.address, predictedManagerProxy, keeper.address]));
  const managerProxy = await Proxy.deploy(await managerImplementation.getAddress(), Manager.interface.encodeFunctionData("initialize", [admin.address, identitySigner.address, predictedVaultProxy, reviewer.address]));
  if (await vaultProxy.getAddress() !== predictedVaultProxy || await managerProxy.getAddress() !== predictedManagerProxy) throw new Error("proxy prediction mismatch");
  const manager = Manager.attach(predictedManagerProxy);
  const prizes = ["70.2247", "140.4494", "1404.4944", "3511.2360", "7022.4719"].map(ethers.parseEther);
  const config = {
    matt: await token.getAddress(), nftCollection: await nft.getAddress(), nftTokenId: 1358,
    nftDepositor: admin.address, treasury: treasury.address, swapAdapter: ethers.ZeroAddress,
    priceGuard: ethers.ZeroAddress, vrfCoordinator: await vrf.getAddress(), ticketRon: ethers.parseEther("35"),
    ticketMatt: ethers.parseEther("700000"), capacity: 1000, ronPrizes: prizes, nextDynoReserve: ethers.parseEther("10000"),
    saleSlippageBps: 0, buybackSlippageBps: 0, reviewDuration: 86400, vrfCallbackGasLimit: 250000,
    vrfGasPrice: 22_000_000_000, minimumOperationsFunding: ethers.parseEther("0.02"), termsHash: ethers.id("PROJECT_DYNO_LOCAL_TERMS_V1"),
  };
  await manager.createRound(config, 31337);
  await manager.fundOperations(1, { value: ethers.parseEther("0.02") });
  await manager.openRound(1);
  const result = {
    warning: "LOCAL MOCKS ONLY - NOT A RONIN DEPLOYMENT; ticket MATT is held, not sold",
    chainId: Number((await ethers.provider.getNetwork()).chainId), roundId: "1",
    prizeDelivery: "manual", paymentModel: "RON_AND_HELD_MATT", nftChainId: 31337,
    admin: admin.address, identitySigner: identitySigner.address, reviewer: reviewer.address, keeper: keeper.address, treasury: treasury.address,
    raffleProxy: predictedManagerProxy, raffleImplementation: await managerImplementation.getAddress(),
    buybackProxy: predictedVaultProxy, buybackImplementation: await vaultImplementation.getAddress(),
    matt: await token.getAddress(), nftCollection: await nft.getAddress(), swapAdapter: await adapter.getAddress(),
    priceGuard: await guard.getAddress(), vrfCoordinator: await vrf.getAddress(),
  };
  const out = path.join(__dirname, "../../deployment-exports/project-dyno-local.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
