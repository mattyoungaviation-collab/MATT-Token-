const fs = require("fs");
const path = require("path");

const DEFAULT_BETTING_MS = 30_000;
const bettingMs = Number.parseInt(process.env.CRASH_BETTING_MS || String(DEFAULT_BETTING_MS), 10);

if (!Number.isInteger(bettingMs) || bettingMs < 5_000 || bettingMs > 120_000) {
  throw new Error("CRASH_BETTING_MS must be an integer between 5000 and 120000 milliseconds.");
}

const root = path.join(__dirname, "..");
const backendFile = path.join(root, "website", "lib", "crash-routes-contract.js");
const clientFile = path.join(root, "website", "public", "crash-mainnet.js");
const htmlFile = path.join(root, "website", "public", "crash.html");

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Crash startup marker was not found: ${label}`);
  return source.replace(pattern, replacement);
}

const formattedBettingMs = bettingMs.toLocaleString("en-US").replace(/,/g, "_");

let backend = fs.readFileSync(backendFile, "utf8");
backend = replaceRequired(
  backend,
  /const BETTING_MS = [\d_]+;/,
  `const BETTING_MS = ${formattedBettingMs};`,
  "backend BETTING_MS"
);

if (!backend.includes("timing: { bettingMs: BETTING_MS, crashedMs: CRASHED_MS }")) {
  backend = replaceRequired(
    backend,
    /serverTime: Date\.now\(\),\n\s*chainId:/,
    "serverTime: Date.now(),\n      timing: { bettingMs: BETTING_MS, crashedMs: CRASHED_MS },\n      chainId:",
    "backend public timing"
  );
}

if (!backend.includes("flightStartedAt: r.flightStartedAt || null")) {
  backend = replaceRequired(
    backend,
    /startAt: view\.startAt,\n\s*phaseEndsAt: view\.phaseEndsAt/,
    "startAt: view.startAt,\n        flightStartedAt: r.flightStartedAt || null,\n        phaseEndsAt: view.phaseEndsAt",
    "backend flightStartedAt"
  );
}
fs.writeFileSync(backendFile, backend);

let client = fs.readFileSync(clientFile, "utf8");
client = replaceRequired(
  client,
  /const BETTING_MS = [\d_]+;/,
  `const BETTING_MS = ${formattedBettingMs};`,
  "client BETTING_MS"
);

const oldFlightClock = /const flightStartedAt = Number\(round\.startAt \|\| now\) \+ BETTING_MS;/;
const authoritativeFlightClock = "const flightStartedAt = Number(round.flightStartedAt || (Number(round.startAt || now) + Number(liveState?.timing?.bettingMs || BETTING_MS)));";
if (!client.includes(authoritativeFlightClock)) {
  client = replaceRequired(client, oldFlightClock, authoritativeFlightClock, "client flight clock");
}
fs.writeFileSync(clientFile, client);

let html = fs.readFileSync(htmlFile, "utf8");
const commitVersion = String(process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || "local").slice(0, 12);
const assetVersion = `flight-time-${bettingMs}-${commitVersion}`;
html = replaceRequired(
  html,
  /\/crash-mainnet\.js\?v=[^\"]+/,
  `/crash-mainnet.js?v=${assetVersion}`,
  "Crash mainnet asset URL"
);
fs.writeFileSync(htmlFile, html);

console.log(`MATT Crash betting window configured to ${(bettingMs / 1000).toFixed(0)} seconds.`);
console.log(`MATT Crash client configured to use the keeper's authoritative flightStartedAt timestamp.`);
console.log(`MATT Crash asset version: ${assetVersion}`);
