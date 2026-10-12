"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { jsonExact, eventKey } = require("./indexer");
test("indexer serializes bigints exactly", () => assert.deepEqual(jsonExact({ amount: 9007199254740993n }), { amount: "9007199254740993" }));
test("event dedupe key includes chain transaction and log index", () => assert.equal(eventKey(2020, { transactionHash: "0xAB", index: 7 }), "2020:0xab:7"));
