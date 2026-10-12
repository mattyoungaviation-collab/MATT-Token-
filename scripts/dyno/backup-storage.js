"use strict";
const path = require("node:path");
const { createStore } = require("../../services/dyno-api/store");
async function main() {
  if (process.env.DYNO_STORAGE !== "sqlite") throw new Error("This backup command requires sqlite storage");
  const store = createStore();
  try {
    const name = `dyno-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.sqlite`;
    const destination = path.join(path.dirname(store.filename), "backups", name);
    const result = await store.backup(destination);
    console.log(JSON.stringify({ ...result, backup: destination, privateData: true, keyBackupRequired: true }));
  } finally { await store.close(); }
}
if (require.main === module) main().catch(() => { console.error("Project DYNO backup failed; private error details redacted. Check storage settings, disk space and permissions."); process.exitCode = 1; });
module.exports = { main };
