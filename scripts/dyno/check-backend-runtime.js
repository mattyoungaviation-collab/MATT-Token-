"use strict";

// Local, isolated production-dependency smoke test. Never contacts Render or a
// live chain, uses live credentials, submits transactions, or edits release Git.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const http = require("node:http"), crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process"), { setTimeout: delay } = require("node:timers/promises");
const root = path.resolve(__dirname, "../..");

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dyno-backend-smoke-"));
  const candidate = path.join(temporary, "candidate"), disk = path.join(temporary, "test-disk");
  let child, rpc;
  const rpcMethods = [];
  try {
    fs.mkdirSync(candidate); fs.mkdirSync(disk);
    function copy(file) {
      const target = path.join(candidate, file);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target);
    }
    for (const file of ["package.json", "package-lock.json", "scripts/dyno/validate-manifest.js"]) copy(file);
    // Only committed website source paths plus explicitly scoped DYNO modules.
    // No .env, database, artifacts, private evidence, or unrelated scripts.
    const tracked = execFileSync("git", ["ls-files", "website"], { cwd: root }).toString().trim().split(/\r?\n/);
    for (const file of tracked) if (/\.(js|json|html|css)$/.test(file) && !file.endsWith(".test.js")) copy(file);
    function copyModules(relative) {
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const file = relative + "/" + entry.name;
        if (entry.isDirectory()) copyModules(file);
        else if (/\.(js|json|sql)$/.test(entry.name) && !entry.name.endsWith(".test.js")) copy(file);
      }
    }
    copyModules("services/dyno-api"); copyModules("services/dyno-indexer"); copyModules("packages/abis");
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
    env.NODE_ENV = "production"; env.npm_config_logs_dir = path.join(temporary, "npm-logs");
    const npmArgs = ["ci", "--omit=dev", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"];
    execFileSync(process.platform === "win32" ? env.ComSpec || "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs, { cwd: candidate, env, stdio: "inherit", timeout: 120000 });
    assert.equal(fs.existsSync(path.join(candidate, "node_modules/hardhat")), false);
    assert.equal(fs.existsSync(path.join(candidate, "config/project-dyno.local.json")), false, "Production-disabled startup must not require a mock manifest");
    assert.equal(fs.existsSync(path.join(candidate, "artifacts")), false);
    rpc = http.createServer((req, res) => {
      let body = ""; req.on("data", data => { body += data; });
      req.on("end", () => {
        const calls = JSON.parse(body), batch = Array.isArray(calls);
        const result = (batch ? calls : [calls]).map(call => {
          rpcMethods.push(call.method);
          return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "Isolated smoke fixture has no chain data" } };
        });
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(batch ? result : result[0]));
      });
    });
    await new Promise(resolve => rpc.listen(0, "127.0.0.1", resolve));
    let ports;
    for (let base = 32300; base < 32400 && !ports; base += 3) {
      const reservations = [];
      try {
        for (const port of [base, base + 1, base + 2]) {
          const server = http.createServer(); reservations.push(server);
          await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
        }
        ports = [base, base + 1, base + 2];
      } catch {} finally { for (const server of reservations) if (server.listening) await new Promise(resolve => server.close(resolve)); }
    }
    assert.ok(ports, "No available localhost fixture ports");
    const serverEnv = { ...env, PORT: String(ports[0]), INTERNAL_PROXY_PORT: String(ports[1]),
      RONIN_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, MATT_DEPLOYMENT_BLOCK: "1", RPC_MAX_RETRIES: "0", COIN_RPC_MAX_RETRIES: "0",
      DYNO_STORAGE: "sqlite", RENDER_DISK_PATH: disk, DYNO_DATABASE_FILE: path.join(disk, "project-dyno", "dyno.sqlite"),
      DYNO_STORAGE_KEY: crypto.randomBytes(32).toString("base64"), DYNO_IDENTITY_SECRET: crypto.randomBytes(32).toString("base64"),
      DYNO_INDEXER_ENABLED: "false", DYNO_LIVE_ENABLED: "false",
      DISCORD_CLIENT_ID: "1559100671309905922", DISCORD_GUILD_ID: "1493734022281429257", DISCORD_CLIENT_SECRET: "local-fixture-only", DISCORD_REDIRECT_URI: "https://matttoken.com/api/discord/callback" };
    let logs = "";
    child = spawn(process.execPath, ["website/server-combined.js"], { cwd: candidate, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    for (const output of [child.stdout, child.stderr]) output.on("data", chunk => { logs = (logs + chunk).slice(-16000); });
    const origin = `http://127.0.0.1:${ports[0]}`;
    let healthy = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error("Isolated backend exited before readiness; inspect only local fixture diagnostics");
      try { const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(500) }); healthy = response.ok && (await response.json()).ok === true; } catch {}
      if (healthy) break; await delay(100);
    }
    assert.ok(healthy, "Combined website process tree did not start");
    for (const route of ["/api/x/config", "/vendor/ethers.umd.min.js", "/slots", "/api/discord/config"]) assert.equal((await fetch(origin + route)).status, 200, route);
    const readiness = await (await fetch(origin + "/api/dyno/health")).json();
    assert.equal(readiness.ok, true); assert.equal(readiness.database, "sqlite"); assert.equal(readiness.authentication, "sqlite-encrypted"); assert.equal(readiness.purchasesEnabled, false);
    const config = await (await fetch(origin + "/api/dyno/config")).json();
    assert.equal(config.raffleProxy, null); assert.equal(config.enabled, false); assert.equal(config.mock, false);
    const page = await (await fetch(origin + "/dyno")).text(); assert.match(page, /Not launched/); assert.ok(!/<(button|form|script)\b/.test(page));
    for (const route of ["/voucher", "/auth/nonce", "/admin/prepare"]) assert.equal((await fetch(origin + "/api/dyno" + route, { method: "POST" })).status, 503, route);
    assert.equal((await fetch(origin + "/api/dyno/indexer-health")).status, 503);
    assert.ok(fs.existsSync(serverEnv.DYNO_DATABASE_FILE));
    assert.ok(!logs.includes(serverEnv.DYNO_STORAGE_KEY) && !logs.includes(serverEnv.DYNO_IDENTITY_SECRET));
    assert.ok(!rpcMethods.some(method => /^eth_send/.test(method)), "Smoke test must never submit a transaction");
    console.log("PASS: isolated npm ci --omit=dev, combined website startup, encrypted disk health, existing website routes, no mock-manifest fallback, and blocked DYNO purchases/admin/indexer.");
    console.log("Local fixture only. Nothing pushed, deployed, or enabled on Render; no live OAuth or chain integration tested.");
  } finally {
    if (child?.pid && child.exitCode === null) {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    }
    if (rpc) { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); }
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("dyno-backend-smoke-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(() => { console.error("DYNO local backend smoke check failed; no release action was performed."); process.exitCode = 1; });
module.exports = { main };
