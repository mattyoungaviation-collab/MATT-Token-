"use strict";
const test = require("node:test"); const assert = require("node:assert/strict"); const fs = require("fs"); const path = require("path");
const html = fs.readFileSync(path.join(__dirname,"../public/dyno.html"),"utf8"); const js = fs.readFileSync(path.join(__dirname,"../public/dyno.js"),"utf8");
test("Project DYNO page exposes fixed-price no-sale disclosures and claims",()=>{for(const text of ["35 RON","700,000 MATT","Progress can move backward","Repeat wins allowed","NO AUTOMATIC SWAPS","Upgrades can change active logic","Claims never expire"])assert.match(html,new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));});
test("local demo cannot enable fake purchases or advertise an unfunded buyback",()=>{assert.match(js,/if\(state\.config\?\.mock\)throw/);assert.doesNotMatch(html,/168 WINDOWS/);assert.match(html,/water-dyno-1358\.png/);assert.match(html,/owner-supplied marketplace capture/);});
test("manual custody is disclosed and NFT delivery requires a verified receipt",()=>{assert.match(html,/Owner-held on Ethereum/);assert.match(html,/no contract escrow/);assert.match(js,/CONFIRMED_DELIVERY/);assert.match(js,/verified\s*===\s*true/);});
test("unilateral emergency upgrade authority and key risk are publicly disclosed",()=>{assert.match(html,/activated emergency admin/);assert.match(html,/0x1DAb596D0121C250a24B00137E84170FA6874be6/);assert.match(html,/bypass the 2-of-3 threshold/);assert.match(html,/all contract-held funds at risk/);assert.match(html,/local configuration is not an executed grant/);});
test("mobile entry path is direct while NFT traits and raw ledger data remain available",()=>{
  assert.match(html,/href="#checkout"/);
  assert.match(html,/id="checkout"/);
  assert.match(html,/<details class="nft-traits">/);
  assert.match(js,/Raw event data/);
  assert.match(js,/https:\/\/explorer\.roninchain\.com\/tx\//);
  assert.doesNotMatch(js,/td\.textContent=JSON\.stringify\(row\.payload\)/);
  assert.match(html,/\/dyno\.js\?v=20261016-ux/);
  assert.match(html,/\/dyno-nft\.css\?v=20261016-ux/);
});
