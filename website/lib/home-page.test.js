"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.resolve(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const script = fs.readFileSync(path.join(publicDir, "home.js"), "utf8");
const dyno = fs.readFileSync(path.join(publicDir, "dyno.html"), "utf8");
const dynoLaunch = fs.readFileSync(path.join(publicDir, "project-dyno.html"), "utf8");
const hub = fs.readFileSync(path.join(publicDir, "hub.html"), "utf8");
const publicSource = fs.readdirSync(publicDir)
  .filter(file => /\.(?:html|js|json)$/.test(file) && file !== "explorer-links.js")
  .map(file => fs.readFileSync(path.join(publicDir, file), "utf8"))
  .join("\n");

test("homepage leads with MATT purpose and current Project DYNO entry status", () => {
  assert.match(html, /utility and purpose across Ronin/i);
  assert.match(html, /PROJECT <span>DYNO<\/span>/);
  assert.match(html, /LIVE ROUND STATUS/);
  assert.match(html, /35 RON \+ 700,000 MATT/);
  assert.match(html, /href="\/dyno"/);
  assert.doesNotMatch(html, /Ticket sales are not live|Final checks are underway/);
});

test("official community links are current across the launch pages", () => {
  for (const page of [html, dyno, dynoLaunch, hub]) {
    assert.match(page, /https:\/\/discord\.gg\/Tk4njfX4E/);
    assert.match(page, /https:\/\/x\.com\/crafting_skill\?s=11/);
  }
  assert.doesNotMatch(publicSource, /discord\.gg\/yBhjyPbtz/);
});

test("homepage JavaScript hooks are present in the page", () => {
  const usedIds = [...script.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(match => match[1]);
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const missing = [...new Set(usedIds.filter(id => !htmlIds.has(id)))];
  assert.deepEqual(missing, []);
});

test("public address and transaction links use the official Ronin explorer", () => {
  assert.doesNotMatch(publicSource, /https:\/\/app\.roninchain\.com\/(?:explorer\/)?(?:address|tx)\//);
  assert.match(html, /https:\/\/explorer\.roninchain\.com\/address\//);
});
