"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const websiteDir = path.resolve(__dirname, "..");
const publicDir = path.join(websiteDir, "public");
const html = fs.readFileSync(path.join(publicDir, "project-dyno.html"), "utf8");
const countdown = fs.readFileSync(path.join(publicDir, "dyno-countdown.js"), "utf8");
const server = fs.readFileSync(path.join(websiteDir, "server-combined.js"), "utf8");

test("Project Dyno launch page publishes the exact raffle format and entry limits", () => {
  for (const copy of [
    "MASSIVE ATTENTION THROUGH TIME",
    "ONE RAFFLE · SIX DRAWS",
    "35 RON",
    "700,000 MATT",
    "3 TICKETS",
    "1,000",
    "REPEAT WINS ALLOWED",
  ]) {
    assert.match(html, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("Project Dyno launch page lists every prize exactly", () => {
  for (const prize of [
    "70.2247 RON",
    "140.4494 RON",
    "1,404.4944 RON",
    "3,511.2360 RON",
    "7,022.4719 RON",
    "WATER DYNO #1358",
  ]) {
    assert.match(html, new RegExp(prize.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("launch page reflects the open round without an obsolete opening countdown", () => {
  assert.match(html, /LIVE ON RONIN/);
  assert.match(html, /data-live-status/);
  assert.doesNotMatch(html, /TARGET OPENING|SATURDAY · OCTOBER 17|data-countdown-unit/);
  assert.doesNotMatch(countdown, /TARGET_AT|2026-10-17T07:00:00Z/);
  assert.match(countdown, /health\.purchasesEnabled === true/);
});

test("launch aliases and official community links are wired", () => {
  assert.match(server, /\["\/project-dyno", "\/project-dyno\/", "\/raffle", "\/raffle\/"\]/);
  assert.match(html, /https:\/\/discord\.gg\/Tk4njfX4E/);
  assert.match(html, /https:\/\/x\.com\/crafting_skill\?s=11/);
  assert.match(html, /https:\/\/explorer\.roninchain\.com\/address\//);
});

test("X share control publishes the current entry link and fixed ticket terms", () => {
  assert.match(html, /data-x-share/);
  assert.match(html, /data-share-preview/);
  assert.match(html, /rel="canonical" href="https:\/\/matttoken\.com\/project-dyno"/);
  assert.match(countdown, /twitter\.com\/intent\/tweet/);
  assert.match(countdown, /35 RON \+ 700,000 MATT per ticket/);
  assert.match(countdown, /#MATT #Ronin/);
});
