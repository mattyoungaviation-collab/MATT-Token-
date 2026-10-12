"use strict";
const { storageLocation, encryptionKey } = require("../../services/dyno-api/sqlite-store");
function check(env = process.env, { production = env.NODE_ENV === "production" } = {}) {
  const errors = [];
  if (env.DYNO_STORAGE !== "sqlite") errors.push("DYNO_STORAGE must be sqlite for the selected disk-backed deployment");
  try { storageLocation(env, production); } catch (error) { errors.push(error.message); }
  try { encryptionKey(env.DYNO_STORAGE_KEY); } catch (error) { errors.push(error.message); }
  if (!env.DYNO_IDENTITY_SECRET || Buffer.byteLength(env.DYNO_IDENTITY_SECRET) < 32) errors.push("DYNO_IDENTITY_SECRET must contain at least 32 bytes and remain stable");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 18) errors.push("The disk-backed build requires the tested Node 22.18+ runtime (22.x)");
  return errors;
}
if (require.main === module) {
  const errors = check();
  if (errors.length) { errors.forEach(message => console.error(message)); process.exitCode = 1; }
  else console.log("Disk-backed DYNO configuration is valid. Secret values were not printed; no database or live setting was changed.");
}
module.exports = { check };
