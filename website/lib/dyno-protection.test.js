"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), ethers = require("ethers");
const source = fs.readFileSync(require("node:path").join(__dirname, "../public/dyno-protection.js"), "utf8");
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ mock = false } = {}) {
  const elements = new Map(), requests = [];
  const make = () => ({ value: "", textContent: "", disabled: false, handlers: {}, children: [], append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener(name, fn) { this.handlers[name] = fn; } });
  const byId = id => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  byId("protection-round").value = "1";
  let denied = false;
  const current = { saleSlippageBps: "200", buybackSlippageBps: "300", referenceWindowSeconds: "3600", maximumDeviationBps: "1000", minimumLiquidity: "900719925474099312345" };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    let body = mock ? { available: false, mock: true } : { roundId: "1", current, chainBlock: "100", guardAddress: "verified-guard", saleEditable: true, buybackEditable: true, guardEditable: true, canPropose: url.includes("/admin/") };
    if (url.endsWith("/prepare")) body = denied ? { error: "PROTECTION_CHANGED" } : { submitted: false, simulated: true, value: "0", args: JSON.parse(options.body) };
    return { ok: !denied, json: async () => body };
  };
  vm.runInNewContext(source, { document: { getElementById: byId, createElement: make }, fetch, window: { ethers }, navigator: { clipboard: { writeText: async () => {} } } });
  return { byId, requests, setDenied() { denied = true; } };
}
test("public and local mock views cannot prepare changes", async () => {
  const publicView = fixture(); await tick(); assert.equal(publicView.byId("protection-fields").disabled, true);
  const mock = fixture({ mock: true }); await tick(); assert.equal(mock.byId("protection-fields").disabled, true);
  assert.match(mock.byId("protection-status").textContent, /Local mock/); assert.equal(mock.byId("protection-copy").disabled, true);
});
test("authenticated controls prepare exact integer percentages and keep successful drafts explicitly unsigned", async () => {
  const f = fixture(); await tick(); f.byId("protection-refresh").handlers.click(); await tick();
  assert.equal(f.byId("protection-fields").disabled, false); assert.equal(f.byId("protection-liquidity").value, "900719925474099312345");
  f.byId("protection-window").value = "1800"; f.byId("protection-deviation").value = "20.01";
  f.byId("protection-guard").handlers.submit({ preventDefault() {} }); await tick();
  const sent = JSON.parse(f.requests.at(-1).options.body); assert.equal(sent.maximumDeviationBps, "2001"); assert.equal(sent.minimumLiquidity, "900719925474099312345");
  assert.equal(sent.expected.saleSlippageBps, "200"); assert.equal(JSON.parse(f.byId("protection-output").value).submitted, false);
  assert.match(f.byId("protection-status").textContent, /No setting has changed yet/); assert.equal(f.byId("protection-copy").disabled, false);
  f.setDenied(); f.byId("protection-sale").handlers.submit({ preventDefault() {} }); await tick();
  assert.equal(f.byId("protection-output").value, ""); assert.equal(f.byId("protection-fields").disabled, true); assert.equal(f.byId("protection-copy").disabled, true);
  assert.match(f.byId("protection-status").textContent, /No change submitted/);
});
