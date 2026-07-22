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
backend = replaceRequired(backend, /const BETTING_MS = [\d_]+;/, `const BETTING_MS = ${formattedBettingMs};`, "backend BETTING_MS");

if (!backend.includes("timing: { bettingMs: BETTING_MS, crashedMs: CRASHED_MS }")) {
  backend = replaceRequired(backend, /serverTime: Date\.now\(\),\n\s*chainId:/, "serverTime: Date.now(),\n      timing: { bettingMs: BETTING_MS, crashedMs: CRASHED_MS },\n      chainId:", "backend public timing");
}
if (!backend.includes("flightStartedAt: r.flightStartedAt || null")) {
  backend = replaceRequired(backend, /startAt: view\.startAt,\n\s*phaseEndsAt: view\.phaseEndsAt/, "startAt: view.startAt,\n        flightStartedAt: r.flightStartedAt || null,\n        phaseEndsAt: view.phaseEndsAt", "backend flightStartedAt");
}
if (!backend.includes("let lastKeeperError = null;")) {
  backend = replaceRequired(backend, /let ticking = false;\n/, "let ticking = false;\n  let lastKeeperError = null;\n", "backend keeper diagnostics");
}
const staleCommitRecovery = `    if (Date.now() >= r.bettingClosesAt * 1000) {
      console.warn(\`Crash round \${r.counter} was never committed before its betting deadline; replacing the empty stale round.\`);
      state.current = null;
      state.cashouts = {};
      wagerCache = { roundId: null, checkedAt: 0, entries: [], stale: false, error: null, fromBlock: null, toBlock: null };
      persist();
      return;
    }
`;
if (!backend.includes("was never committed before its betting deadline")) {
  backend = replaceRequired(backend, /    const tx = await vaultWrite\.commitRound\(r\.roundId, r\.commitment, r\.bettingClosesAt\);/, `${staleCommitRecovery}    const tx = await vaultWrite.commitRound(r.roundId, r.commitment, r.bettingClosesAt);`, "backend stale commit recovery");
}
if (!backend.includes("lastKeeperError = { at: Date.now()")) {
  backend = replaceRequired(backend, /      const status = await refreshStatus\(\);/, "      lastKeeperError = null;\n      const status = await refreshStatus();", "backend clear keeper error");
  backend = replaceRequired(backend, /      console\.error\("Crash keeper tick failed:", errorText\(error\)\);/, "      lastKeeperError = { at: Date.now(), stage: state.current?.stage || \"idle\", message: errorText(error) };\n      console.error(\"Crash keeper tick failed:\", lastKeeperError.message);", "backend capture keeper error");
  backend = replaceRequired(backend, /        stage: state\.current\?\.stage \|\| "idle",/, "        stage: state.current?.stage || \"idle\",\n        lastKeeperError,", "backend health keeper error");
}

