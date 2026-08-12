const fs=require("node:fs"),path=require("node:path"),hre=require("hardhat");
const CHAIN=2020n,COORDINATOR="0xa18FD3db9B869AD2A8c55267e0D54dbf6ECEbEda";
const ABI=[
 "event SubscriptionCreated(uint256 indexed subId,address owner)",
 "function createSubscription() returns(uint256)",
 "function fundSubscriptionWithNative(uint256) payable",
 "function getSubscription(uint256) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)"
];

async function newestRecoverableSubscription(contract,signer){
 const latest=await hre.ethers.provider.getBlockNumber();
 const depth=Number(process.env.POKER_VRF_RECOVERY_BLOCKS||"600");
 const minimum=Math.max(0,latest-depth);
 const configuredChunk=Math.max(1,Number(process.env.POKER_VRF_LOG_CHUNK||"10"));
 for(let end=latest;end>=minimum;end-=configuredChunk){
  const start=Math.max(minimum,end-configuredChunk+1);
  let logs;
  try{
   logs=await contract.queryFilter(contract.filters.SubscriptionCreated(),start,end);
  }catch(error){
   logs=[];
   for(let block=end;block>=start;block--){
    try{logs.push(...await contract.queryFilter(contract.filters.SubscriptionCreated(),block,block));}
    catch(singleBlockError){throw new Error("RPC rejected even a single-block log query. Set POKER_VRF_SUBSCRIPTION_ID from the SubscriptionCreated transaction, then retry.");}
   }
  }
  for(let i=logs.length-1;i>=0;i--){
   const event=logs[i];
   if(String(event.args.owner).toLowerCase()!==signer.address.toLowerCase())continue;
   const sub=await contract.getSubscription(event.args.subId);
   if(sub.nativeBalance===0n&&sub.consumers.length===0)return {id:event.args.subId,createHash:event.transactionHash,recovered:true};
  }
 }
 return null;
}

async function main(){
 if(process.env.CONFIRM_CREATE_POKER_VRF_SUBSCRIPTION!=="YES")throw new Error("Set CONFIRM_CREATE_POKER_VRF_SUBSCRIPTION=YES after reviewing the RON amount.");
 const amount=String(process.env.POKER_VRF_FUND_RON||"").trim();
 if(!/^\d+(\.\d+)?$/.test(amount)||hre.ethers.parseEther(amount)<=0n)throw new Error("POKER_VRF_FUND_RON must be positive.");
 const [signer]=await hre.ethers.getSigners(),network=await hre.ethers.provider.getNetwork();
 if(network.chainId!==CHAIN)throw new Error("Expected Ronin mainnet.");
 const contract=new hre.ethers.Contract(COORDINATOR,ABI,signer);
 let selected;
 const explicit=String(process.env.POKER_VRF_SUBSCRIPTION_ID||"").trim();
 if(explicit){
  const sub=await contract.getSubscription(explicit);
  if(sub.subOwner.toLowerCase()!==signer.address.toLowerCase())throw new Error("Signer is not subscription owner.");
  if(sub.consumers.length!==0)throw new Error("Refusing to repurpose a subscription that already has consumers.");
  selected={id:BigInt(explicit),createHash:null,recovered:true};
 }else{
  selected=await newestRecoverableSubscription(contract,signer);
 }
 if(!selected){
  console.log("Creating dedicated Poker VRF subscription",{coordinator:COORDINATOR,owner:signer.address,fundRON:amount});
  const tx=await contract.createSubscription(),receipt=await tx.wait(2);
  let id;
  for(const log of receipt.logs){try{const parsed=contract.interface.parseLog(log);if(parsed?.name==="SubscriptionCreated")id=parsed.args.subId}catch{}}
  if(!id)throw new Error("SubscriptionCreated event missing.");
  selected={id,createHash:tx.hash,recovered:false};
 }else{
  console.log("Recovering the newest unfunded Poker VRF subscription",{subscriptionId:selected.id.toString(),owner:signer.address});
 }
 const existing=await contract.getSubscription(selected.id);
 if(existing.subOwner.toLowerCase()!==signer.address.toLowerCase())throw new Error("Subscription owner mismatch.");
 const fundTx=await contract.fundSubscriptionWithNative(selected.id,{value:hre.ethers.parseEther(amount)});
 await fundTx.wait(2);
 const sub=await contract.getSubscription(selected.id);
 const out={schemaVersion:1,network:"ronin",chainId:2020,coordinator:COORDINATOR,subscriptionId:selected.id.toString(),owner:signer.address,fundedRON:amount,nativeBalanceWei:sub.nativeBalance.toString(),recoveredAfterFundingFailure:selected.recovered,createdAt:new Date().toISOString(),transactions:{create:selected.createHash,fund:fundTx.hash}};
 const file=path.join(__dirname,"../deployment-exports/poker-vrf-subscription-ronin.json");
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(out,null,2)+"\n");
 console.log("Poker VRF subscription funded",{subscriptionId:out.subscriptionId,nativeBalanceWei:out.nativeBalanceWei,recovered:out.recoveredAfterFundingFailure,outputPath:file});
}
main().catch(e=>{console.error(e);process.exitCode=1});
