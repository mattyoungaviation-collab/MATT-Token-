"use strict";
const crypto=require("crypto");
const RANKS="23456789TJQKA",SUITS="cdhs";

function cardName(card){return RANKS[card%13]+SUITS[Math.floor(card/13)];}
function deckSeed(secret,word,handId,contract){return crypto.createHash("sha256").update(String(secret)).update(String(word)).update(String(handId)).update(String(contract).toLowerCase()).digest();}
function shuffledDeck(seed){
  const deck=Array.from({length:52},(_,i)=>i);let counter=0,pool=Buffer.alloc(0);
  const next=()=>{if(pool.length<4){pool=Buffer.concat([pool,crypto.createHash("sha256").update(seed).update(Buffer.from(String(counter++))).digest()]);}const n=pool.readUInt32BE(0);pool=pool.subarray(4);return n;};
  for(let i=51;i>0;i--){const range=i+1,limit=Math.floor(0x100000000/range)*range;let n;do{n=next();}while(n>=limit);const j=n%range;[deck[i],deck[j]]=[deck[j],deck[i]];}return deck;
}
function straightHigh(ranks){const set=[...new Set(ranks)].sort((a,b)=>b-a);if(set.includes(14))set.push(1);for(let i=0;i<=set.length-5;i++)if(set[i]-set[i+4]===4)return set[i];return 0;}
function five(cards){
  const ranks=cards.map(c=>c%13+2).sort((a,b)=>b-a),flush=cards.every(c=>Math.floor(c/13)===Math.floor(cards[0]/13)),straight=straightHigh(ranks);
  const groups=[...new Set(ranks)].map(r=>[r,ranks.filter(x=>x===r).length]).sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  if(flush&&straight)return[8,straight];if(groups[0][1]===4)return[7,groups[0][0],groups[1][0]];
  if(groups[0][1]===3&&groups[1][1]===2)return[6,groups[0][0],groups[1][0]];
  if(flush)return[5,...ranks];if(straight)return[4,straight];
  if(groups[0][1]===3)return[3,groups[0][0],...groups.slice(1).map(x=>x[0])];
  if(groups[0][1]===2&&groups[1][1]===2)return[2,groups[0][0],groups[1][0],groups[2][0]];
  if(groups[0][1]===2)return[1,groups[0][0],...groups.slice(1).map(x=>x[0])];return[0,...ranks];
}
function compare(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]||0)-(b[i]||0);if(d)return d;}return 0;}
function evaluate(cards){if(cards.length<5)throw Error("five cards required");let best;for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++){const v=five([cards[a],cards[b],cards[c],cards[d],cards[e]]);if(!best||compare(v,best)>0)best=v;}return best;}
function nextClockwise(seat,candidates){for(let n=1;n<=6;n++){const i=(seat+n)%6;if(candidates.includes(i))return i;}return candidates[0];}
function settle({players,board,dealerSeat,rakeBps=0,rakeCap=0n}){
  const contributions=players.map(p=>BigInt(p.committed)),levels=[...new Set(contributions.filter(x=>x>0n).map(String))].map(BigInt).sort((a,b)=>a<b?-1:1);
  const payouts=Object.fromEntries(players.map(p=>[p.seat,0n])),pots=[];let previous=0n,uncalled=0n;
  for(const level of levels){const involved=players.filter(p=>BigInt(p.committed)>=level),amount=(level-previous)*BigInt(involved.length);previous=level;
    if(involved.length===1){payouts[involved[0].seat]+=amount;uncalled+=amount;continue;}
    pots.push({amount,eligible:involved.filter(p=>!p.folded)});
  }
  const matchedPot=pots.reduce((s,p)=>s+p.amount,0n);let rake=board.length>=3?matchedPot*BigInt(rakeBps)/10000n:0n;if(rake>BigInt(rakeCap))rake=BigInt(rakeCap);
  let remainingRake=rake;
  for(const pot of pots){const cut=remainingRake>pot.amount?pot.amount:remainingRake;pot.amount-=cut;remainingRake-=cut;
    let winners;if(pot.eligible.length===1)winners=pot.eligible;else{let best;winners=[];for(const p of pot.eligible){const score=evaluate([...p.cards,...board]);const cmp=best?compare(score,best):1;if(cmp>0){best=score;winners=[p];}else if(cmp===0)winners.push(p);}}
    const share=pot.amount/BigInt(winners.length),odd=Number(pot.amount%BigInt(winners.length));for(const w of winners)payouts[w.seat]+=share;
    const order=[];let cursor=dealerSeat;while(order.length<winners.length){cursor=nextClockwise(cursor,winners.map(w=>w.seat));if(!order.includes(cursor))order.push(cursor);}for(let i=0;i<odd;i++)payouts[order[i]]+=1n;
  }
  return{payouts,matchedPot,rake,uncalled};
}
module.exports={cardName,deckSeed,shuffledDeck,evaluate,compare,settle,nextClockwise};
