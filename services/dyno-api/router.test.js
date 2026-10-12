"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { safeCsvCell } = require("./router");
test("CSV export neutralizes spreadsheet formulas", () => {
  assert.equal(safeCsvCell("=HYPERLINK(\"bad\")"), "'=HYPERLINK(\"bad\")");
  assert.equal(safeCsvCell("0xabc"), "0xabc");
});
