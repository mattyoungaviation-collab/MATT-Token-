"use strict";

const fs = require("node:fs"), path = require("node:path"), express = require("express");
const { validateManifest } = require("../../scripts/dyno/validate-manifest");

// A storage-only production release must not silently select local demo contracts.
function selectDynoRuntime(env = process.env) {
  for (const key of ["DYNO_LIVE_ENABLED", "DYNO_INDEXER_ENABLED"]) {
    if (env[key] && !["true", "false"].includes(env[key])) throw new Error(`${key} must be true or false`);
  }
  const production = env.NODE_ENV === "production";
  const enabled = !production || env.DYNO_LIVE_ENABLED === "true";
  if (!enabled) {
    if (env.DYNO_INDEXER_ENABLED === "true") throw new Error("DYNO indexer cannot run while live DYNO is disabled");
    return { enabled: false, production: true, manifest: null };
  }
  if (production && !env.DYNO_MANIFEST) throw new Error("Live Project DYNO requires an explicit production manifest");
  const filename = env.DYNO_MANIFEST || path.join(__dirname, "../../config/project-dyno.local.json");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { throw new Error("Project DYNO manifest could not be loaded"); }
  if (production && (manifest.environment !== "production" || manifest.mock !== false)) throw new Error("Live production cannot use local/test manifests or mock integrations");
  if (validateManifest(manifest, { production }).length) throw new Error("Project DYNO manifest validation failed");
  if (production) {
    for (const key of [manifest.rpcUrlEnv, manifest.nftRpcUrlEnv, "DYNO_IDENTITY_SECRET", "DYNO_IDENTITY_SIGNER_PRIVATE_KEY"]) {
      if (!key || !env[key]) throw new Error("Live Project DYNO required private configuration is missing");
    }
  }
  return { enabled: true, production, manifest };
}

function createDisabledDynoRouter(store) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/health", async (_req, res) => {
    let healthy = false;
    try { healthy = await store.health(); } catch {}
    res.status(healthy ? 200 : 503).json({ ok: healthy, database: store.kind, authentication: store.auth?.kind || "unavailable", environment: "production", mock: false, enabled: false, purchasesEnabled: false });
  });
  router.get("/config", (_req, res) => res.json({ environment: "production", mock: false, enabled: false, purchasesEnabled: false, status: "NOT_LAUNCHED", raffleProxy: null, buybackProxy: null }));
  router.use((_req, res) => res.status(503).json({ error: "DYNO_NOT_LAUNCHED", purchasesEnabled: false }));
  return router;
}

const disabledDynoPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project DYNO — Not launched</title></head><body><main><h1>Project DYNO</h1><p>Not launched. Ticket purchases are disabled while contract integrations and release checks are completed.</p><p>No ticket payments are accepted on this page.</p><a href="/">Back to MATT</a></main></body></html>`;

module.exports = { selectDynoRuntime, createDisabledDynoRouter, disabledDynoPage };
