#!/usr/bin/env node
/**
 * Reclaim what db-report.js found, safely.
 *
 * Sep 12, 2026. Three jobs, in increasing order of how much thought they need:
 *
 *   VACUUM      returns dead rows to the table for reuse. Routine, online, and
 *               the one to run on a schedule.
 *   ANALYZE     refreshes the planner's statistics. Free, and worth doing
 *               after a bulk import or a large delete.
 *   DROP INDEX  reclaims real space, and is the only step that changes how the
 *               database behaves. Never automatic.
 *
 * DRY RUN BY DEFAULT. Nothing is changed without --apply, because this runs
 * against the production database and a reclaim job that surprises someone is
 * worse than a full disk.
 *
 *   node scripts/db-reclaim.js                  show what would happen
 *   node scripts/db-reclaim.js --apply          vacuum + analyze
 *   node scripts/db-reclaim.js --apply --indexes  also drop the named indexes
 *
 * VACUUM FULL is deliberately NOT offered. It rewrites the table and holds an
 * ACCESS EXCLUSIVE lock for the duration -- on a 98 MB orders table that is a
 * hard outage of the ordering system, to reclaim space plain VACUUM makes
 * reusable anyway.
 */

require('dotenv').config();
const db = require('../src/db/pg');

const APPLY = process.argv.includes('--apply');
const DROP_INDEXES = process.argv.includes('--indexes');

/**
 * Indexes this script is allowed to drop, named explicitly rather than taken
 * from whatever currently has idx_scan = 0.
 *
 * The scan counters reset when the server restarts, so a query that reads
 * "unused" today may simply not have run since. An allowlist means a human
 * decided once, with the reasoning written down, instead of the script
 * deciding again every run against a window it cannot see.
 *
 * Every one of these is recreatable from schema.pg.sql if it turns out to be
 * needed -- that is why dropping them is a reasonable first move and deleting
 * data is not.
 */
const DROPPABLE = [
  {
    name: 'idx_customers_contact_person_trgm',
    why: 'Trigram search over customers.contact_person. Nothing searches that field -- the customer picker searches name, which has its own trigram index that IS used.',
  },
  {
    name: 'idx_products_name_trgm',
    why: 'Trigram search over products.name. The product picker is served by idx_products_active_name, which carries the real traffic.',
  },
  {
    name: 'idx_customers_lto',
    why: 'Lookup by LTO licence number. Nothing queries by it; the LTO number is displayed and validated, never searched.',
  },
];

const mb = (b) => (Number(b) / 1048576).toFixed(2);

async function main() {
  const before = await db.prepare('SELECT pg_database_size(current_database()) AS b').get();

  console.log('');
  console.log(APPLY ? '  DB RECLAIM — APPLYING' : '  DB RECLAIM — DRY RUN (nothing will change)');
  console.log('  ' + '='.repeat(62));
  console.log(`  Database is ${mb(before.b)} MB before.`);
  console.log('');

  // ── 1. dead rows ────────────────────────────────────────────────────────
  const dead = await db
    .prepare(
      `SELECT relname AS tbl, n_dead_tup AS dead
         FROM pg_stat_user_tables
        WHERE n_dead_tup > 500
        ORDER BY n_dead_tup DESC`
    )
    .all();

  console.log('  VACUUM / ANALYZE');
  console.log('  ' + '-'.repeat(62));
  if (!dead.length) {
    console.log('  No table has enough dead rows to be worth it. Autovacuum is keeping up.');
  }
  for (const t of dead) {
    console.log(`  ${String(t.tbl).padEnd(24)} ${String(t.dead).padStart(8)} dead rows`);
    if (APPLY) {
      // Per table rather than database-wide: one long statement that fails
      // halfway leaves no record of what it did get through.
      await db.prepare(`VACUUM (ANALYZE) ${t.tbl}`).run();
      console.log(`  ${' '.repeat(24)} vacuumed`);
    }
  }
  console.log('');

  // ── 2. unused indexes ───────────────────────────────────────────────────
  console.log('  UNUSED INDEXES');
  console.log('  ' + '-'.repeat(62));

  let reclaimable = 0;
  for (const item of DROPPABLE) {
    const row = await db
      .prepare(
        `SELECT s.idx_scan AS scans, pg_relation_size(s.indexrelid) AS bytes
           FROM pg_stat_user_indexes s
          WHERE s.schemaname = 'public' AND s.indexrelname = ?`
      )
      .get(item.name);

    if (!row) {
      console.log(`  ${item.name}  — already gone`);
      continue;
    }

    reclaimable += Number(row.bytes);
    console.log(`  ${item.name}`);
    console.log(`      ${mb(row.bytes)} MB · ${row.scans} scans since stats reset`);
    console.log(`      ${item.why}`);

    // Refuses on evidence, not on a flag: if the index has been read since
    // somebody added it to this list, that decision is out of date.
    if (row.scans > 0) {
      console.log('      >> SKIPPED: this index HAS been used. Remove it from DROPPABLE.');
      console.log('');
      continue;
    }

    if (APPLY && DROP_INDEXES) {
      await db.prepare(`DROP INDEX IF EXISTS ${item.name}`).run();
      console.log('      dropped');
    }
    console.log('');
  }

  if (!DROP_INDEXES) {
    console.log(`  ${mb(reclaimable)} MB would be reclaimed. Add --indexes to drop them.`);
    console.log('');
  }

  // ── 3. result ───────────────────────────────────────────────────────────
  if (APPLY) {
    const after = await db.prepare('SELECT pg_database_size(current_database()) AS b').get();
    console.log('  ' + '='.repeat(62));
    console.log(`  ${mb(before.b)} MB  ->  ${mb(after.b)} MB`);
    console.log('');
    console.log('  VACUUM marks space reusable inside the table rather than');
    console.log('  returning it to the disk, so the total may barely move. The');
    console.log('  win is that the next few thousand rows cost nothing.');
  } else {
    console.log('  ' + '='.repeat(62));
    console.log('  Dry run. Re-run with --apply to vacuum, and --apply --indexes');
    console.log('  to drop the indexes above as well.');
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('db-reclaim failed:', err.message);
    process.exit(1);
  });
