#!/usr/bin/env node
/**
 * Fill in `orders.division` from Zoho's Salesperson string.
 *
 * Sep 11, 2026. Groundwork for scoped manager visibility: a manager who covers
 * B2B and CLIDP can only be shown their orders if the orders know which
 * division they belong to, and 60,861 of 60,866 do not.
 *
 * ── LOCAL ONLY ──────────────────────────────────────────────────────────────
 * Makes NO Zoho calls. It reads `orders.salesperson`, which the import already
 * brought in, and writes `orders.division`. Nothing in Zoho is read, changed
 * or deleted.
 *
 * ── IT NEVER GUESSES ────────────────────────────────────────────────────────
 * Only an exact, known Division prefix is accepted — see
 * services/divisionFromSalesperson.js. "Mohit Kumar", "WEB", "Shopee" and the
 * 30,854 orders with no Salesperson at all are left NULL, and a NULL division
 * is visible only to a full-scope manager. That is the safe direction: an
 * unattributable order in front of nobody in particular, rather than in front
 * of the wrong manager.
 *
 * ── SAFE TO REPEAT ──────────────────────────────────────────────────────────
 * Only touches rows whose division is NULL, so a second run is a no-op over
 * what the first one did. It will not overwrite a division set by hand or at
 * order creation.
 *
 *   node scripts/backfill-order-division.js          # report only
 *   node scripts/backfill-order-division.js --yes    # write
 */
require('dotenv').config();
// Share the database politely: this is a bulk job, and the deployed app is on
// the same Supabase pooler. See lib/batch-job.js.
require('./lib/batch-job');

const db = require('../src/db/database');
const { divisionFromSalesperson, prefixOf } = require('../src/services/divisionFromSalesperson');

const confirmed = process.argv.includes('--yes');
const WRITE_BATCH_SIZE = 500;

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const num = (n) => n.toLocaleString();

(async () => {
  const rows = await db
    .prepare(
      `SELECT id, salesperson FROM orders
        WHERE division IS NULL
        ORDER BY id`
    )
    .all();

  const updates = [];
  const byDivision = new Map();
  const unresolved = new Map();
  let noSalesperson = 0;

  for (const r of rows) {
    const division = divisionFromSalesperson(r.salesperson);
    if (division) {
      updates.push({ id: r.id, division });
      byDivision.set(division, (byDivision.get(division) || 0) + 1);
      continue;
    }
    const prefix = prefixOf(r.salesperson);
    if (!prefix) noSalesperson++;
    else unresolved.set(prefix, (unresolved.get(prefix) || 0) + 1);
  }

  console.log(`\nOrders with no division: ${num(rows.length)}\n`);

  console.log('Recoverable from the Zoho Salesperson prefix:');
  for (const [d, n] of [...byDivision].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(d, 24)} ${num(n)}`);
  }
  console.log(`  ${pad('', 24)} ${'-'.repeat(8)}`);
  console.log(`  ${pad('total', 24)} ${num(updates.length)}\n`);

  console.log('Left as NULL — visible only to a full-scope manager:');
  console.log(`  ${pad('no Salesperson at all', 34)} ${num(noSalesperson)}`);
  const topUnresolved = [...unresolved].sort((a, b) => b[1] - a[1]);
  const unresolvedTotal = topUnresolved.reduce((sum, [, n]) => sum + n, 0);
  console.log(`  ${pad('Salesperson naming no division', 34)} ${num(unresolvedTotal)}`);
  for (const [p, n] of topUnresolved.slice(0, 10)) {
    console.log(`      ${pad(p, 30)} ${num(n)}`);
  }
  if (topUnresolved.length > 10) {
    console.log(`      ${pad(`…and ${topUnresolved.length - 10} more`, 30)}`);
  }

  if (!updates.length) {
    console.log('\nNothing to backfill.\n');
    await db.close();
    return;
  }

  if (!confirmed) {
    console.log(`\nReport only — nothing written. Re-run with --yes to set ${num(updates.length)} division(s).\n`);
    await db.close();
    return;
  }

  console.log(`\nWriting ${num(updates.length)} division(s)…`);
  let written = 0;

  for (let i = 0; i < updates.length; i += WRITE_BATCH_SIZE) {
    const batch = updates.slice(i, i + WRITE_BATCH_SIZE);
    const params = [];
    const tuples = batch.map((u) => {
      params.push(u.id, u.division);
      // Casts are load-bearing: an untyped VALUES column arrives as text and
      // orders.id is an integer, so without them Postgres refuses the UPDATE.
      return '(?::int, ?::text)';
    });

    const res = await db
      .prepare(
        `UPDATE orders o SET division = v.division
           FROM (VALUES ${tuples.join(', ')}) AS v(id, division)
          WHERE o.id = v.id
            -- Re-checked here, not just in the SELECT above: a concurrent
            -- order creation between the read and this write must not be
            -- overwritten by a value derived from a stale snapshot.
            AND o.division IS NULL`
      )
      .run(...params);
    written += res.changes || 0;
    process.stdout.write(`\r  ${num(written)}/${num(updates.length)}   `);
  }

  console.log(`\n\n✅ ${num(written)} order(s) now carry a division.\n`);
  await db.close();
})().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
