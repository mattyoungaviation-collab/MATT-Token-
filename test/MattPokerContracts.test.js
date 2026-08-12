const {expect}=require("chai");
const {ethers}=require("hardhat");

describe("MATT Poker Mainnet contracts",function(){
 const BUY_IN=ethers.parseEther("1000000");
 let owner,alice,bob,treasury,token,coordinator,adapter,poker;

 async function deploy(){
  [owner,alice,bob,treasury]=await ethers.getSigners();
  token=await (await ethers.getContractFactory("MockMattToken")).deploy();
  coordinator=await (await ethers.getContractFactory("MockVRFV25Coordinator")).deploy();
  adapter=await (await ethers.getContractFactory("MattPokerVRFV25Adapter")).deploy(
   await coordinator.getAddress(),1,ethers.id("MATT_POKER_TEST_KEY"),3,900000,owner.address
  );
  poker=await (await ethers.getContractFactory("MattPokerEscrow")).deploy(
   await token.getAddress(),await adapter.getAddress(),treasury.address,owner.address,owner.address,BUY_IN
  );
  await adapter.setConsumer(await poker.getAddress());
  await token.mint(alice.address,BUY_IN);
  await token.mint(bob.address,BUY_IN);
  await token.connect(alice).approve(await poker.getAddress(),BUY_IN);
  await token.connect(bob).approve(await poker.getAddress(),BUY_IN);
 }

 async function seatPlayers(){
  await poker.unpause();
  await poker.connect(alice).buyIn(0,ethers.Wallet.createRandom().address);
  await poker.connect(bob).buyIn(1,ethers.Wallet.createRandom().address);
 }

 async function startAndFulfill(){
  await poker.beginHand(3,ethers.id("dealer-secret"));
  expect(await adapter.outstandingRequests()).to.equal(1);
  await coordinator.fulfill(1,123456789);
  expect(await adapter.outstandingRequests()).to.equal(0);
 }

 beforeEach(deploy);

 it("starts paused with the exact initial buy-in, blinds, and zero rake",async function(){
  expect(await poker.paused()).to.equal(true);
  const cfg=await poker.config();
  expect(cfg.buyIn).to.equal(BUY_IN);
  expect(cfg.rakeBps).to.equal(0);
  expect(cfg.rakeCap).to.equal(0);
  expect(await poker.smallBlind()).to.equal(BUY_IN/200n);
  expect(await poker.bigBlind()).to.equal(BUY_IN/100n);
 });

 it("protects six-seat deposits and accepts randomness only through the dedicated adapter",async function(){
  await seatPlayers();
  expect(await poker.totalPlayerLiability()).to.equal(BUY_IN*2n);
  expect(await poker.isSolvent()).to.equal(true);
  await expect(adapter.connect(alice).requestRandomWord(1)).to.be.revertedWith("Poker VRF: consumer only");
  await startAndFulfill();
  const hand=await poker.activeHand();
  expect(hand.id).to.equal(1);
  expect(hand.randomnessReady).to.equal(true);
  expect(hand.randomWord).to.equal(123456789);
 });

 it("conserves player chips through a completed zero-rake hand",async function(){
  await seatPlayers();
  await startAndFulfill();
  const closing=[BUY_IN+ethers.parseEther("100000"),BUY_IN-ethers.parseEther("100000"),0,0,0,0];
  await poker.settleHand(1,closing,ethers.parseEther("200000"),5,ethers.id("transcript"),ethers.id("result"));
  expect((await poker.seatAt(0)).balance).to.equal(closing[0]);
  expect((await poker.seatAt(1)).balance).to.equal(closing[1]);
  expect(await poker.totalPlayerLiability()).to.equal(BUY_IN*2n);
  expect(await token.balanceOf(treasury.address)).to.equal(0);
 });

 it("rejects chip inflation and any rake while rake is configured to zero",async function(){
  await seatPlayers();
  await startAndFulfill();
  await expect(poker.settleHand(1,[BUY_IN+1n,BUY_IN,0,0,0,0],1,5,ethers.id("t1"),ethers.id("r1"))).to.be.revertedWith("Poker: settlement");
  await expect(poker.settleHand(1,[BUY_IN-1n,BUY_IN,0,0,0,0],1,5,ethers.id("t2"),ethers.id("r2"))).to.be.revertedWith("Poker: rake");
 });

 it("restores the last finalized balances after a stale hand and keeps cash-out available while paused",async function(){
  await seatPlayers();
  await poker.beginHand(3,ethers.id("stale-secret"));
  await poker.pause();
  await ethers.provider.send("evm_increaseTime",[30*60]);
  await ethers.provider.send("evm_mine",[]);
  await poker.connect(alice).cancelStaleHand();
  expect((await poker.activeHand()).id).to.equal(0);
  await poker.connect(alice).cashOut();
  expect(await token.balanceOf(alice.address)).to.equal(BUY_IN);
  expect(await poker.totalPlayerLiability()).to.equal(BUY_IN);
 });

 it("enforces delayed, empty-table configuration changes and the permanent rake ceiling",async function(){
  await expect(poker.proposeConfig(BUY_IN,501,1)).to.be.revertedWith("Poker: rake config");
  await poker.proposeConfig(BUY_IN*2n,100,ethers.parseEther("10000"));
  await expect(poker.activateConfig()).to.be.revertedWith("Poker: config locked");
  await ethers.provider.send("evm_increaseTime",[24*60*60]);
  await ethers.provider.send("evm_mine",[]);
  await poker.activateConfig();
  const cfg=await poker.config();
  expect(cfg.buyIn).to.equal(BUY_IN*2n);
  expect(cfg.rakeBps).to.equal(100);
  expect(cfg.version).to.equal(2);
 });

 it("rejects direct RON deposits into the sponsored VRF adapter",async function(){
  await expect(owner.sendTransaction({to:await adapter.getAddress(),value:1})).to.be.revertedWith("Poker VRF: direct RON disabled");
 });
});
