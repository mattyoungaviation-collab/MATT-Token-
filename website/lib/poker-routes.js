"use strict";
const express=require("express"),crypto=require("crypto"),fs=require("fs"),path=require("path");
const {ethers}=require("ethers");
const {deckSeed,shuffledDeck,settle,nextClockwise,cardName}=require("./poker-engine");

const ABI=[
"function paused() view returns(bool)","function config() view returns(uint128 buyIn,uint128 rakeCap,uint16 rakeBps,uint32 version)",
"function seatAt(uint8) view returns(address wallet,address sessionKey,uint128 balance)",
"function activeHand() view returns(uint64 id,uint48 startedAt,uint32 configVersion,uint8 playerMask,bytes32 dealerCommitment,uint256 requestId,uint256 randomWord,bool randomnessReady,uint128[6] openingBalances)",
"function beginHand(uint8,bytes32) returns(uint64,uint256)",
"function settleHand(uint64,uint128[6],uint256,uint8,bytes32,bytes32)","function lastFinalizedHandId() view returns(uint64)"
];
const now=()=>Date.now(),hash=x=>ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(x,(k,v)=>typeof v==="bigint"?v.toString():v)));
function blank(){return{phase:"waiting",countdownEndsAt:0,intermissionEndsAt:0,ready:[],sitOut:[],dealerSeat:5,hand:null,actions:[],profiles:{},seq:0};}
function createPokerRouter(opts={}){
 const router=express.Router();router.use(express.json({limit:"64kb"}));
 const live=Boolean(opts.live),contractAddress=opts.contractAddress||"",rpc=opts.rpcUrl||"",key=opts.operatorPrivateKey||"";
 let table=blank(),busy=false,settlementBusy=false;const challenges=new Map(),tokens=new Map();
 let provider,signer,contract;
 if(live){if(!ethers.isAddress(contractAddress)||!rpc||!key||String(opts.stateSecret||"").length<32)throw Error("Poker live mode requires contract, RPC, operator key, and 32-character state secret");provider=new ethers.JsonRpcProvider(rpc);signer=new ethers.Wallet(key,provider);contract=new ethers.Contract(contractAddress,ABI,signer);}
 const seatData=async()=>{if(!live)return Array(6).fill(null);return Promise.all(Array.from({length:6},async(_,i)=>{const s=await contract.seatAt(i);return s.wallet===ethers.ZeroAddress?null:{seat:i,wallet:s.wallet,sessionKey:s.sessionKey,balance:s.balance.toString()};}));};
 const session=(req)=>{const raw=(req.headers.authorization||"").replace(/^Bearer /,""),s=tokens.get(raw);if(!s||s.expires<now())return null;return s;};
 const publicState=async(auth)=>{const seats=await seatData(),h=table.hand;return{live,phase:table.phase,countdownEndsAt:table.countdownEndsAt,intermissionEndsAt:table.intermissionEndsAt,ready:table.ready,dealerSeat:table.dealerSeat,seq:table.seq,seats:seats.map(s=>s&&({seat:s.seat,wallet:s.wallet,balance:s.balance,name:(table.profiles&&table.profiles[s.wallet.toLowerCase()])||("Player "+s.wallet.slice(2,6).toUpperCase())})),hand:h&&{id:h.id,players:h.players,board:h.board.map(cardName),pot:h.committed.reduce((a,b)=>a+BigInt(b),0n).toString(),turn:h.turn,currentBet:h.currentBet,actionEndsAt:h.actionEndsAt,timeBank:h.timeBank,folded:h.folded,allIn:h.allIn,stacks:h.stacks,committed:h.committed,streetCommitted:h.streetCommitted,street:h.street,holeCards:auth&&h.players.includes(auth.seat)&&!h.folded.includes(auth.seat)?h.holes[auth.seat].map(cardName):null},message:live?"":"Poker contracts are built and awaiting paused Ronin deployment."};};
 const stateFile=opts.stateFile||"",stateKey=crypto.createHash("sha256").update(String(opts.stateSecret||"")).digest();
 const seal=value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",stateKey,iv),body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);};
 const open=raw=>{const iv=raw.subarray(0,12),tag=raw.subarray(12,28),decipher=crypto.createDecipheriv("aes-256-gcm",stateKey,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString("utf8"));};
 if(live&&stateFile&&fs.existsSync(stateFile)){try{table=open(fs.readFileSync(stateFile));}catch{throw Error("Poker encrypted state could not be restored");}} table.profiles=table.profiles||{};
 const save=()=>{if(!live||!stateFile)return;fs.mkdirSync(path.dirname(stateFile),{recursive:true});const temp=stateFile+".tmp";fs.writeFileSync(temp,seal(table),{mode:0o600});fs.renameSync(temp,stateFile);};
 const activeSeats=h=>h.players.filter(i=>!h.folded.includes(i));
 const actionable=h=>activeSeats(h).filter(i=>!h.allIn.includes(i)&&BigInt(h.stacks[i])>0n);
 const take=(h,i,amount)=>{let n=BigInt(amount),stack=BigInt(h.stacks[i]);if(n>stack)n=stack;h.stacks[i]=(stack-n).toString();h.streetCommitted[i]=(BigInt(h.streetCommitted[i])+n).toString();h.committed[i]=(BigInt(h.committed[i])+n).toString();if(BigInt(h.stacks[i])===0n&&!h.allIn.includes(i))h.allIn.push(i);return n;};
 const setNeeds=(h,raiser)=>{h.needs=actionable(h).filter(i=>i!==raiser);};
 const setTurn=h=>{if(h.needs.length===0)return advance(h);h.turn=nextClockwise(h.turn,h.needs);h.actionEndsAt=now()+25000;h.timeBank=false;};
 const enterIntermission=()=>{table.hand=null;table.actions=[];table.phase="intermission";table.error="";table.intermissionEndsAt=now()+8000;table.seq++;save();};
 const buildSettlement=async h=>{const players=h.players.map(i=>({seat:i,committed:h.committed[i],folded:h.folded.includes(i),cards:h.holes[i]})),cfg=await contract.config(),result=settle({players,board:h.board,dealerSeat:table.dealerSeat,rakeBps:Number(cfg.rakeBps),rakeCap:cfg.rakeCap}),closing=Array(6).fill("0"),seats=await seatData(),participants=new Set(h.players);for(let i=0;i<6;i++)if(seats[i])closing[i]=participants.has(i)?(BigInt(h.stacks[i])+(result.payouts[i]||0n)).toString():seats[i].balance;return{closing,matchedPot:result.matchedPot.toString(),boardCards:h.board.length,transcriptHash:hash(table.actions),resultHash:hash({board:h.board,closing}),txHash:null,retryAt:0};};
 const finish=async h=>{if(settlementBusy||!h)return;settlementBusy=true;table.phase="settling";try{h.settlement=h.settlement||await buildSettlement(h);save();const chainHand=await contract.activeHand(),finalized=await contract.lastFinalizedHandId();if(chainHand.id===0n&&finalized>=BigInt(h.id)){enterIntermission();return;}if(chainHand.id!==BigInt(h.id))throw Error("Onchain hand does not match encrypted table state");const payload=h.settlement;if(payload.txHash){const receipt=await provider.getTransactionReceipt(payload.txHash);if(receipt){if(receipt.status===1){enterIntermission();return;}payload.txHash=null;save();}else{const pending=await provider.getTransaction(payload.txHash);if(pending)return;payload.txHash=null;save();}}const tx=await contract.settleHand(h.id,payload.closing,payload.matchedPot,payload.boardCards,payload.transcriptHash,payload.resultHash);payload.txHash=tx.hash;save();const receipt=await tx.wait();if(receipt.status!==1)throw Error("Settlement transaction reverted");enterIntermission();}catch(e){table.phase="settling";table.error=String(e.message||e).slice(0,180);h.settlement=h.settlement||{};h.settlement.retryAt=now()+5000;save();}finally{settlementBusy=false;}};
 const advance=async h=>{if(activeSeats(h).length===1)return finish(h);if(actionable(h).length<=1){while(h.board.length<5)h.board.push(h.deck.shift());h.street="river";return finish(h);}if(h.board.length<5){while(h.board.length<(h.street==="preflop"?3:h.street==="flop"?4:5))h.board.push(h.deck.shift());h.street=h.board.length===3?"flop":h.board.length===4?"turn":"river";h.streetCommitted=Array(6).fill("0");h.currentBet="0";h.lastRaise=h.bigBlind;h.needs=actionable(h);h.turn=table.dealerSeat;return setTurn(h);}return finish(h);};
 const startDeal=async(onchain,seats)=>{const participants=table.ready.filter(i=>seats[i]&&BigInt(seats[i].balance)>0n&&!table.sitOut.includes(i));if(participants.length<2){table.phase="waiting";table.countdownEndsAt=0;return;}table.dealerSeat=nextClockwise(table.dealerSeat,participants);const secret="0x"+crypto.randomBytes(32).toString("hex"),commitment=ethers.keccak256(secret);const mask=participants.reduce((m,i)=>m|(1<<i),0);const tx=await contract.beginHand(mask,commitment);await tx.wait();table.phase="vrf";table.hand={secret,commitment,players:participants};};
 const pollVrf=async()=>{const c=await contract.activeHand();if(!c.randomnessReady)return;const seats=await seatData(),h=table.hand,deck=shuffledDeck(deckSeed(h.secret,c.randomWord,c.id,contractAddress));Object.assign(h,{id:Number(c.id),deck,holes:{},board:[],stacks:Array(6).fill("0"),committed:Array(6).fill("0"),streetCommitted:Array(6).fill("0"),folded:[],allIn:[],street:"preflop",bigBlind:(BigInt((await contract.config()).buyIn)/100n).toString()});for(const i of h.players){h.holes[i]=[deck.shift(),deck.shift()];h.stacks[i]=seats[i].balance;}const sb=h.players.length===2?table.dealerSeat:nextClockwise(table.dealerSeat,h.players),bb=nextClockwise(sb,h.players);take(h,sb,BigInt(h.bigBlind)/2n);take(h,bb,BigInt(h.bigBlind));h.currentBet=h.streetCommitted[bb];h.lastRaise=h.bigBlind;h.needs=actionable(h);h.turn=bb;table.phase="hand";setTurn(h);table.seq++;};
 const tick=async()=>{if(!live||busy)return;busy=true;try{const seats=await seatData();if(table.phase==="countdown"&&now()>=table.countdownEndsAt)await startDeal(null,seats);else if(table.phase==="vrf")await pollVrf();else if(table.phase==="hand"&&table.hand&&now()>=table.hand.actionEndsAt){const h=table.hand;if(!h.timeBank){h.timeBank=true;h.actionEndsAt=now()+30000;}else{const i=h.turn,toCall=BigInt(h.currentBet)-BigInt(h.streetCommitted[i]);if(toCall>0n)h.folded.push(i);h.needs=h.needs.filter(x=>x!==i);table.actions.push({seat:i,type:toCall>0n?"timeout-fold":"timeout-check"});await setTurn(h);table.seq++;}}else if(table.phase==="settling"&&table.hand&&(!table.hand.settlement?.retryAt||now()>=table.hand.settlement.retryAt))await finish(table.hand);else if(table.phase==="intermission"&&now()>=table.intermissionEndsAt){const eligible=table.ready.filter(i=>seats[i]&&BigInt(seats[i].balance)>0n&&!table.sitOut.includes(i));if(eligible.length>=2){table.phase="countdown";table.countdownEndsAt=now()+8000;}else{table.phase="waiting";table.countdownEndsAt=0;}}}catch(e){table.phase="error";table.error=String(e.message||e).slice(0,180);}finally{busy=false;save();}};
 const timer=setInterval(tick,1000);timer.unref?.();

 router.get("/state",async(req,res)=>{await tick();res.json(await publicState(session(req)));});
 router.get("/challenge",(req,res)=>{if(!live)return res.status(503).json({error:"Poker is not deployed"});const wallet=String(req.query.wallet||"").toLowerCase();if(!ethers.isAddress(wallet))return res.status(400).json({error:"Invalid wallet"});const challenge="MATT Poker session "+crypto.randomBytes(24).toString("hex");challenges.set(wallet,{challenge,expires:now()+120000});res.json({challenge});});
 router.post("/session",async(req,res)=>{try{const wallet=String(req.body.wallet||"").toLowerCase(),item=challenges.get(wallet);if(!item||item.expires<now())throw Error("Challenge expired");const recovered=ethers.verifyMessage(item.challenge,req.body.signature);const seats=await seatData(),seat=seats.findIndex(s=>s&&s.wallet.toLowerCase()===wallet);if(seat<0||recovered.toLowerCase()!==seats[seat].sessionKey.toLowerCase())throw Error("Session key rejected");const token=crypto.randomBytes(32).toString("hex");tokens.set(token,{wallet,seat,sessionKey:recovered,expires:now()+86400000});challenges.delete(wallet);res.json({token,seat});}catch(e){res.status(401).json({error:e.message});}});
 router.post("/profile",async(req,res)=>{const s=session(req);if(!s)return res.status(401).json({error:"Session required"});const name=String(req.body.name||"").trim().replace(/\\s+/g," ");if(name.length<2||name.length>16||!/^[A-Za-z0-9 ._-]+$/.test(name))return res.status(400).json({error:"Table name must be 2-16 safe characters"});table.profiles=table.profiles||{};const duplicate=Object.entries(table.profiles).some(([wallet,value])=>wallet!==s.wallet&&String(value).toLowerCase()===name.toLowerCase());if(duplicate)return res.status(409).json({error:"That table name is already seated"});table.profiles[s.wallet]=name;table.seq++;save();res.json(await publicState(s));});
 router.post("/ready",async(req,res)=>{const s=session(req);if(!s)return res.status(401).json({error:"Session required"});const ready=Boolean(req.body.ready);table.ready=table.ready.filter(i=>i!==s.seat);if(ready)table.ready.push(s.seat);if(ready)table.sitOut=table.sitOut.filter(i=>i!==s.seat);if(table.phase==="waiting"&&ready){table.phase="countdown";table.countdownEndsAt=now()+60000;}table.seq++;res.json(await publicState(s));});
 const leaveChallenges=new Map();

router.get("/leave-challenge",async(req,res)=>{
 try{
  const {getAddress}=require("ethers");
  const wallet=getAddress(String(req.query.wallet||""));
  const nonce=require("crypto").randomBytes(24).toString("hex");
  const message=["MATT Poker cash-out request","Wallet: "+wallet,"Nonce: "+nonce].join("\n");
  leaveChallenges.set(wallet.toLowerCase(),{message,expiresAt:Date.now()+300000});
  res.json({message});
 }catch{
  res.status(400).json({error:"A valid seated wallet is required."});
 }
});
router.post("/wallet-sit-out",async(req,res)=>{
 try{
  const {getAddress,verifyMessage}=require("ethers");
  const wallet=getAddress(String(req.body&&req.body.wallet||""));
  const key=wallet.toLowerCase();
  const challenge=leaveChallenges.get(key);
  if(!challenge||challenge.expiresAt<Date.now()){
   leaveChallenges.delete(key);
   return res.status(401).json({error:"Cash-out authorization expired. Please try again."});
  }
  const recovered=verifyMessage(challenge.message,String(req.body&&req.body.signature||""));
  if(recovered.toLowerCase()!==key)return res.status(401).json({error:"Cash-out authorization does not match this wallet."});
  leaveChallenges.delete(key);
  const snapshot=await publicState();
  const seat=snapshot.seats.findIndex(entry=>entry&&entry.wallet.toLowerCase()===key);
  if(seat<0)return res.status(409).json({error:"This wallet does not currently own a Poker seat."});
  if(!table.sitOut.includes(seat))table.sitOut.push(seat);
  table.ready=table.ready.filter(index=>index!==seat);
  return res.json(await publicState());
 }catch(error){
  return res.status(400).json({error:error&&error.message||"Unable to queue cash-out."});
 }
});
router.post("/sit-out",async(req,res)=>{const s=session(req);if(!s)return res.status(401).json({error:"Session required"});if(!table.sitOut.includes(s.seat))table.sitOut.push(s.seat);table.ready=table.ready.filter(i=>i!==s.seat);res.json(await publicState(s));});
 router.post("/action",async(req,res)=>{const s=session(req),h=table.hand;if(!s||table.phase!=="hand"||!h||h.turn!==s.seat)return res.status(409).json({error:"Not your turn"});try{const payload={seat:s.seat,seq:table.seq,type:req.body.type,amount:String(req.body.amount||"0")};if(ethers.verifyMessage(JSON.stringify(payload),req.body.signature).toLowerCase()!==s.sessionKey.toLowerCase())throw Error("Bad session signature");const i=s.seat,toCall=BigInt(h.currentBet)-BigInt(h.streetCommitted[i]);if(payload.type==="fold")h.folded.push(i);else if(payload.type==="check"){if(toCall!==0n)throw Error("Cannot check");}else if(payload.type==="call")take(h,i,toCall);else if(payload.type==="all-in"){const paid=take(h,i,h.stacks[i]);const total=BigInt(h.streetCommitted[i]);if(total>BigInt(h.currentBet)){h.lastRaise=(total-BigInt(h.currentBet)).toString();h.currentBet=total.toString();setNeeds(h,i);}}else if(payload.type==="raise"){const target=BigInt(payload.amount),minimum=BigInt(h.currentBet)+BigInt(h.lastRaise);if(target<minimum||target<=BigInt(h.streetCommitted[i]))throw Error("Raise too small");take(h,i,target-BigInt(h.streetCommitted[i]));h.lastRaise=(target-BigInt(h.currentBet)).toString();h.currentBet=target.toString();setNeeds(h,i);}else throw Error("Unknown action");h.needs=h.needs.filter(x=>x!==i);table.actions.push(payload);table.seq++;await setTurn(h);res.json(await publicState(s));}catch(e){res.status(400).json({error:e.message});}});
 return router;
}
module.exports={createPokerRouter};