if (!backend.includes("const crashSessions = new Map();")) {
  backend = replaceRequired(backend, /  let wagerCache = ([^;]+);\n/, match => `${match}  const crashChallenges = new Map();\n  const crashSessions = new Map();\n  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;\n  const CHALLENGE_TTL_MS = 5 * 60 * 1000;\n`, "backend session stores");
  backend = replaceRequired(backend, /  function persist\(\) \{ atomicWrite\(stateFile, state\); \}\n/, `  function persist() { atomicWrite(stateFile, state); }
  function sessionMessage(wallet, nonce) {
    return \`MATT SPACE FLIGHT SESSION\\nVault:\${ethers.getAddress(vaultAddress)}\\nWallet:\${ethers.getAddress(wallet)}\\nNonce:\${nonce}\`;
  }
  function bearerToken(req) {
    const header = String(req.headers.authorization || "");
    return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  }
  function authenticatedWallet(req) {
    const token = bearerToken(req);
    const session = crashSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) crashSessions.delete(token);
      return null;
    }
    return session.wallet;
  }
`, "backend session helpers");
  backend = replaceRequired(backend, /  router\.post\("\/cashout", async \(req, res\) => \{[\s\S]*?\n  \}\);\n\n  return router;/, `  router.get("/session/challenge/:wallet", (req, res) => {
    const wallet = normalizeAddress(req.params.wallet);
    if (!wallet) return res.status(400).json({ error: "INVALID_WALLET" });
    const nonce = crypto.randomBytes(24).toString("hex");
    crashChallenges.set(wallet, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    res.set("Cache-Control", "no-store");
    res.json({ wallet, nonce, message: sessionMessage(wallet, nonce), expiresAt: Date.now() + CHALLENGE_TTL_MS });
  });
  router.post("/session", (req, res) => {
    try {
      const wallet = normalizeAddress(req.body?.wallet);
      const nonce = String(req.body?.nonce || "");
      const signature = String(req.body?.signature || "");
      const challenge = wallet ? crashChallenges.get(wallet) : null;
      if (!wallet || !challenge || challenge.nonce !== nonce || challenge.expiresAt <= Date.now()) return res.status(401).json({ error: "SESSION_CHALLENGE_EXPIRED" });
      const recovered = normalizeAddress(ethers.verifyMessage(sessionMessage(wallet, nonce), signature));
      if (recovered !== wallet) return res.status(401).json({ error: "INVALID_SIGNATURE" });
      crashChallenges.delete(wallet);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + SESSION_TTL_MS;
      crashSessions.set(token, { wallet, expiresAt });
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, token, wallet, expiresAt });
    } catch (error) {
      res.status(400).json({ error: "SESSION_REJECTED", message: errorText(error) });
    }
  });
  router.post("/cashout", async (req, res) => {
    try {
      const sessionWallet = authenticatedWallet(req);
      const r = state.current;
      const view = phaseView();
      const wallet = normalizeAddress(req.body?.wallet);
      const roundId = String(req.body?.roundId || "");
      if (!sessionWallet || !wallet || sessionWallet !== wallet) return res.status(401).json({ error: "CRASH_SESSION_REQUIRED" });
      if (!r || !view || view.phase !== "flying" || roundId !== r.roundId) return res.status(409).json({ error: "ROUND_NOT_FLYING" });
      const wagerId = ethers.keccak256(ethers.solidityPacked(["uint256", "address", "bytes32", "address"], [CHAIN_ID, vaultAddress, roundId, wallet]));
      const wager = await vaultRead.wagers(wagerId);
      if (normalizeAddress(wager.player) !== wallet || wager.settled) return res.status(409).json({ error: "NO_OPEN_WAGER" });
      const existing = state.cashouts[wagerId];
      if (existing) return res.json({ ok: true, wagerId, ...existing, multiplier: existing.cashoutBps / BPS, duplicate: true });
      const status = await refreshStatus();
      const cashoutBps = Math.min(observedMultiplierBps(r, Date.now()), Number(status.maxCashoutBps));
      if (cashoutBps >= r.crashPointBps) return res.status(409).json({ error: "TOO_LATE" });
      state.cashouts[wagerId] = { wallet, cashoutBps, receivedAt: Date.now(), authenticatedSession: true };
      persist();
      wagerCache.checkedAt = 0;
      res.json({ ok: true, wagerId, cashoutBps, multiplier: cashoutBps / BPS });
    } catch (error) {
      res.status(400).json({ error: "CASHOUT_REJECTED", message: errorText(error) });
    }
  });

  return router;`, "backend authenticated cashout routes");
}
backend = backend.replace("version: 6,", "version: 8,").replace("version: 7,", "version: 8,");
fs.writeFileSync(backendFile, backend);

let client = fs.readFileSync(clientFile, "utf8");
client = replaceRequired(client, /const BETTING_MS = [\d_]+;/, `const BETTING_MS = ${formattedBettingMs};`, "client BETTING_MS");
const oldFlightClock = /const flightStartedAt = Number\(round\.startAt \|\| now\) \+ BETTING_MS;/;
const authoritativeFlightClock = "const flightStartedAt = Number(round.flightStartedAt || (Number(round.startAt || now) + Number(liveState?.timing?.bettingMs || BETTING_MS)));";
if (!client.includes(authoritativeFlightClock)) client = replaceRequired(client, oldFlightClock, authoritativeFlightClock, "client flight clock");

