"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DYNO_APPLICATION_ID = 1146703439;

function inspectDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
  try {
    if (db.prepare("PRAGMA application_id").get().application_id !== DYNO_APPLICATION_ID ||
        db.prepare("PRAGMA user_version").get().user_version !== 1 ||
        db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
      throw new Error("Source is not an intact, supported Project DYNO database");
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ["auth_records", "dyno_meta", "identity_observations", "chain_checkpoints", "chain_events"]) {
      if (!tables.has(name)) throw new Error("Source is missing a required Project DYNO table");
    }
    return { authRecords: db.prepare("SELECT count(*) AS n FROM auth_records").get().n };
  } finally { db.close(); }
}

function prepareRestoredStorage(source, destination, { apply = false } = {}) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error("Source and destination must be absolute paths");
  const from = path.resolve(source), to = path.resolve(destination);
  if (from === to || [to, to + "-wal", to + "-shm"].some(fs.existsSync)) throw new Error("Destination must be a new, distinct file");
  if (!fs.existsSync(from) || !fs.lstatSync(from).isFile() || fs.lstatSync(from).isSymbolicLink()) throw new Error("Source must be an existing regular backup file");
  if (!fs.existsSync(path.dirname(to)) || !fs.statSync(path.dirname(to)).isDirectory()) throw new Error("Destination parent directory must exist");
  const report = inspectDatabase(from);
  if (!apply) return { dryRun: true, source: from, destination: to, authRecordsToInvalidate: report.authRecords };

  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(to, 0o600);
    const db = new DatabaseSync(to, { allowExtension: false, timeout: 5000 });
    try {
      // The copy, not the original backup, is modified. Never erase the chain index or identity history.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM auth_records");
        db.prepare("INSERT INTO dyno_meta(key,value) VALUES('restore-auth-invalidated-at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || db.prepare("SELECT count(*) AS n FROM auth_records").get().n !== 0) {
        throw new Error("Prepared copy failed integrity or authentication invalidation check");
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("PRAGMA journal_mode=DELETE");
    } finally { db.close(); }
  } catch (error) {
    // Only a newly created staged copy is removed; the source and existing destination are never deleted.
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(to + suffix); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw new Error("Restore preparation failed and staged-copy cleanup requires operator review"); }
    }
    throw error;
  }
  return { dryRun: false, prepared: true, source: from, destination: to, authRecordsInvalidated: report.authRecords };
}

function parseArgs(args) {
  const values = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") values.apply = true;
    else if ((arg === "--source" || arg === "--destination") && args[i + 1]) values[arg.slice(2)] = args[++i];
    else throw new Error("Usage: node scripts/dyno/prepare-restored-storage.js --source <absolute backup> --destination <new absolute file> [--apply]");
  }
  if (!values.source || !values.destination) throw new Error("Both --source and --destination are required");
  return values;
}

if (require.main === module) {
  try {
    const { source, destination, apply } = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(prepareRestoredStorage(source, destination, { apply })));
  } catch (error) {
    console.error("Project DYNO restore preparation refused: " + error.message);
    process.exitCode = 1;
  }
}

module.exports = { inspectDatabase, prepareRestoredStorage, parseArgs };
