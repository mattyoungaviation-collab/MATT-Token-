(()=>{
"use strict";
const C=window.MATT_POKER_CONFIG,E=window.ethers,$=s=>document.querySelector(s),all=s=>Array.from(document.querySelectorAll(s));
const escrowAbi=[
 "function config() view returns(uint128 buyIn,uint128 rakeCap,uint16 rakeBps,uint32 version)",
 "function buyIn(uint8,address)",
 "function cashOut()"
];
const tokenAbi=["function allowance(address,address) view returns(uint256)","function approve(address,uint256)"];
let provider,signer,wallet,token,mySeat=-1,state,sessionWallet,busy=false,noticeUntil=0,boardRenderKey="",holeRenderKey="";

function html(value){return String(value||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function short(address){return address?address.slice(0,6)+"…"+address.slice(-4):"OPEN";}
function matt(value,compact){
 const n=Number(E.formatUnits(BigInt(value||0),18));
 return new Intl.NumberFormat(undefined,compact?{notation:"compact",maximumFractionDigits:2}:{maximumFractionDigits:n<10000?2:0}).format(n);
}
function parseMattInput(raw){
 const cleaned=String(raw||"").trim().replace(/[\s'’]/g,"");
 if(!cleaned)throw Error("Enter a raise amount.");
 if(!/^\d{1,3}([.,]\d{3})+$/.test(cleaned)&&!/^\d+$/.test(cleaned))throw Error("Use a whole MATT amount, such as 10,000 or 10.000.");
 const digits=cleaned.replace(/[.,]/g,"");
 if(!/^\d+$/.test(digits)||BigInt(digits)<=0n)throw Error("Raise must be greater than zero.");
 return E.parseUnits(digits,18);
}
function announce(message,seconds){
 $("#notice").textContent=message;
 noticeUntil=Date.now()+((seconds||6)*1000);
}
function friendly(error){
 const text=String(error?.shortMessage||error?.reason||error?.message||error);
 if(/insufficient funds/i.test(text))return "Wallet could not estimate this transaction. Confirm Ronin Mainnet is selected; your public balance may still be sufficient.";
 if(/user rejected|denied/i.test(text))return "Transaction cancelled in your wallet.";
 if(/seat unavailable/i.test(text))return "That seat was just taken. Choose another open seat.";
 return text.replace(/^execution reverted:\s*/i,"").slice(0,220);
}
async function ensureRonin(){
 const injected=window.ronin?.provider||window.ethereum;
 if(!injected)throw Error("Open this page inside Ronin Wallet or install the Ronin Wallet extension.");
 const request=args=>injected.request?injected.request(args):injected.send(args.method,args.params||[]);
 let chain=await request({method:"eth_chainId"});
 if(BigInt(chain)!==2020n){
  announce("Switching your wallet to Ronin Mainnet...");
  await request({method:"wallet_switchEthereumChain",params:[{chainId:"0x7e4"}]});
  chain=await request({method:"eth_chainId"});
  if(BigInt(chain)!==2020n)throw Error("Ronin Mainnet (chain 2020) is required.");
 }
 return injected;
}
async function connect(){
 const injected=await ensureRonin();
 provider=new E.BrowserProvider(injected);
 await provider.send("eth_requestAccounts",[]);
 signer=await provider.getSigner();
 wallet=(await signer.getAddress()).toLowerCase();
 $("#connect").textContent=short(wallet);
 await authenticate();
}
async function authenticate(){
 const raw=sessionStorage.getItem("mattPokerSession");
 if(!raw||!wallet)return;
 sessionWallet=new E.Wallet(raw);
 const challengeResponse=await fetch("/api/poker/challenge?wallet="+encodeURIComponent(wallet));
 const challenge=await challengeResponse.json();
 if(!challengeResponse.ok)throw Error(challenge.error||"Poker session is unavailable.");
 const signature=await sessionWallet.signMessage(challenge.challenge);
 const response=await fetch("/api/poker/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet,signature})});
 const result=await response.json();
 if(!response.ok)throw Error(result.error||"Session key rejected.");
 token=result.token;mySeat=result.seat;
 const savedName=localStorage.getItem("mattPokerName");
 if(savedName)$("#playerName").value=savedName;
 if(savedName)await saveProfile(false);
 announce("Session restored. Your in-hand actions will not open wallet popups.");
}
async function api(path,body){
 const response=await fetch("/api/poker"+path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:JSON.stringify(body||{})});
 const result=await response.json();
 if(!response.ok)throw Error(result.error||"Poker request failed.");
 return result;
}
async function saveProfile(showMessage){
 const name=$("#playerName").value.trim().replace(/\s+/g," ");
 if(name.length<2||name.length>16||!/^[A-Za-z0-9 ._-]+$/.test(name))throw Error("Table name must be 2–16 letters, numbers, spaces, dots, dashes, or underscores.");
 localStorage.setItem("mattPokerName",name);
 if(token)await api("/profile",{name});
 if(showMessage!==false)announce("Table name saved as "+name+".");
}
async function buyIn(){
 if(busy)return;
 busy=true;
 try{
  if(!C.live)throw Error("Poker Mainnet is not configured on this host.");
  if(!signer)await connect();
  const seat=Number($("#seatSelect").value);
  if(state?.seats?.[seat])throw Error("That seat is occupied.");
  const name=$("#playerName").value.trim();
  if(name)await saveProfile(false).catch(()=>{});
  const escrow=new E.Contract(C.contract,escrowAbi,signer),cfg=await escrow.config();
  const stored=sessionStorage.getItem("mattPokerSession");
  sessionWallet=stored?new E.Wallet(stored):E.Wallet.createRandom();
  sessionStorage.setItem("mattPokerSession",sessionWallet.privateKey);
  const mattToken=new E.Contract(C.matt,tokenAbi,signer);
  const allowance=await mattToken.allowance(wallet,C.contract);
  if(allowance<cfg.buyIn){
   announce("Step 1 of 2: approve exactly "+matt(cfg.buyIn)+" MATT.");
   const gas=await mattToken.approve.estimateGas(C.contract,cfg.buyIn);
   const approval=await mattToken.approve(C.contract,cfg.buyIn,{gasLimit:gas*125n/100n});
   await approval.wait();
  }
  announce("Step 2 of 2: confirm your seat and buy-in.");
  const buyGas=await escrow.buyIn.estimateGas(seat,sessionWallet.address);
  await (await escrow.buyIn(seat,sessionWallet.address,{gasLimit:buyGas*125n/100n})).wait();
  await authenticate();
  if(name)await saveProfile(false);
  announce("Welcome to The Foundry. Press Ready when you want to play.");
 }finally{busy=false;}
}
let exitQueued=false;
async function queueCashOut(){
 if(token){
  try{
   await api("/sit-out",{});
   exitQueued=true;
   return;
  }catch{
   token=null;
   sessionStorage.removeItem("mattPokerSession");
  }
 }
 const response=await fetch("/api/poker/leave-challenge?wallet="+encodeURIComponent(wallet),{cache:"no-store"});
 const challenge=await response.json();
 if(!response.ok)throw new Error(challenge.error||"Unable to authorize cash-out.");
 const signature=await signer.signMessage(challenge.message);
 await api("/wallet-sit-out",{wallet,signature});
 exitQueued=true;
}
async function cashOut(){
 if(busy)return;busy=true;
 try{
  if(!signer)await connect();
  const cashoutSeat=wallet&&state&&state.seats?state.seats.findIndex(seat=>seat&&seat.wallet.toLowerCase()===wallet.toLowerCase()):mySeat;
  await queueCashOut();
  const stillPlaying=cashoutSeat>=0&&state&&["starting","vrf","hand","settling","recovering","error"].includes(state.phase)&&(state.hand?.players||[]).includes(cashoutSeat);
  if(stillPlaying){
   announce("Leave queued. You will not be dealt into the next hand. Press CASH OUT again after this hand closes.");
   return;
  }
  announce("Confirm cash-out in Ronin Wallet.");
  const escrow=new E.Contract(C.contract,escrowAbi,signer);
  const gas=await escrow.cashOut.estimateGas();
  await (await escrow.cashOut({gasLimit:gas*125n/100n})).wait();
  sessionStorage.removeItem("mattPokerSession");token=null;mySeat=-1;exitQueued=false;
  announce("Cash-out confirmed. Your finalized MATT returned to your wallet.");
 }finally{busy=false;}
}
async function act(type){
 if(!sessionWallet||!state?.hand)throw Error("No authenticated hand session.");
 let amount="0";
 if(type==="raise")amount=parseMattInput($("#raiseAmount").value).toString();
 const payload={seat:mySeat,seq:state.seq,type,amount};
 const signature=await sessionWallet.signMessage(JSON.stringify(payload));
 await api("/action",{type,amount,signature});
 announce(type==="all-in"?"All in.":type.charAt(0).toUpperCase()+type.slice(1)+" submitted.",2);
}
function card(code,hidden){
 if(hidden)return '<span class="card-back" aria-label="Face-down card"></span>';
 const ranks={T:"10",J:"J",Q:"Q",K:"K",A:"A"},suits={c:"♣",d:"♦",h:"♥",s:"♠"};
 const raw=String(code||""),rank=ranks[raw[0]]||raw[0],suit=suits[raw[1]]||"",red=raw[1]==="d"||raw[1]==="h";
 return '<article class="playing-card '+(red?"red":"")+'" aria-label="'+html(rank+" "+suit)+'"><span class="corner">'+html(rank)+'<i>'+suit+'</i></span><span class="pip">'+suit+'</span><span class="corner bottom">'+html(rank)+'<i>'+suit+'</i></span></article>';
}
let handInsightKey="";
function insightPanel(){
 let panel=$("#handInsights");
 if(panel)return panel;
 const actionPanel=document.querySelector(".action-panel");
 if(!actionPanel)return null;
 panel=document.createElement("section");
 panel.id="handInsights";
 panel.className="hand-insights";
 panel.hidden=true;
 panel.innerHTML='<div class="insight-heading"><span>LIVE HAND READ</span><small>PRIVATE ESTIMATE · UNKNOWN CARDS SIMULATED</small></div>'+
  '<div class="insight-grid"><article class="insight-stat"><span>CURRENT HAND</span><strong data-insight="rating">--</strong><small data-insight="street">WAITING FOR CARDS</small></article>'+
  '<article class="insight-stat equity"><span>CHANCE TO WIN</span><strong data-insight="equity">--</strong><small data-insight="tie">NO ESTIMATE</small></article></div>'+
  '<div class="equity-meter"><i data-insight="meter"></i></div>'+
  '<div class="insight-foot"><span data-insight="opponents">NO ACTIVE OPPONENTS</span><span>Estimate, not a guarantee</span></div>'+
  '<details class="ranking-guide"><summary>HAND RANKINGS</summary><ol><li>Royal Flush</li><li>Straight Flush</li><li>Four of a Kind</li><li>Full House</li><li>Flush</li><li>Straight</li><li>Three of a Kind</li><li>Two Pair</li><li>One Pair</li><li>High Card</li></ol></details>';
 actionPanel.prepend(panel);
 return panel;
}
function renderHandInsights(s,seat){
 const panel=insightPanel(),h=s.hand;
 const hole=Array.isArray(h?.holeCards)?h.holeCards:[];
 const seatedInHand=seat>=0&&h?.players?.includes(seat);
 if(!panel||!seatedInHand||hole.length!==2||!window.MattPokerInsights){
  if(panel)panel.hidden=true;
  handInsightKey="";
  return;
 }
 panel.hidden=false;
 const folded=h.folded?.includes(seat);
 if(folded){
  panel.querySelector('[data-insight="rating"]').textContent="Folded";
  panel.querySelector('[data-insight="street"]').textContent=String(h.street||"hand").toUpperCase();
  panel.querySelector('[data-insight="equity"]').textContent="0.0%";
  panel.querySelector('[data-insight="tie"]').textContent="HAND COMPLETE";
  panel.querySelector('[data-insight="meter"]').style.setProperty("--equity","0%");
  panel.querySelector('[data-insight="opponents"]').textContent="WAITING FOR NEXT HAND";
  handInsightKey="folded:"+h.id;
  return;
 }
 const foldedSeats=new Set(h.folded||[]);
 const opponents=(h.players||[]).filter(player=>player!==seat&&!foldedSeats.has(player)).length;
 const board=Array.isArray(h.board)?h.board:[];
 const key=[h.id,h.street,hole.join(","),board.join(","),opponents].join("|");
 if(key===handInsightKey)return;
 handInsightKey=key;
 try{
  const result=window.MattPokerInsights.calculate({holeCards:hole,board,opponents});
  const equity=Math.max(0,Math.min(100,result.equityPercent));
  panel.querySelector('[data-insight="rating"]').textContent=result.rating;
  panel.querySelector('[data-insight="street"]').textContent=String(h.street||"preflop").toUpperCase()+" · "+result.trials.toLocaleString()+" RUNOUTS";
  panel.querySelector('[data-insight="equity"]').textContent=equity.toFixed(1)+"%";
  panel.querySelector('[data-insight="tie"]').textContent="TIE "+result.tiePercent.toFixed(1)+"%";
  panel.querySelector('[data-insight="meter"]').style.setProperty("--equity",equity.toFixed(1)+"%");
  panel.querySelector('[data-insight="opponents"]').textContent="VS "+opponents+" ACTIVE OPPONENT"+(opponents===1?"":"S");
 }catch{
  panel.querySelector('[data-insight="rating"]').textContent="Reading Hand";
  panel.querySelector('[data-insight="equity"]').textContent="--";
 }
}
function seatMarkup(index,seat,hand){
 if(!seat)return '<span class="seat-number">SEAT '+(index+1)+'</span><strong>OPEN SEAT</strong><small>SELECT TO JOIN</small>';
 const inHand=hand?.players?.includes(index),folded=hand?.folded?.includes(index),allIn=hand?.allIn?.includes(index);
 const liveStack=inHand&&hand.stacks?hand.stacks[index]:seat.balance;
 const committed=inHand&&hand.committed?BigInt(hand.committed[index]||0):0n;
 const badges=[];
 if(index===state.dealerSeat)badges.push('<span class="badge dealer">D</span>');
 if(index===mySeat)badges.push('<span class="badge you">YOU</span>');
 if(hand?.turn===index&&!folded)badges.push('<span class="badge turn">TO ACT</span>');
 const status=folded?"FOLDED":allIn?"ALL IN":state.ready.includes(index)?"READY":inHand?String(hand.street||"IN HAND").toUpperCase():"SEATED";
 return '<span class="seat-head"><span class="seat-number">SEAT '+(index+1)+'</span><span class="seat-badges">'+badges.join("")+'</span></span>'+
  '<strong class="player-name">'+html(seat.name||("Player "+short(seat.wallet)))+'</strong>'+
  '<span class="wallet-id" title="'+html(seat.wallet)+'">'+html(short(seat.wallet))+'</span>'+
  '<span class="stack-line"><strong>'+matt(liveStack,true)+'</strong><small>MATT · '+status+'</small></span>'+
  (inHand&&!folded?'<span class="mini-backs"><i class="mini-back"></i><i class="mini-back"></i></span>':'')+
  (committed>0n?'<span class="wager-chip">IN POT · '+matt(committed,true)+'</span>':'');
}
function render(s){
 state=s;
 const h=s.hand,occupied=s.seats.filter(Boolean).length;
 $("#tablePlayers").textContent=occupied+" / 6";
 $("#handNumber").textContent=h?"#"+h.id:"WAITING";
 $("#phase").innerHTML='<i></i> '+String(s.phase||"waiting").replace(/-/g," ").toUpperCase();
 const end=s.phase==="countdown"?s.countdownEndsAt:s.phase==="hand"?h?.actionEndsAt:s.phase==="intermission"?s.intermissionEndsAt:0;
 $("#clock").textContent=end?Math.max(0,Math.ceil((end-Date.now())/1000))+"s":"--";
 $("#pot").textContent="POT · "+matt(h?.pot||0)+" MATT";
 $("#centerPot").innerHTML="<small>TOTAL POT</small><strong>"+matt(h?.pot||0,true)+"</strong>";
 const nextBoardKey=JSON.stringify(h?.board||[]);if(nextBoardKey!==boardRenderKey){$("#board").innerHTML=Array.from({length:5},(_,i)=>h?.board?.[i]?card(h.board[i],false):'<span class="card-slot"></span>').join("");boardRenderKey=nextBoardKey;}
 const myInHand=h?.players?.includes(mySeat),myFolded=h?.folded?.includes(mySeat);
 const nextHoleKey=JSON.stringify([h?.id||0,mySeat,myInHand,myFolded,h?.holeCards||null]);if(nextHoleKey!==holeRenderKey){$("#hole").innerHTML=myInHand&&!myFolded?(h.holeCards?h.holeCards.map(c=>card(c,false)).join(""):card(null,true)+card(null,true)):"";holeRenderKey=nextHoleKey;}
 all(".seat").forEach((button,index)=>{
  const seat=s.seats[index],folded=h?.folded?.includes(index),allIn=h?.allIn?.includes(index);
  button.className="seat seat-"+index+(seat?" occupied":" open")+(index===mySeat?" mine":"")+(h?.turn===index&&!folded?" to-act":"")+(folded?" folded":"")+(allIn?" all-in":"");
  button.innerHTML=seatMarkup(index,seat,h);
  button.title=seat?.wallet||"Open seat "+(index+1);
 });
 const walletSeat=wallet?s.seats.findIndex(seat=>seat&&seat.wallet.toLowerCase()===wallet.toLowerCase()):-1;
 const effectiveSeat=wallet?walletSeat:mySeat;
 if(walletSeat>=0)mySeat=walletSeat;
 const mine=effectiveSeat>=0?s.seats[effectiveSeat]:null;
 const inCurrentHand=!!(mine&&["starting","vrf","hand","settling","recovering","error"].includes(s.phase)&&(s.hand?.players||[]).includes(effectiveSeat));
 const leaveQueued=exitQueued;
 renderHandInsights(s,effectiveSeat);
 const myStack=mine?(myInHand&&h?.stacks?h.stacks[mySeat]:mine.balance):0;
 $("#myBankroll").textContent=mine?matt(myStack)+" MATT":"NOT SEATED";
 const toCall=myInHand&&h?BigInt(h.currentBet||0)-BigInt(h.streetCommitted?.[mySeat]||0):0n;
 $("#toCall").textContent=matt(toCall<0n?0n:toCall)+" MATT";
 const myTurn=Boolean(h&&h.turn===mySeat&&!myFolded&&!h.allIn?.includes(mySeat)&&s.phase==="hand");
 $(".action-panel").classList.toggle("live-turn",myTurn);
 $("#actionPrompt").textContent=s.phase==="settling"?"FINALIZING ON RONIN":myTurn?"YOUR TURN · "+String(h.street).toUpperCase():h?"WAITING FOR PLAYER":"WAITING FOR A HAND";
 all("[data-action]").forEach(button=>button.disabled=!myTurn);
 $("#checkAction").disabled=!myTurn||toCall>0n;
 $("#callAction").disabled=!myTurn||toCall<=0n;
 $("#callAction").textContent=toCall>0n?"CALL "+matt(toCall,true):"CALL";
 $("#ready").disabled=!mine||leaveQueued||["starting","vrf","hand","settling","recovering","error"].includes(s.phase);
 $("#cashout").disabled=!mine||(inCurrentHand&&leaveQueued)||["starting","recovering","error"].includes(s.phase);
 $("#cashout").textContent=inCurrentHand?(leaveQueued?"LEAVE QUEUED":"LEAVE AFTER HAND"):"CASH OUT";
 const selected=Number($("#seatSelect").value);
 $("#buy").disabled=!s.live||Boolean(mine)||Boolean(s.seats[selected])||busy;
 all("#seatSelect option").forEach((option,index)=>{option.disabled=Boolean(s.seats[index]);option.textContent="Seat "+(index+1)+(s.seats[index]?" · OCCUPIED":" · OPEN");});
 if(Date.now()>noticeUntil){
  if(!s.live)$("#notice").textContent=s.message||"Poker operator service is not configured.";
  else if(s.phase==="settling")$("#notice").textContent="Finalizing this hand on Ronin. The table will recover automatically if the host restarts.";else if(["error","recovering","starting"].includes(s.phase))$("#notice").textContent="The table is reconciling safely with Ronin. Player balances remain protected and play will resume automatically.";
  else if(!wallet)$("#notice").textContent="Table is live. Connect Ronin Wallet to take a seat.";
  else if(!mine)$("#notice").textContent="Choose an open seat, set your table name, and buy in.";
  else $("#notice").textContent="You are seated as "+(mine.name||short(mine.wallet))+". Press Ready when prepared.";
 }
}
async function poll(){
 try{
  const response=await fetch("/api/poker/state",{cache:"no-store",headers:token?{authorization:"Bearer "+token}:{}});
  render(await response.json());
 }catch(error){if(Date.now()>noticeUntil)$("#notice").textContent="Reconnecting to the global table...";}
 setTimeout(poll,900);
}
function setQuickBet(kind){
 if(!state?.hand)return;
 const pot=BigInt(state.hand.pot||0),stack=BigInt(state.hand.stacks?.[mySeat]||0);
 let amount=kind==="half"?pot/2n:pot;
 if(amount>stack)amount=stack;
 $("#raiseAmount").value=E.formatUnits(amount,18).split(".")[0];
}
$("#enter").onclick=()=>{if(!$("#riskCheck").checked||!$("#ageCheck").checked)return announce("Both acknowledgements are required.");sessionStorage.setItem("mattPokerRisk","yes");$("#risk").classList.add("hidden");};
if(sessionStorage.getItem("mattPokerRisk")==="yes")$("#risk").classList.add("hidden");
$("#connect").onclick=()=>connect().catch(e=>announce(friendly(e)));
$("#buy").onclick=()=>buyIn().catch(e=>announce(friendly(e)));
$("#cashout").onclick=()=>cashOut().catch(e=>announce(friendly(e)));
$("#ready").onclick=()=>api("/ready",{ready:true}).then(()=>announce("Ready. The countdown starts when the table has enough players.")).catch(e=>announce(friendly(e)));
$("#saveName").onclick=()=>saveProfile(true).catch(e=>announce(friendly(e)));
all("[data-action]").forEach(button=>button.onclick=()=>act(button.dataset.action).catch(e=>announce(friendly(e))));
all("[data-quick]").forEach(button=>button.onclick=()=>setQuickBet(button.dataset.quick));
all("[data-seat]").forEach(button=>button.onclick=()=>{const i=Number(button.dataset.seat);if(!state?.seats?.[i])$("#seatSelect").value=String(i);});
const savedName=localStorage.getItem("mattPokerName");if(savedName)$("#playerName").value=savedName;
poll();
})();
