"use strict";
const fs = require("fs"), path = require("path");
const { assertStorageUpgradeSafe } = require("@openzeppelin/upgrades-core");
const original = require("../../deployment-exports/dyno-storage-before-emergency.json");
const validation = JSON.parse(fs.readFileSync("cache/validations.json"));
const shape = layout => JSON.stringify(layout.storage.map(s => [s.label, s.slot, s.offset, s.type]));
for (const name of Object.keys(original)) {
  const file = path.resolve(`artifacts/contracts/dyno/${name}.sol/${name}.dbg.json`);
  const debug = JSON.parse(fs.readFileSync(file));
  const build = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), debug.buildInfo)));
  const source = `contracts/dyno/${name}.sol`;
  // Hardhat may remove superseded build-info; OZ validation history retains the
  // original AST-enriched layout. Match EVERY original field/type/slot first.
  const cached = validation.log.map(run => run[`${source}:${name}`]?.layout).find(layout => layout && shape(layout) === shape(original[name]));
  const enriched = !!original[name].namespaces && Object.entries(original[name].types).every(([type, entry]) => !type.startsWith("t_enum") || Array.isArray(entry.members));
  const prior = enriched ? original[name] : cached || original[name];
  if (Object.entries(prior.types).some(([type, entry]) => type.startsWith("t_enum") && !entry.members)) throw new Error("Original enum metadata missing; no unsafe custom-type bypass is allowed");
  const updated = validation.log.map(run => run[`${source}:${name}`]?.layout).find(layout => layout && shape(layout) === shape(build.output.contracts[source][name].storageLayout));
  if (!updated) throw new Error("Current AST/namespace-enriched validation layout missing");
  assertStorageUpgradeSafe(prior, updated, false);
  original[name] = prior;
  console.log(`${name}: pre-emergency layout remains compatible`);
}
// Generated baseline now preserves original enum metadata for reproducible future checks.
fs.writeFileSync("deployment-exports/dyno-storage-before-emergency.json", JSON.stringify(original, null, 2) + "\n");
