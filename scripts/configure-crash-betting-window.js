const fs = require("fs");
const path = require("path");

const DEFAULT_BETTING_MS = 30_000;
const bettingMs = Number.parseInt(process.env.CRASH_BETTING_MS || String(DEFAULT_BETTING_MS), 10);

if (!Number.isInteger(bettingMs) || bettingMs < 5_000 || bettingMs > 120_000) {
  throw new Error("CRASH_BETTING_MS must be an integer between 5000 and 120000 milliseconds.");
}

const targets = [
  path.join(__dirname, "..", "website", "lib", "crash-routes-contract.js"),
  path.join(__dirname, "..", "website", "public", "crash-mainnet.js")
];

for (const filename of targets) {
  const source = fs.readFileSync(filename, "utf8");
  const pattern = /const BETTING_MS = [\d_]+;/;
  if (!pattern.test(source)) {
    throw new Error(`Crash betting-window marker was not found in ${filename}`);
  }

  const replacement = `const BETTING_MS = ${bettingMs.toLocaleString("en-US").replace(/,/g, "_")};`;
  const updated = source.replace(pattern, replacement);
  if (updated !== source) fs.writeFileSync(filename, updated);
}

console.log(`MATT Crash betting window configured to ${(bettingMs / 1000).toFixed(0)} seconds.`);
