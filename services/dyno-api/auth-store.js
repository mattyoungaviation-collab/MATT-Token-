"use strict";

function createMemoryAuthStore() {
  const rows = new Map();
  const key = (scope, id) => `${scope}:${id}`;
  return {
    kind: "memory-demo",
    put(scope, id, value, expiresAt) { rows.set(key(scope, id), { value: structuredClone(value), expiresAt }); },
    get(scope, id, now = Date.now()) {
      const row = rows.get(key(scope, id));
      if (!row || row.expiresAt <= now) { rows.delete(key(scope, id)); return null; }
      return structuredClone(row.value);
    },
    take(scope, id, now = Date.now()) { const value = this.get(scope, id, now); this.delete(scope, id); return value; },
    delete(scope, id) { rows.delete(key(scope, id)); },
    prune(now = Date.now()) { for (const [id, row] of rows) if (row.expiresAt <= now) rows.delete(id); },
    observeIdentity() {},
  };
}
module.exports = { createMemoryAuthStore };
