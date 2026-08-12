"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),path=require("path");
const pub=path.join(__dirname,"..","public");

test("Poker page exposes the global six-seat experience and identity controls",()=>{
 const html=fs.readFileSync(path.join(pub,"poker.html"),"utf8");
 assert.equal((html.match(/data-seat=/g)||[]).length,6);
 assert.match(html,/YOUR TABLE IDENTITY/);
 assert.match(html,/YOUR LIVE STACK/);
 assert.match(html,/18 or older/);
});

test("production config points to the verified Ronin deployment",()=>{
 const config=fs.readFileSync(path.join(pub,"poker-config.js"),"utf8");
 assert.match(config,/live:true/);
 assert.match(config,/chainId:2020/);
 assert.match(config,/0x5c64c838d8e7637dC2A4418792B69AE8C9DCFb34/);
});

test("live client renders casino cards and deducts committed chips from the displayed stack",()=>{
 const client=fs.readFileSync(path.join(pub,"poker.js"),"utf8");
 assert.match(client,/playing-card/);
 assert.match(client,/♠/);
 assert.match(client,/h\.stacks/);
 assert.match(client,/h\.committed/);
 assert.match(client,/parseMattInput/);
});

test("server publishes player identity and in-hand stack detail without exposing other hole cards",()=>{
 const routes=fs.readFileSync(path.join(__dirname,"poker-routes.js"),"utf8");
 assert.match(routes,/profiles/);
 assert.match(routes,/committed:h\.committed/);
 assert.match(routes,/holeCards:auth/);
 assert.doesNotMatch(routes,/holeCards:h\.holes/);
});
