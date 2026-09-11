const db = require('../db/database');
const zoho = require('../integrations/zoho');

/**
 * A live copy of Zoho's Salesperson list, keyed by Zoho's own id — and the
 * rename handling that copy makes possible.
 *
 * Sep 11, 2026. Everything else in this app holds a Salesperson by NAME
 * (user_salespersons, users.salesperson, orders.salesperson,
 * salesperson_mappings), because a name is what a Sales Order shows and what
 * Zoho's list is searched by. Zoho keys them by salesperson_id, and the name
 * under an id can change: "HOS | Aaron Manila" became "B2B | Aaron" today, and
 * every stored copy of the old name silently stopped resolving — the account
 * holding it could no longer place an order, and nothing said why.
 *
 * Keyed by id, this copy can tell a RENAME (same id, new name) from a REMOVAL
 * (id gone), and a rename is carried to every stored copy of the old name.
 * Every difference is recorded in zoho_salesperson_changes.
 *
 * Kept current by three callers, so it is never more than minutes behind:
 *   - zohoAutoSyncService.runOnce, every tick           -> refresh()
 *   - salespersonService.loadNames and the admin picker,
 *     whenever they read the list from Zoho anyway      -> syncFromList()
 *   - the Users page's "Refresh from Zoho" button, through the picker.
 *
 * Read-only towards Zoho, like every other Salesperson path here.
 */

const clean = (v) => (v == null ? '' : String(v).trim());

// Serialises syncs across processes — Render and Vercel can both run one at
// the same moment. The second waits, then reads what the first wrote, so a
// rename is propagated and logged once rather than twice. The number is
// arbitrary; it only has to be unique to this purpose.
const LOCK_SQL = 'SELECT pg_advisory_xact_lock(7240911)';

/**
 * Rewrite every stored copy of a Salesperson name after Zoho renamed it.
 *
 * Matching ignores case and surrounding spaces, and nothing else. Two
 * DIFFERENT Salespersons can differ by one character in this org ("HOS |
 * MARIKINA" and "HOS| MARIKINA" both exist), so anything looser could move one
 * rep's history onto another.
 */
const renameEverywhere = db.transaction(async (oldName, newName) => {
  const counts = { accounts: 0, legacy_accounts: 0, orders: 0, mappings: 0, total: 0 };
  if (!oldName || !newName || oldName === newName) return counts;

  // An account that already holds BOTH names keeps the new one once, and keeps
  // it primary if the old one was.
  const both = await db
    .prepare(
      `SELECT o.id AS old_id, o.is_primary AS old_primary, n.id AS new_id
         FROM user_salespersons o
         JOIN user_salespersons n ON n.user_id = o.user_id
        WHERE LOWER(TRIM(o.salesperson)) = LOWER(TRIM(?))
          AND LOWER(TRIM(n.salesperson)) = LOWER(TRIM(?))`
    )
    .all(oldName, newName);
  for (const b of both) {
    await db.prepare('DELETE FROM user_salespersons WHERE id = ?').run(b.old_id);
    if (b.old_primary) await db.prepare('UPDATE user_salespersons SET is_primary = 1 WHERE id = ?').run(b.new_id);
  }

  // users.salesperson follows through the table's trigger.
  counts.accounts =
    both.length +
    (await db
      .prepare('UPDATE user_salespersons SET salesperson = ? WHERE LOWER(TRIM(salesperson)) = LOWER(TRIM(?))')
      .run(newName, oldName)).changes;

  // An account whose single Salesperson lives only in users.salesperson.
  counts.legacy_accounts = (await db
    .prepare(
      `UPDATE users SET salesperson = ?
        WHERE LOWER(TRIM(salesperson)) = LOWER(TRIM(?))
          AND NOT EXISTS (SELECT 1 FROM user_salespersons s WHERE s.user_id = users.id)`
    )
    .run(newName, oldName)).changes;

  // Orders: the Sales Order in Zoho already shows the new name — it points at
  // the id — so the local copy follows. Deliberately NOT logged per order:
  // nobody edited those Sales Orders, and renaming a busy Salesperson would
  // otherwise write thousands of identical trail lines. The rename is logged
  // once, in zoho_salesperson_changes, with this count.
  counts.orders = (await db
    .prepare('UPDATE orders SET salesperson = ? WHERE LOWER(TRIM(salesperson)) = LOWER(TRIM(?))')
    .run(newName, oldName)).changes;

  // The imported-order review keys on the verbatim string on those orders, so
  // its decision moves with them — unless the new name already has a row of
  // its own, in which case that row's decision stands.
  counts.mappings = (await db
    .prepare(
      `UPDATE salesperson_mappings SET zoho_salesperson = ?
        WHERE zoho_salesperson = ?
          AND NOT EXISTS (SELECT 1 FROM salesperson_mappings m WHERE m.zoho_salesperson = ?)`
    )
    .run(newName, oldName, newName)).changes;

  counts.total = counts.accounts + counts.legacy_accounts + counts.orders + counts.mappings;
  return counts;
});

/**
 * Bring zoho_salespersons in line with a list Zoho just returned.
 *
 * `list` is Zoho's own shape: [{ salesperson_id, salesperson_name,
 * salesperson_email, is_active }]. Callers that already fetched it pass it in,
 * so this never costs an extra Zoho call.
 *
 * Returns what changed. The very first sync only SEEDS the table — it has no
 * earlier state to compare against, so it records no "added" entries for
 * the whole list.
 */
