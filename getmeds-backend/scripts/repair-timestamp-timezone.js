#!/usr/bin/env node
/**
 * Convert timestamps that were stored in Zoho's LOCAL time into UTC.
 *
 * Sep 10, 2026. The Zoho import wrote `salesorder.created_time` straight into
 * columns every other writer fills with UTC ISO:
 *
 *   orders.created_at        "2026-09-09T15:14:00+0800"   <- Zoho local, raw
 *   order_events.created_at  "2026-09-09T07:14:00.000Z"   <- UTC, correct
 *
 * 60,829 rows in each of orders.created_at, orders.submitted_at and
 * order_events.created_at. Three consequences, and the second is the one that
 * actually bit:
 *
 *   1. Displayed 8 hours out, depending on how the value is parsed.
 *   2. SORTING BROKE. These columns are TEXT, so they compare
 *      lexicographically — and '...15:14+0800' sorts AFTER '...07:39Z' even
 *      though it is eight hours EARLIER. That is why an order's own "imported
 *      from Zoho" entry sank to the bottom of its own audit timeline, below
 *      history entries that happened after it.
 *   3. The Orders list date filter compares against '...T00:00:00.000Z', so a
 *      mixed-format column matched the wrong rows.
 *
 * ── LOCAL ONLY ──────────────────────────────────────────────────────────────
 * This script makes NO Zoho calls of any kind — it does not import the Zoho
 * adapter at all. It reads and rewrites three columns in this database and
 * nothing else. Nothing in Zoho is read, changed, or deleted.
 *
 * ── IT CONVERTS, IT DOES NOT DELETE ─────────────────────────────────────────
 * Every affected row keeps its identity and its meaning; only the timezone
 * representation changes. `2026-09-09T15:14:00+0800` and
 * `2026-09-09T07:14:00.000Z` are the same instant.
 *
 *   node scripts/repair-timestamp-timezone.js          # report only
 *   node scripts/repair-timestamp-timezone.js --yes    # convert
 *   node scripts/repair-timestamp-timezone.js --yes --limit 5000
 */
require('dotenv').config();

const db = require('../src/db/database');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) || 0 : 0;

/**
 * The three columns the import filled with Zoho's local time.
 *
 * Deliberately an explicit list rather than "every timestamp column". Columns
 * this app writes itself — updated_at, payments.created_at,
 * dispatch_records.created_at, last_reconciled_at — were verified clean and
 * must not be touched: a blanket rewrite would be looking for a problem in
 * places it cannot exist.
 */
const TARGETS = [
  { table: 'orders', column: 'created_at' },
  { table: 'orders', column: 'submitted_at' },
  { table: 'order_events', column: 'created_at' }
];

/** Matches only the offset-bearing form the import produced. */
const BAD = (col) => `(${col} LIKE '%+0800' OR ${col} LIKE '%+08:00')`;

/**
 * Postgres does the conversion, not JavaScript.
 *
 * `'2026-09-09T15:14:00+0800'::timestamptz` is parsed WITH its offset and
 * rendered back in UTC, which is precisely the transformation needed — and it
 * happens in one statement per batch rather than 60,829 round trips. Doing it
 * row-by-row in Node would take hours against a hosted database for a change
 * the database can express directly.
 *
 * to_char rather than ::text so the output is exactly the ISO shape everything
 * else writes: 'YYYY-MM-DDTHH:MM:SS.mmmZ'.
 */
const TO_UTC = (col) =>
  `to_char(${col}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function main() {
  await db.init();

  console.log('\nTimestamps stored in Zoho local time instead of UTC:\n');

  const counts = [];
  for (const t of TARGETS) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${BAD(t.column)}`)
      .get();
    counts.push({ ...t, count: Number(row.c) });
    console.log(`  ${String(row.c).padStart(7)}  ${t.table}.${t.column}`);
  }

  const total = counts.reduce((a, c) => a + c.count, 0);
  if (!total) {
    console.log('\nNothing to convert — every timestamp is already UTC.\n');
    await db.close();
    return;
  }

  // Show one before/after so the transformation is visible before it is run.
  const sample = await db
    .prepare(
      `SELECT created_at AS before, ${TO_UTC('created_at')} AS after
         FROM orders WHERE ${BAD('created_at')} LIMIT 3`
    )
    .all();
  console.log('\n  Example conversions (same instant, correct representation):');
  for (const s of sample) console.log(`    ${s.before}  ->  ${s.after}`);

  if (!confirmed) {
    console.log(
      '\nReport only — nothing changed. Re-run with --yes to convert.' +
        '\nNo Zoho calls are made and nothing is deleted; only the timezone' +
        '\nrepresentation of these three columns changes.\n'
    );
    await db.close();
    return;
  }

  console.log('\nConverting…\n');

  for (const t of counts) {
    if (!t.count) continue;
    // Batched by primary key so a very large table is not rewritten in one
    // transaction — and so a run interrupted halfway leaves a consistent
    // mixture this script can simply be re-run over.
    let done = 0;
    for (;;) {
      const cap = LIMIT ? Math.min(5000, LIMIT - done) : 5000;
      if (cap <= 0) break;

      const res = await db
        .prepare(
          `UPDATE ${t.table} SET ${t.column} = ${TO_UTC(t.column)}
            WHERE id IN (
              SELECT id FROM ${t.table} WHERE ${BAD(t.column)} LIMIT ${cap}
            )`
        )
        .run();

      const changed = res.changes || 0;
      done += changed;
      process.stdout.write(`\r  ${t.table}.${t.column}: ${done}/${t.count}   `);
      if (!changed) break;
    }
    console.log(`\r  ${t.table}.${t.column}: ${done} converted.          `);
  }

  const left = [];
  for (const t of TARGETS) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${BAD(t.column)}`)
      .get();
    if (Number(row.c)) left.push(`${t.table}.${t.column}: ${row.c}`);
  }

  if (left.length) {
    console.log(`\n  Still to convert — re-run to continue: ${left.join(', ')}\n`);
  } else {
    console.log('\n✅ Every timestamp is now UTC. Audit timelines sort correctly, and');
    console.log('   the Orders list date filter compares like with like.\n');
  }

  await db.close();
}

main().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
