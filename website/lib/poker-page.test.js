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
 assert.match(config,/"live":true/);
 assert.match(config,/"chainId":2020/);
 assert.match(config,/0x5c64c838d8e7637dC2A4418792B69AE8C9DCFb34/);
});

test("live client renders casino cards and deducts committed chips from the displayed stack",()=>{
 const client=fs.readFileSync(path.join(pub,"poker.js"),"utf8");
 assert.match(client,/playing-card/);
 assert.match(client,/♠/);
 assert.match(client,/h\.stacks/);
 assert.match(client,/hand\.committed/);
 assert.match(client,/parseMattInput/);
 assert.match(client,/boardRenderKey/);
 assert.match(client,/nextHoleKey/);
});

test("server publishes player identity and in-hand stack detail without exposing other hole cards",()=>{
 const routes=fs.readFileSync(path.join(__dirname,"poker-routes.js"),"utf8");
 assert.match(routes,/profiles/);
 assert.match(routes,/committed:h\.committed/);
 assert.match(routes,/holeCards:initialized&&auth/);
 assert.doesNotMatch(routes,/holeCards:h\.holes/);
 assert.match(routes,/lastFinalizedHandId/);
 assert.match(routes,/participants\.has\(i\)/);
 assert.match(routes,/phase==="settling"/);
});

test("poker polling is cached, batched, phase-aware, and independent of state requests",()=>{
 const routes=fs.readFileSync(path.join(__dirname,"poker-routes.js"),"utf8");
 assert.match(routes,/staticNetwork:true/);
 assert.match(routes,/multicall\.aggregate3\.staticCall/);
 assert.match(routes,/seatRefreshPromise/);
 assert.match(routes,/SEAT_CACHE_TTL_MS/);
 assert.match(routes,/IDLE_SEAT_CACHE_TTL_MS/);
 assert.match(routes,/IDLE_TICK_MS=20000/);
 assert.doesNotMatch(routes,/setInterval\(tick,1000\)/);
 assert.doesNotMatch(routes,/router\.get\("\/state"[^\n]*await tick\(\)/);
});

test("browser poker polling pauses in hidden tabs and resumes on visibility",()=>{
 const client=fs.readFileSync(path.join(pub,"poker.js"),"utf8");
 assert.match(client,/POLL_INTERVAL_MS=3000/);
 assert.match(client,/document\.hidden/);
 assert.match(client,/visibilitychange/);
 assert.doesNotMatch(client,/setTimeout\(poll,900\)/);
});
