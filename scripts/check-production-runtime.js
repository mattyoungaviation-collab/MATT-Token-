"use strict";

// Test a dependency-only release based on HEAD, never the unfinished working tree.
// No hosting changes, credentials, signing, Git commits or transaction submission.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const root = path.resolve(__dirname, "..");
const runtime = { ethers: "6.17.0", "@ethersproject/wallet": "5.8.0" };
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });

function npm(args, cwd, env) {
  // npm.cmd needs cmd.exe on Windows; all arguments here are fixed, not user input.
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  execFileSync(command, commandArgs, { cwd, env, stdio: "inherit", timeout: 120_000 });
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "matt-runtime-check-"));
  const before = path.join(work, "before");
  const after = path.join(work, "after");
  let child, rpc;
  try {
    fs.mkdirSync(before); fs.mkdirSync(after);
    for (const name of ["package.json", "package-lock.json"]) {
      const bytes = git("show", `HEAD:${name}`);
      fs.writeFileSync(path.join(before, name), bytes);
      fs.writeFileSync(path.join(after, name), bytes);
    }
    let packageText = fs.readFileSync(path.join(after, "package.json"), "utf8");
    const pkg = JSON.parse(packageText);
    for (const [name, version] of Object.entries(runtime)) {
      if (pkg.dependencies[name] === version) continue;
      assert.equal(pkg.dependencies[name], undefined, "Review existing versions before preparing a hotfix");
      packageText = packageText.replace(/("dependencies"\s*:\s*\{)([\s\S]*?)(\r?\n[ \t]*\})/, (_match, opening, body, closing) => {
        const newline = body.includes("\r\n") ? "\r\n" : "\n";
        const indent = body.match(/\r?\n([ \t]*)"/)[1];
        const separator = body.match(/"[^"\r\n]+"(:[ \t]*)/)[1];
        return `${opening}${body},${newline}${indent}${JSON.stringify(name)}${separator}${JSON.stringify(version)}${closing}`;
      });
      pkg.dependencies[name] = version;
    }
    assert.deepEqual(JSON.parse(packageText), pkg);
    fs.writeFileSync(path.join(after, "package.json"), packageText);
    // Copy only committed website sources/public files, never .env or local state.
    for (const file of git("ls-tree", "-r", "--name-only", "HEAD", "website").toString().trim().split("\n")) {
      if (!/\.(js|json|html|css)$/.test(file) || file.endsWith(".test.js")) continue;
      const target = path.join(after, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, git("show", `HEAD:${file}`));
    }
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.NODE_ENV = "production";
    env.npm_config_logs_dir = path.join(work, "npm-logs");
    npm(["install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], after, env);
    // npm follows package.json's indentation; preserve the deployed lockfile's
    // own formatting so the release patch is small and directly applicable.
    const originalLock = fs.readFileSync(path.join(before, "package-lock.json"), "utf8");
    const lockIndent = originalLock.match(/\r?\n([ \t]+)"/)[1];
    const lockNewline = originalLock.includes("\r\n") ? "\r\n" : "\n";
    const updatedLock = JSON.parse(fs.readFileSync(path.join(after, "package-lock.json"), "utf8"));
    fs.writeFileSync(path.join(after, "package-lock.json"), `${JSON.stringify(updatedLock, null, lockIndent)}\n`.replace(/\n/g, lockNewline));
    npm(["ci", "--omit=dev", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], after, env);
    const lock = JSON.parse(fs.readFileSync(path.join(after, "package-lock.json"), "utf8"));
    for (const [name, version] of Object.entries(runtime)) {
      assert.equal(lock.packages[`node_modules/${name}`].version, version);
      assert.notEqual(lock.packages[`node_modules/${name}`].dev, true);
    }
    assert.equal(fs.existsSync(path.join(after, "node_modules/hardhat")), false);
    // Isolated fixture is outside the repo, so developer node_modules cannot help.
    execFileSync(process.execPath, ["-e", "require('ethers'); require('@ethersproject/wallet'); require('./website/x-follow-verifier-v2'); require('./website/lib/blackjack-auth');"], { cwd: after, env, stdio: "inherit" });
    rpc = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Local smoke fixture: no chain connection" } })); });
    await new Promise(resolve => rpc.listen(0, "127.0.0.1", resolve));
    // Reserve three adjacent localhost ports before starting the server tree.
    let ports;
    for (let base = 32180; base < 32280 && !ports; base += 3) {
      const reservations = [];
      try {
        for (const port of [base, base + 1, base + 2]) {
          const server = http.createServer(); reservations.push(server);
          await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
        }
        ports = [base, base + 1, base + 2];
      } catch {} finally { for (const server of reservations) if (server.listening) await new Promise(resolve => server.close(resolve)); }
    }
    assert.ok(ports, "No free adjacent local smoke ports");
    const serverEnv = { ...env, PORT: String(ports[0]), INTERNAL_PROXY_PORT: String(ports[1]), RONIN_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, MATT_DEPLOYMENT_BLOCK: "1", RPC_MAX_RETRIES: "0", COIN_RPC_MAX_RETRIES: "0" };
    let logs = "";
    child = spawn(process.execPath, ["website/server-combined.js"], { cwd: after, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    for (const output of [child.stdout, child.stderr]) output.on("data", chunk => { logs = (logs + chunk).slice(-16_000); });
    const baseUrl = `http://127.0.0.1:${ports[0]}`;
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Isolated server exited: ${logs}`);
      try { const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) }); healthy = response.ok && (await response.json()).ok === true; } catch {}
      if (healthy) break;
      await delay(100);
    }
    assert.ok(healthy, "Production-only server tree did not become healthy");
    for (const route of ["/api/x/config", "/vendor/ethers.umd.min.js", "/slots"]) {
      const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, 200, route);
      assert.ok((await response.text()).length > 0, route);
    }
    // Export a narrowly scoped patch: package files only, no DYNO or other WIP.
    let patch = "";
    for (const name of ["package.json", "package-lock.json"]) {
      let diff;
      try { diff = execFileSync("git", ["diff", "--no-index", "--", `before/${name}`, `after/${name}`], { cwd: work }).toString(); }
      catch (error) { if (error.status !== 1) throw error; diff = error.stdout.toString(); }
      patch += diff.replaceAll("a/before/", "a/").replaceAll("b/after/", "b/");
    }
    const exportDir = path.join(root, "deployment-exports"); fs.mkdirSync(exportDir, { recursive: true });
    const patchFile = path.join(exportDir, "runtime-dependencies.patch"); fs.writeFileSync(patchFile, patch);
    // A dedicated fixture repo prevents parent repository prefixes from silently
    // excluding patch paths when the user's temp directory is inside a checkout.
    execFileSync("git", ["init", "--quiet"], { cwd: before, env, stdio: "inherit" });
    execFileSync("git", ["apply", "--check", patchFile], { cwd: before, env, stdio: "inherit" });
    execFileSync("git", ["apply", patchFile], { cwd: before, env, stdio: "inherit" });
    for (const name of ["package.json", "package-lock.json"]) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(before, name), "utf8")), JSON.parse(fs.readFileSync(path.join(after, name), "utf8")), `Hotfix patch must reproduce the tested ${name}`);
    }
    console.log("PASS: clean npm ci --omit=dev, runtime imports, three-process startup, /health, /api/x/config, browser ethers bundle and /slots.");
    console.log(`Dependency-only patch prepared: ${patchFile}. Nothing pushed or deployed.`);
  } finally {
    if (child?.pid && child.exitCode === null) {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      else process.kill(-child.pid, "SIGTERM");
    }
    if (rpc) { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); }
    // Delete only this exact newly created fixture inside the system temp directory.
    const resolved = path.resolve(work);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("matt-runtime-check-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
