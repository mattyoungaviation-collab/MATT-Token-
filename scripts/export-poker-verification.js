const fs=require("node:fs"),path=require("node:path"),hre=require("hardhat");
async function main(){
 const targets=[
  ["contracts/MattPokerVRFV25Adapter.sol:MattPokerVRFV25Adapter","poker-adapter-standard-input.json"],
  ["contracts/MattPokerEscrow.sol:MattPokerEscrow","poker-escrow-standard-input.json"]
 ];
 const out=path.join(__dirname,"../deployment-exports");
 fs.mkdirSync(out,{recursive:true});
 for(const [fqn,name] of targets){
  const info=await hre.artifacts.getBuildInfo(fqn);
  if(!info)throw new Error(`No build info for ${fqn}. Run npx hardhat compile first.`);
  const file=path.join(out,name);
  fs.writeFileSync(file,JSON.stringify(info.input,null,2)+"\n");
  console.log("Wrote Poker verification standard input",{contract:fqn,file});
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
