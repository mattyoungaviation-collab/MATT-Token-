const fs = require("fs");
const path = require("path");
const roots = ["metadata", "website/public", "README.md"];
let found = false;
function walk(p) {
  const s = fs.statSync(p);
  if (s.isDirectory()) return fs.readdirSync(p).forEach((f) => walk(path.join(p, f)));
  const text = fs.readFileSync(p, "utf8");
  if (text.includes("DEPLOYED_CONTRACT_ADDRESS")) { console.log(`Placeholder remains: ${p}`); found = true; }
}
roots.forEach((p) => walk(p));
process.exitCode = found ? 1 : 0;
