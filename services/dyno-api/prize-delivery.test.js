"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { Interface } = require("ethers");
const { verifyNftReceipt } = require("./prize-delivery");
const collection = "0xd1b248DEE3a4a0E9215e349dCe237D4B6d6bB8A3";
const depositor = "0x1DAb596D0121C250a24B00137E84170FA6874be6";
const winner = "0x0000000000000000000000000000000000000011";
const wrong = "0x0000000000000000000000000000000000000022";
const iface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);
function fixture({ receiver = winner, tokenId = 1358, address = collection, sender = depositor } = {}) {
  const event = iface.encodeEventLog(iface.getEvent("Transfer"), [sender, receiver, tokenId]);
  const hash = `0x${"aa".repeat(32)}`;
  return { receipt: { status: 1, hash, blockNumber: 100, blockHash: hash, logs: [{ address, topics: event.topics, data: event.data }] }, expected: { chainId: 1, expectedChainId: 1, collection, tokenId: 1358, depositor, winner, head: 111, finalityBlocks: 12, canonicalBlockHash: hash } };
}
test("NFT delivery requires successful canonical Ethereum receipt with the exact collection, sender, token and assigned winner", () => {
  const f = fixture(); assert.equal(verifyNftReceipt(f.receipt, f.expected).verified, true);
  for (const overrides of [{ receiver: wrong }, { tokenId: 1359 }, { address: wrong }, { sender: wrong }]) {
    const invalid = fixture(overrides); assert.equal(verifyNftReceipt(invalid.receipt, invalid.expected).verified, false);
  }
  assert.equal(verifyNftReceipt(f.receipt, { ...f.expected, chainId: 2020 }).reason, "WRONG_CHAIN");
  assert.equal(verifyNftReceipt({ ...f.receipt, status: 0 }, f.expected).reason, "REVERTED_TRANSFER");
  assert.equal(verifyNftReceipt(f.receipt, { ...f.expected, canonicalBlockHash: `0x${"bb".repeat(32)}` }).reason, "NONCANONICAL_RECEIPT");
});
test("Submitted and insufficiently confirmed NFT transfers cannot be displayed as delivered", () => {
  const f = fixture(); assert.equal(verifyNftReceipt(null, f.expected).status, "PENDING_RECEIPT");
  const result = verifyNftReceipt(f.receipt, { ...f.expected, head: 110 });
  assert.equal(result.status, "PENDING_CONFIRMATIONS"); assert.equal(result.verified, false);
  assert.equal(verifyNftReceipt({ ...f.receipt, logs: [...f.receipt.logs, ...f.receipt.logs] }, f.expected).verified, false);
  const onward = fixture({ sender: winner, receiver: wrong });
  assert.equal(verifyNftReceipt({ ...f.receipt, logs: [...f.receipt.logs, ...onward.receipt.logs] }, f.expected).verified, false);
});
