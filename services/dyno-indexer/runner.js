"use strict";
function startIndexer(indexer, { intervalMs = 15000, batchSize = 1000, log = console.error } = {}) {
  let pending = null, stopped = false, timer = null;
  const status = { ok: false, checkedAt: null, indexedBlock: null };
  async function tick() {
    if (stopped || pending) return;
    if (timer) { clearTimeout(timer); timer = null; }
    let nextDelay = intervalMs;
    pending = (async () => {
      try {
        const result = await indexer.syncOnce(batchSize);
        Object.assign(status, { ok: true, checkedAt: Date.now(), indexedBlock: String(result.to) });
        // Replay historical blocks promptly; return to ordinary pacing at the
        // finalized head. A failure always waits for the normal interval.
        if (Number.isSafeInteger(result.head) && result.to < result.head) nextDelay = 1000;
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
