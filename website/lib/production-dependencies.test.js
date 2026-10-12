"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isBuiltin } = require("node:module");
const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

test("HTTP security patches are locked; mapped IPv6 trust subnets cannot trust unrelated IPv4 clients", () => {
  assert.equal(lock.packages["node_modules/proxy-addr"].version, "2.0.8");
  assert.equal(lock.packages["node_modules/qs"].version, "6.16.0");
  const proxyaddr = require("proxy-addr");
  assert.equal(proxyaddr.compile("::ffff:10.0.0.0/8")("203.0.113.4", 0), false);
  assert.equal(proxyaddr.compile("10.0.0.0/8")("10.1.2.3", 0), true);
  assert.equal(proxyaddr.compile("10.0.0.0/8")("203.0.113.4", 0), false);
});

test("startup wallet libraries are direct production dependencies at existing versions", () => {
  for (const [name, version] of Object.entries({ ethers: "6.17.0", "@ethersproject/wallet": "5.8.0" })) {
    assert.equal(manifest.dependencies[name], version);
    assert.equal(lock.packages[""].dependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.notEqual(lock.packages[`node_modules/${name}`].dev, true);
  }
});

test("server and service package imports do not rely on dev-only transitive dependencies", () => {
  const imports = new Set();
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["public", "node_modules"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (file.endsWith(".js") && !file.endsWith(".test.js")) {
        for (const match of fs.readFileSync(file, "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
          const name = match[1];
          if (name.startsWith(".") || path.isAbsolute(name) || isBuiltin(name)) continue;
          imports.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);
        }
      }
    }
  }
  scan(path.join(root, "website")); scan(path.join(root, "services"));
  assert.ok(imports.has("ethers")); assert.ok(imports.has("@ethersproject/wallet"));
  for (const name of imports) {
    assert.ok(manifest.dependencies[name], `${name} must be declared for production`);
    assert.notEqual(lock.packages[`node_modules/${name}`]?.dev, true, `${name} must survive npm ci --omit=dev`);
  }
});
