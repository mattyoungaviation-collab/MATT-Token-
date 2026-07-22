const fs = require("fs");
const path = require("path");
const Module = module.constructor;

const filename = path.join(__dirname, "flappy-matt-routes.js");
let source = fs.readFileSync(filename, "utf8");

const durationBefore = "const RUN_MAX_MS = 120_000;";
const durationAfter = "const RUN_MAX_MS = 900_000;";
if (!source.includes(durationBefore)) throw new Error("Flappy MATT route duration patch target was not found.");
source = source.replace(durationBefore, durationAfter);

const existingBefore = `      const existing = Object.values(state.activeRuns).find(run => run.wallet === wallet && run.expiresAt > Date.now());
      if (existing) throw new Error("Finish your current Flappy MATT run before starting another.");`;
const existingAfter = `      const existing = Object.values(state.activeRuns).find(run => run.wallet === wallet && run.expiresAt > Date.now());
      if (existing) {
        const requestedTxHash = String(req.body.txHash || "").trim().toLowerCase();
        if (requestedTxHash && existing.txHash === requestedTxHash) {
          return res.json({
            runId: existing.id,
            seed: existing.seed,
            createdAt: existing.createdAt,
            expiresAt: existing.expiresAt,
            roundId: existing.roundId,
            eligible: existing.eligible,
            potRaw: state.round.potRaw,
            recovered: true
          });
        }
        throw new Error("Finish your current Flappy MATT run before starting another.");
      }`;
if (!source.includes(existingBefore)) throw new Error("Flappy MATT idempotency patch target was not found.");
source = source.replace(existingBefore, existingAfter);

const compiled = new Module(filename, module.parent);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(source, filename);
module.exports = compiled.exports;
