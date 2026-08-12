const hre=require("hardhat"),deployment=require("../deployment-exports/poker-ronin.json");
async function main(){
 if(process.env.CONFIRM_SET_POKER_OPERATOR!=="YES")throw new Error("Set CONFIRM_SET_POKER_OPERATOR=YES after reviewing the new public address.");
 const next=String(process.env.POKER_OPERATOR_ADDRESS||"").trim();
 if(!hre.ethers.isAddress(next)||next===hre.ethers.ZeroAddress)throw new Error("Set POKER_OPERATOR_ADDRESS to the new operator public address.");
 const [owner]=await hre.ethers.getSigners(),poker=await hre.ethers.getContractAt("MattPokerEscrow",deployment.poker,owner);
 if(!(await poker.paused()))throw new Error("Poker must remain paused while changing operator.");
 const current=await poker.operator();
 if(current.toLowerCase()===next.toLowerCase())throw new Error("New operator is already configured.");
 console.log("Poker operator change preflight",{poker:deployment.poker,owner:owner.address,currentOperator:current,newOperator:next});
 const tx=await poker.setOperator(next);await tx.wait(2);
 if((await poker.operator()).toLowerCase()!==next.toLowerCase())throw new Error("Operator verification failed.");
 console.log("Poker operator changed",{hash:tx.hash,operator:next});
}
main().catch(error=>{console.error(error);process.exitCode=1});