if (!client.includes("let crashSessionToken = null;")) {
  client = replaceRequired(client, /  let cashoutSentForRound = null;\n/, "  let cashoutSentForRound = null;\n  let crashSessionToken = null;\n  let crashSessionExpiresAt = 0;\n", "client session state");
  client = replaceRequired(client, /  async function activate\(address\) \{([\s\S]*?)    await refreshAccount\(true\);\n/, `  function crashSessionKey() { return \`matt-crash-session:\${String(wallet || "").toLowerCase()}:\${String(liveState?.vaultAddress || "").toLowerCase()}\`; }
  function loadCrashSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(crashSessionKey()) || "{}");
      if (saved.token && Number(saved.expiresAt) > Date.now() + 60_000) {
        crashSessionToken = saved.token;
        crashSessionExpiresAt = Number(saved.expiresAt);
        return true;
      }
    } catch {}
    crashSessionToken = null;
    crashSessionExpiresAt = 0;
    return false;
  }
  async function ensureCrashSession(force = false) {
    if (!wallet || !signer || !liveState?.vaultAddress) throw new Error("Connect Ronin Wallet first.");
    if (!force && crashSessionToken && crashSessionExpiresAt > Date.now() + 60_000) return crashSessionToken;
    if (!force && loadCrashSession()) return crashSessionToken;
    say("Sign once to activate instant Crash cash-outs.");
    const challenge = await fetchJson(\`/api/crash/session/challenge/\${wallet}\`);
    const signature = await signer.signMessage(challenge.message);
    const session = await fetchJson("/api/crash/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, nonce: challenge.nonce, signature }) });
    crashSessionToken = session.token;
    crashSessionExpiresAt = Number(session.expiresAt);
    localStorage.setItem(crashSessionKey(), JSON.stringify({ token: crashSessionToken, expiresAt: crashSessionExpiresAt }));
    return crashSessionToken;
  }
  async function activate(address) {$1    await refreshAccount(true);
    await ensureCrashSession();
`, "client session activation");
  client = replaceRequired(client, /  function cashoutText\(timestamp\) \{[\s\S]*?\n  \}\n  async function cashOut\(auto = false\) \{[\s\S]*?\n  \}\n  async function withdraw/, `  async function cashOut(auto = false) {
    const round = liveState?.round;
    if (!wallet || !currentWagerId || currentWagerRoundId !== round?.roundId || round?.phase !== "flying") throw new Error("No active wager to cash out.");
    if (cashoutSentForRound === round.roundId || pendingAction) return;
    cashoutSentForRound = round.roundId;
    pendingAction = "cashout";
    const clickedMultiplier = displayedMultiplier;
    els.action.disabled = true;
    els.action.textContent = \`CASHING OUT AT \${clickedMultiplier.toFixed(2)}x\`;
    say(\`Cash-out locked at click time near \${clickedMultiplier.toFixed(2)}x…\`, "win");
    try {
      const token = await ensureCrashSession();
      const result = await fetchJson("/api/crash/cashout", { method: "POST", headers: { "content-type": "application/json", authorization: \`Bearer \${token}\` }, body: JSON.stringify({ wallet, roundId: round.roundId }) });
      els.action.textContent = \`CASHED OUT AT \${Number(result.multiplier).toFixed(2)}x\`;
      say(\`\${auto ? "Auto cash-out" : "Cash-out"} locked at \${Number(result.multiplier).toFixed(2)}x. Settlement follows impact.\`, "win");
      await pollState(true);
    } catch (error) {
      say(\`Cash-out request failed after being locked: \${error.message}. This wager cannot be retried at a higher multiplier.\`, "loss");
      throw error;
    } finally { pendingAction = ""; }
  }
  async function withdraw`, "client instant cashout");
}
fs.writeFileSync(clientFile, client);

let html = fs.readFileSync(htmlFile, "utf8");
const commitVersion = String(process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || "local").slice(0, 12);
const assetVersion = `session-cashout-${bettingMs}-${commitVersion}`;
html = replaceRequired(html, /\/crash-mainnet\.js\?v=[^\"]+/, `/crash-mainnet.js?v=${assetVersion}`, "Crash mainnet asset URL");
fs.writeFileSync(htmlFile, html);

console.log(`MATT Crash betting window configured to ${(bettingMs / 1000).toFixed(0)} seconds.`);
console.log("MATT Crash stale uncommitted-round recovery enabled.");
console.log("MATT Crash authenticated instant cash-out sessions enabled.");
console.log("MATT Crash client configured to use the keeper's authoritative flightStartedAt timestamp.");
console.log(`MATT Crash asset version: ${assetVersion}`);
