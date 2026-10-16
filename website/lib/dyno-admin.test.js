"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../public/dyno-admin.js"), "utf8");
function element() {
  return { children: [], events: {}, hidden: false, disabled: false, textContent: "", className: "", setAttribute() {},
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = [...items]; },
    addEventListener(name, handler) { this.events[name] = handler; } };
}
test("private admin mapping is never fetched before an explicit click and denies nonadmins", async () => {
  const parent = element(), calls = [];
  const context = { document: { getElementById: () => parent, createElement: () => element() }, navigator: { clipboard: { writeText: async () => {} } },
    fetch: async url => { calls.push(url); return { ok: false, status: 403 }; }, String, Math };
  vm.runInNewContext(source, context);
  assert.equal(calls.length, 0);
  const section = parent.children[0];
  const refresh = section.children.find(item => item.textContent === "CHECK ACCESS & LOAD");
  const download = section.children.find(item => item.textContent === "DOWNLOAD FIRST 250 (PRIVATE CSV)");
  const status = section.children.find(item => item.textContent === "Private records are not loaded.");
  assert.equal(download.hidden, true);
  await refresh.events.click();
  assert.equal(calls.length, 1);
  assert.equal(download.hidden, true);
  assert.match(status.textContent, /not an active DYNO administrator/);
});
test("relink UI copies new-wallet signing request then prepares only an unsigned admin draft", async () => {
  const parent = element(), calls = [], copied = [];
  const proxy = "0x0000000000000000000000000000000000000002";
  const context = { document: { getElementById: () => parent, createElement: () => element() }, navigator: { clipboard: { writeText: async value => copied.push(value) } },
    window: { ethers: { getAddress: value => value } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/dyno/config") return { ok: true, json: async () => ({ mock: false, raffleProxy: proxy, chainId: 2020 }) };
      if (url === "/api/dyno/admin/prepare") return { ok: true, json: async () => ({ target: proxy, value: "0", data: "0x1234", executionMode: "multisig", authorityBlock: "100", authorityBlockHash: "0x" + "ab".repeat(32), simulated: true, submitted: false }) };
      throw new Error("unexpected request");
    }, String, Math, Date, Number, BigInt, JSON };
  vm.runInNewContext(source, context);
  assert.equal(calls.length, 0);
  const relink = parent.children[1];
  const [commitment, newWallet, version, proof] = relink.children.slice(2, 6);
  commitment.value = "0x" + "11".repeat(32);
  newWallet.value = "0x0000000000000000000000000000000000000003";
  version.value = "1";
  const copyRequest = relink.children.find(item => item.textContent === "COPY NEW-WALLET SIGNING REQUEST");
  const prepare = relink.children.find(item => item.textContent === "PREPARE MULTISIG DRAFT");
  const copyDraft = relink.children.find(item => item.textContent === "COPY DRAFT");
  await copyRequest.events.click();
  const request = JSON.parse(copied[0]);
  assert.equal(request.primaryType, "RelinkAuthorization");
  assert.equal(request.domain.chainId, 2020);
  assert.equal(request.message.accountCommitment, commitment.value);
  assert.equal(calls.length, 1);
  proof.value = "0x" + "aa".repeat(65);
  await prepare.events.click();
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.method, "relinkIdentity");
  assert.equal(body.args[1], newWallet.value);
  assert.equal(body.args[4], proof.value);
  assert.equal(copyDraft.hidden, false);
  assert.match(relink.children.find(item => item.className === "status").textContent, /not been submitted or approved/);
});
test("settled eligible MATT claim prepares a simulated multisig draft without transferring tokens", async () => {
  const parent = element(), calls = [];
  const proxy = "0x0000000000000000000000000000000000000002";
  const context = { document: { getElementById: () => parent, createElement: () => element() }, navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (String(url).startsWith("/api/dyno/round?")) return { ok: true, json: async () => ({ paymentModel: "RON_AND_HELD_MATT", phase: "SETTLED", chainBlockHash: "0x" + "ab".repeat(32), chainBlock: "100", treasuryMattLiability: "700000000000000000000000000" }) };
      if (url === "/api/dyno/admin/prepare") return { ok: true, json: async () => ({ target: proxy, value: "0", data: "0x1234", authorityBlock: "101", submitted: false, simulated: true }) };
      throw new Error("unexpected request");
    }, String, BigInt, Number, JSON };
  vm.runInNewContext(source, context);
  assert.equal(calls.length, 0);
  const section = parent.children[2], round = section.children[2], prepare = section.children[3], status = section.children[4], draft = section.children[5];
  round.value = "1";
  await prepare.events.click();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).method, "claimTreasuryMatt");
  assert.equal(JSON.parse(calls[1].options.body).value, "0");
  assert.match(draft.textContent, /700000000000000000000000000/);
  assert.match(status.textContent, /Unsigned claim draft only/);
});
