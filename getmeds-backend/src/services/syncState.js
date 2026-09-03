const db = require('../db/database');

/**
 * Tiny key/value helper over the `sync_state` table (see schema.sql) — used
 * to remember, per synced entity (customers/inventory), the watermark for
 * "Quick Sync" (the newest `last_modified_time` seen so far) and a rough
 * expected total from the last "Full Resync" (used only to estimate a
 * progress percentage; never treated as authoritative).
 *
 * Purely local bookkeeping — nothing here ever reads from or writes to
 * Zoho.
 */

async function getSyncState(key) {
  const row = await db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

async function setSyncState(key, value) {
  const v = value === null || value === undefined ? null : String(value);
  await db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, v);
}

module.exports = { getSyncState, setSyncState };
