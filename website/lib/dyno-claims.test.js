"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../public/dyno-claims.js"), "utf8");
function element() {
  return {
    value: "", disabled: true, hidden: false, events: {}, children: [],
    setAttribute() {}, addEventListener(name, handler) { this.events[name] = handler; },
    after(...children) { this.children.push(...children); }, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  };
}
async function fixture({ mock = false, wallet = "0x0000000000000000000000000000000000000001", prize = false } = {}) {
  const input = element(), check = element(), calls = [], altCalls = [], prizeCalls = [], authorizations = [];
  input.value = "42";
  let refunded = false, prizePaid = false, releaseReceipt;
  const receipt = new Promise(resolve => { releaseReceipt = resolve; });
  const config = { mock, raffleProxy: "0x0000000000000000000000000000000000000002", chainId: 2020, mattDecimals: 18 };
  const ticket = () => ({ ticketId: "42", roundId: "1", chainBlockHash: "0x" + "ab".repeat(32), chainBlock: "100", originalWallet: "0x0000000000000000000000000000000000000001", status: refunded ? "REFUND_PAID" : "REFUND_CREDITED", refundAmount: "35000000000000000000", refundMatt: refunded ? "0" : "700000000000000000000000", refundPaid: refunded, winningIndexes: prize ? [1] : [] });
  const winners = () => ({ roundId: "1", chainBlockHash: "0x" + "ab".repeat(32), assigned: true, winners: [{ prizeIndex: 1, ticketId: "42", beneficiary: "0x0000000000000000000000000000000000000001", kind: "RON", amount: "140449400000000000000", entitlementFunded: true, paid: prizePaid }] });
  const context = {
    document: { getElementById: id => id === "claim-ticket" ? input : id === "claim-button" ? check : null, createElement: () => element() },
    fetch: async url => ({ ok: true, json: async () => String(url).includes("/config") ? config : String(url).includes("/winners") ? winners() : ticket() }),
    window: {
      ethereum: {}, confirm: () => true,
      ethers: {
        formatEther: amount => String(amount / 10n ** 18n), formatUnits: (amount, decimals) => String(amount / 10n ** BigInt(decimals)), getAddress: address => address, ZeroAddress: "0x0000000000000000000000000000000000000000", id: () => "0x" + "cd".repeat(32),
        keccak256: () => "0x" + "ef".repeat(32), AbiCoder: { defaultAbiCoder: () => ({ encode: () => "0x1234" }) },
        BrowserProvider: class { async getNetwork() { return { chainId: 2020n }; } async getSigner() { return { getAddress: async () => wallet, signTypedData: async (domain, types, authorization) => { authorizations.push({ domain, types, authorization }); return "0xsigned"; } }; } },
        Contract: class {
          async claimNonce() { return 0n; }
          async claimRefund(id) { calls.push(id); return { hash: "0x123", wait: async () => { const value = await receipt; refunded = true; return value; } }; }
          async claimRefundTo(...args) { altCalls.push(args); return { hash: "0x456", wait: async () => { const value = await receipt; refunded = true; return value; } }; }
          async claimPrizeTo(...args) { prizeCalls.push(args); return { hash: "0x789", wait: async () => { const value = await receipt; prizePaid = true; return value; } }; }
        },
      },
    },
    BigInt, Number, String,
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { input, check, status: check.children[0], claim: check.children[1], receiverInput: check.children[2].children[0], claimTo: check.children[3], prizeList: check.children[4], calls, altCalls, prizeCalls, authorizations, releaseReceipt };
}
test("local mock never enables refund claims", async () => {
  const f = await fixture({ mock: true });
  assert.equal(f.check.disabled, true);
  assert.equal(f.claim.hidden, true);
});
test("refund UI checks chain ticket and wallet, then waits for receipt before showing paid", async () => {
  const wrong = await fixture({ wallet: "0x0000000000000000000000000000000000000003" });
  assert.equal(wrong.check.disabled, false);
  await wrong.check.events.click();
  assert.equal(wrong.claim.hidden, false);
  await wrong.claim.events.click();
  assert.equal(wrong.calls.length, 0);
  assert.match(wrong.status.textContent, /Only the original purchasing wallet/);

  const right = await fixture();
  await right.check.events.click();
  const pending = right.claim.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(right.calls, [42n]);
  assert.match(right.status.textContent, /Waiting for confirmation/);
  assert.doesNotMatch(right.status.textContent, /confirmed/i);
  right.releaseReceipt({ status: 1, blockNumber: 101 });
  await pending;
  assert.match(right.status.textContent, /refund paid/);
  assert.equal(right.claim.hidden, true);
});
test("alternate receiver requires owner EIP-712 authorization and confirmed payment", async () => {
  const f = await fixture();
  await f.check.events.click();
  f.receiverInput.value = "0x0000000000000000000000000000000000000004";
  const pending = f.claimTo.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.authorizations.length, 1);
  assert.equal(f.authorizations[0].domain.name, "Project DYNO");
  assert.equal(f.authorizations[0].authorization.itemId, 42n);
  assert.equal(f.altCalls[0][1], f.receiverInput.value);
  assert.match(f.status.textContent, /Waiting for confirmation/);
  f.releaseReceipt({ status: 1, blockNumber: 102 });
  await pending;
  assert.match(f.status.textContent, /refund paid/);
});
test("funded RON prize requires winner authorization and confirmation before showing paid", async () => {
  const f = await fixture({ prize: true });
  await f.check.events.click();
  assert.equal(f.prizeList.children.length, 1);
  assert.equal(f.check.children[2].hidden, false);
  const button = f.prizeList.children[0].children[0];
  assert.match(button.textContent, /CLAIM DRAW 2/);
  const pending = button.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.authorizations.length, 1);
  assert.equal(f.authorizations[0].authorization.itemId, BigInt("0x" + "ef".repeat(32)));
  assert.equal(f.prizeCalls[0][1], 1);
  assert.match(f.status.textContent, /Waiting for confirmation/);
  f.releaseReceipt({ status: 1, blockNumber: 103 });
  await pending;
  assert.match(f.prizeList.children[0].textContent, /paid/);
  assert.equal(f.prizeList.children[0].children.length, 0);
});