const syncFromList = db.transaction(async (list, { now = new Date().toISOString() } = {}) => {
  const incoming = new Map();
  for (const s of list || []) {
    const id = clean(s && s.salesperson_id);
    const name = clean(s && (s.salesperson_name || s.name));
    if (!id || !name) continue;
    incoming.set(id, {
      id,
      name,
      email: clean(s.salesperson_email) || null,
      is_active: s.is_active === false ? 0 : 1
    });
  }
  // An empty or id-less answer is a bad response, never "everybody left".
  if (!incoming.size) return { skipped: true };

  await db.prepare(LOCK_SQL).get();

  const existing = new Map(
    (await db.prepare('SELECT * FROM zoho_salespersons').all()).map((r) => [r.zoho_salesperson_id, r])
  );
  const firstRun = existing.size === 0;
  const summary = {
    first_run: firstRun, added: 0, renamed: 0, deactivated: 0, reactivated: 0, removed: 0, restored: 0, propagated: 0
  };
  const log = (id, change, oldValue, newValue, propagated = null) =>
    db
      .prepare(
        `INSERT INTO zoho_salesperson_changes (zoho_salesperson_id, change, old_value, new_value, propagated, detected_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, change, oldValue, newValue, propagated, now);

  const fresh = [];
  const seen = [];
  for (const s of incoming.values()) {
    const prev = existing.get(s.id);
    if (!prev) {
      fresh.push(s);
      continue;
    }
    seen.push(s.id);

    const wasActive = Number(prev.is_active) === 1;
    const differs =
      prev.name !== s.name || (prev.email || null) !== s.email || wasActive !== !!s.is_active || !!prev.removed_at;
    if (!differs) continue;

    if (prev.name !== s.name) {
      const moved = await renameEverywhere(prev.name, s.name);
      summary.renamed++;
      summary.propagated += moved.total;
      await log(s.id, 'renamed', prev.name, s.name, moved.total);
    }
    if (wasActive && !s.is_active) {
      summary.deactivated++;
      await log(s.id, 'deactivated', null, s.name);
    }
    if (!wasActive && s.is_active) {
      summary.reactivated++;
      await log(s.id, 'reactivated', null, s.name);
    }
    if (prev.removed_at) {
      summary.restored++;
      await log(s.id, 'restored', null, s.name);
    }
    await db
      .prepare('UPDATE zoho_salespersons SET name = ?, email = ?, is_active = ?, removed_at = NULL WHERE zoho_salesperson_id = ?')
      .run(s.name, s.email, s.is_active, s.id);
  }

  // One statement for "still there", not one per Salesperson — this runs on
  // every list read, and ~200 round trips to the database would be seconds.
  if (seen.length) {
    await db.prepare('UPDATE zoho_salespersons SET last_seen_at = ? WHERE zoho_salesperson_id = ANY(?)').run(now, seen);
  }

  for (let i = 0; i < fresh.length; i += 100) {
    const batch = fresh.slice(i, i + 100);
    const params = [];
    const tuples = batch.map((s) => {
      params.push(s.id, s.name, s.email, s.is_active, now, now);
      return '(?, ?, ?, ?, ?, ?)';
    });
    await db
      .prepare(
        `INSERT INTO zoho_salespersons (zoho_salesperson_id, name, email, is_active, first_seen_at, last_seen_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (zoho_salesperson_id) DO NOTHING`
      )
      .run(...params);
  }
  summary.added = fresh.length;
  if (!firstRun) for (const s of fresh) await log(s.id, 'added', null, s.name);

  // Gone from Zoho's list. Stored copies of the name are left as they are —
  // there is no successor to rename them to — and an account still holding
  // one will fail its next order loudly (SALESPERSON_NOT_FOUND), not silently.
  for (const prev of existing.values()) {
    if (incoming.has(prev.zoho_salesperson_id) || prev.removed_at) continue;
    await db.prepare('UPDATE zoho_salespersons SET removed_at = ? WHERE zoho_salesperson_id = ?').run(now, prev.zoho_salesperson_id);
    summary.removed++;
    await log(prev.zoho_salesperson_id, 'removed', prev.name, null);
  }

  return summary;
});

// One Zoho read at a time per process, however many callers ask at once.
let inFlight = null;

/** Read Zoho's list and sync it. */
function refresh() {
  if (!inFlight) {
    inFlight = (async () => {
      const res = await zoho.listSalespersons();
      return syncFromList(res.salespersons || []);
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** When the copy was last synced, how many Salespersons it holds, and what changed lately. */
async function status({ limit = 20 } = {}) {
  const row = await db
    .prepare('SELECT MAX(last_seen_at) AS synced_at, COUNT(*) FILTER (WHERE removed_at IS NULL) AS present FROM zoho_salespersons')
    .get();
  const changes = await db
    .prepare(
      `SELECT zoho_salesperson_id, change, old_value, new_value, propagated, detected_at
         FROM zoho_salesperson_changes
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(limit);
  return { synced_at: (row && row.synced_at) || null, count: Number((row && row.present) || 0), changes };
}

module.exports = { syncFromList, refresh, status, renameEverywhere };
