"use strict";
function startIndexer(indexer, { intervalMs = 15000, catchUpIntervalMs = intervalMs, batchSize = 1000, log = console.error } = {}) {
  if (![intervalMs, catchUpIntervalMs].every(value => Number.isSafeInteger(value) && value >= 1000)) throw new Error("Indexer intervals must be integers of at least 1000ms");
  let pending = null, stopped = false, timer = null;
  const status = { ok: false, checkedAt: null, indexedBlock: null };
  async function tick() {
    if (stopped || pending) return;
    if (timer) { clearTimeout(timer); timer = null; }
    let nextDelay = intervalMs;
    pending = (async () => {
      try {
        const result = await indexer.syncOnce(batchSize);
        const behind = Number.isSafeInteger(result.head) && result.to < result.head;
        Object.assign(status, { ok: true, checkedAt: Date.now(), indexedBlock: String(result.to),
          headBlock: Number.isSafeInteger(result.head) ? String(result.head) : null,
          lagBlocks: behind ? result.head - result.to : 0 });
        // Catch-up is deliberately paced. An aggressive one-second replay loop
        // can consume the shared RPC quota and make checkout reads fail closed.
        if (behind) nextDelay = catchUpIntervalMs;
      }
      catch { Object.assign(status, { ok: false, checkedAt: Date.now() }); log("Project DYNO indexer unavailable; private RPC/error details redacted."); }
    })();
    try { await pending; }
    finally {
      pending = null;
      if (!stopped) { timer = setTimeout(tick, nextDelay); timer.unref(); }
    }
  }
  tick();
  return { status, tick, async stop() { stopped = true; if (timer) clearTimeout(timer); if (pending) await pending; await indexer.close(); } };
}
module.exports = { startIndexer };
