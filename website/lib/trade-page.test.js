"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "trade.html"), "utf8");
const client = fs.readFileSync(path.join(publicDir, "trade.js"), "utf8");

test("trade lab is a first-party MATT page with the verified deployment", () => {
  assert.match(html, /https:\/\/matttoken\.com\/trade/);
  assert.match(html, /MATT Round Trip Tester/);
  assert.match(client, /0x048e792E32fc9E04bB47E9C5D8baCd41F4b0E425/);
  assert.match(client, /0xa5450417BDCa0BDfB058ffE41205400FfDA1174d/);
  assert.match(html, /repo\.sourcify\.dev\/2020\/0x048e792E32fc9E04bB47E9C5D8baCd41F4b0E425/);
  assert.doesNotMatch(`${html}\n${client}`, /crypto23b\.chatgpt\.site|app\.roninchain\.com/);
});

test("every generated chain link uses the canonical Ronin explorer", () => {
  assert.match(html, /https:\/\/explorer\.roninchain\.com\/address\/0x048e792E32fc9E04bB47E9C5D8baCd41F4b0E425/);
  assert.match(client, /explorer: "https:\/\/explorer\.roninchain\.com"/);
  assert.match(client, /ROUND_TRIP_COMPLETED_TOPIC/);
  assert.match(html, /Confirmed return/);
});


