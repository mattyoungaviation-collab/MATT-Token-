"use strict";
function startIndexer(indexer, { intervalMs = 15000, batchSize = 1000, log = console.error } = {}) {
  let pending = null, stopped = false;
  const status = { ok: false, checkedAt: null, indexedBlock: null };
  async function tick() {
    if (stopped || pending) return;
    pending = (async () => {
      try { const result = await indexer.syncOnce(batchSize); Object.assign(status, { ok: true, checkedAt: Date.now(), indexedBlock: String(result.to) }); }
      catch { Object.assign(status, { ok: false, checkedAt: Date.now() }); log("Project DYNO indexer unavailable; private RPC/error details redacted."); }
    })();
    try { await pending; } finally { pending = null; }
  }
  const timer = setInterval(tick, intervalMs); timer.unref();
  tick();
  return { status, tick, async stop() { stopped = true; clearInterval(timer); if (pending) await pending; await indexer.close(); } };
}
module.exports = { startIndexer };
