"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toUtf8Bytes } = require("ethers");

// Owner approved the no-sale participant terms and draft five-prize schedule
// on 2026-10-15. This pins the exact approved text, not legal approval or
// authorization to deploy, open sales, or move assets.
const APPROVED_TERMS_HASH = "0x79051218eede3d1405b5edd40ac958f087d44432cc968b15ddfe65c89d43720f";
const TERMS_PATH = path.resolve(__dirname, "../../docs/project-dyno/TERMS.md");

function currentTermsHash() {
  const text = fs.readFileSync(TERMS_PATH, "utf8").replace(/\r\n?/g, "\n");
  return keccak256(toUtf8Bytes(text));
}

function validateApprovedTerms(manifestHash) {
  const errors = [];
  if (currentTermsHash().toLowerCase() !== APPROVED_TERMS_HASH.toLowerCase()) {
    errors.push("TERMS.md changed after owner approval; obtain approval for the new exact text");
  }
  if (String(manifestHash || "").toLowerCase() !== APPROVED_TERMS_HASH.toLowerCase()) {
    errors.push("manifest termsHash does not match the owner-approved no-sale terms");
  }
  return errors;
}

if (require.main === module) {
  const current = currentTermsHash();
  const errors = validateApprovedTerms(process.argv[2] || APPROVED_TERMS_HASH);
  console.log(JSON.stringify({ termsPath: "docs/project-dyno/TERMS.md", normalization: "UTF-8, LF line endings", currentTermsHash: current, approvedTermsHash: APPROVED_TERMS_HASH, verified: errors.length === 0 }));
  if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
}

module.exports = { APPROVED_TERMS_HASH, TERMS_PATH, currentTermsHash, validateApprovedTerms };
