#!/usr/bin/env node
/**
 * Clean up audit trails written before the history classifier existed.
 *
 * Sep 10, 2026 (2b). Orders synced before Phase 2 carry every Zoho history
 * line as an untyped `ZOHO_LOG` event — workflow chatter included — plus a
 * second, inferred copy of each milestone written by the reconcile. One real
 * order, ZOHO-SO-67262, had 20 events of which 6 were real.
 *
 * ── LOCAL ONLY, AND IT DOES NOT TOUCH ZOHO ──────────────────────────────────
 * No Zoho adapter is imported and no API call is made. Every legacy row still
 * holds the original description in `notes` and Zoho's own `comment_id` in its
 * metadata — verified across all 7,244 of them — so the whole job can be done
 * by reading rows this database already has. Nothing in Zoho is read, changed
 * or deleted.
 *
 * ── THREE STEPS ─────────────────────────────────────────────────────────────
 *
 * 1. RECLASSIFY. A `ZOHO_LOG` whose description is a real milestone becomes
 *    the proper typed event — an UPDATE, not a delete. This is why the script
 *    needs no Zoho calls and loses nothing: the information was always there,
 *    it was just untyped.
 *
 * 2. PURGE. Automation chatter and contentless "Sales Order updated." rows are
 *    deleted. Anything the classifier does not RECOGNISE is deliberately kept
 *    — see the note on step 2 below.
 *
 * 3. DEDUPE. Where the reconcile inferred a milestone that history also
 *    records, the inferred one goes. History wins: it carries Zoho's own
 *    timestamp and the real person, where the inference carries the moment of
 *    the sync and the name of whoever triggered it.
 *
 *   node scripts/repair-trail-classify.js          # report only
 *   node scripts/repair-trail-classify.js --yes    # apply
 *   node scripts/repair-trail-classify.js --yes --keep-noise   # steps 1 and 3 only
 */
require('dotenv').config();
// Share the database politely: this is a bulk job, and the deployed app is on
// the same Supabase pooler. See lib/batch-job.js.
require('./lib/batch-job');

const db = require('../src/db/database');
const { classify } = require('../src/services/zohoHistoryService');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const keepNoise = args.includes('--keep-noise');

const BATCH = 500;

/** Legacy rows: untyped, but still carrying their original description. */
const LEGACY = "event_type = 'ZOHO_LOG'";

async function main() {
  await db.init();

  const legacy = await db
    .prepare(`SELECT id, order_id, notes FROM order_events WHERE ${LEGACY}`)
    .all();

  const reclassify = [];
  const purge = [];
  const keepUnknown = [];

  for (const row of legacy) {
    const verdict = classify(row.notes);
    if (verdict.kind === 'milestone') {
      reclassify.push({ id: row.id, orderId: row.order_id, type: verdict.type, label: verdict.label });
    } else if (verdict.kind === 'unknown') {
      // Step 2's important exception. An unrecognised line is not noise — it
      // is a line nobody has read yet. Checking these is exactly how Sales
      // Returns, un-shipments and invoice detachments were found: four real
      // milestone types that would have been deleted as chatter under a
      // "delete anything unmatched" rule.
      keepUnknown.push(row);
    } else {
      purge.push(row.id);
    }
  }

  // Inferred milestones that history also records.
  //
  // Computed in JS against the types reclassification is ABOUT to assign, not
  // by matching event_type in SQL. The first version did the latter and always
  // reported zero: at that point the legacy rows are still 'ZOHO_LOG', so
  // `hist.event_type = inf.event_type` can never be true. The dedupe silently
  // did nothing, and the report said so — which is the only reason it was
  // caught.
  const historyKeys = new Set(reclassify.map((r) => `${r.orderId}:${r.type}`));

  // Orders synced since Phase 2 already have properly typed history entries;
  // those count too.
  const alreadyTyped = await db
    .prepare(
      `SELECT order_id, event_type FROM order_events
        WHERE metadata LIKE '%zohoCommentId%' AND event_type <> 'ZOHO_LOG'`
    )
    .all();
  for (const r of alreadyTyped) historyKeys.add(`${r.order_id}:${r.event_type}`);

  const inferred = await db
    .prepare(
      `SELECT id, order_id, event_type FROM order_events
        WHERE metadata NOT LIKE '%zohoCommentId%'
          AND event_type IN ('ZOHO_SO_CONFIRMED','ZOHO_INVOICE_SENT','ZOHO_INVOICE_DRAFTED',
                             'ZOHO_PACKAGE_CREATED','ZOHO_DISPATCHED','ZOHO_SO_EDITED')`
    )
    .all();

  const dupes = inferred.filter((r) => historyKeys.has(`${r.order_id}:${r.event_type}`));

  const byType = {};
  for (const r of reclassify) byType[r.type] = (byType[r.type] || 0) + 1;

  console.log('\nLegacy untyped trail entries: ' + legacy.length + '\n');
  console.log('  1. RECLASSIFY into proper milestone types (an update, nothing lost):');
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, c]) =>
    console.log(`     ${String(c).padStart(5)}  ${t}`)
  );
  console.log(`\n  2. PURGE as noise: ${purge.length}`);
  console.log(`     kept because unrecognised, not noise: ${keepUnknown.length}`);
  if (keepUnknown.length) {
    const distinct = [...new Set(keepUnknown.map((r) => String(r.notes).slice(0, 70)))].slice(0, 5);
    distinct.forEach((d) => console.log(`       · ${d}`));
  }
  console.log(`\n  3. DEDUPE inferred copies of a milestone history already has: ${dupes.length}`);

  const net = legacy.length - purge.length + (dupes.length ? -dupes.length : 0);
  console.log(`\n  Trail rows after: ${legacy.length} legacy -> ${legacy.length - purge.length}, ` +
    `plus ${dupes.length} inferred duplicates removed.`);

  if (!confirmed) {
    console.log(
      '\nReport only — nothing changed. Re-run with --yes to apply.' +
        '\nNo Zoho calls are made; nothing in Zoho is read, changed or deleted.\n'
    );
    await db.close();
    return;
  }

  // ── 1. reclassify ─────────────────────────────────────────────────────────
  let retyped = 0;
  for (let i = 0; i < reclassify.length; i += BATCH) {
    const batch = reclassify.slice(i, i + BATCH);
    const params = [];
    const tuples = batch.map((r) => {
      params.push(r.id, r.type, r.label);
      return '(?::int, ?::text, ?::text)';
    });
    const res = await db
      .prepare(
        `UPDATE order_events e SET event_type = v.type, notes = v.label
           FROM (VALUES ${tuples.join(', ')}) AS v(id, type, label)
          WHERE e.id = v.id`
      )
      .run(...params);
    retyped += res.changes || 0;
    process.stdout.write(`\r  reclassified ${retyped}/${reclassify.length}   `);
  }
  console.log(`\r  reclassified ${retyped}                     `);

  // ── 2. purge ──────────────────────────────────────────────────────────────
  let purged = 0;
  if (keepNoise) {
    console.log('  purge skipped (--keep-noise)');
  } else {
    for (let i = 0; i < purge.length; i += BATCH) {
      const batch = purge.slice(i, i + BATCH);
      // `[batch]`, not `batch`: db/pg.js's flatten() unwraps a lone array
      // argument into separate parameters, so `.run(batch)` is read as 500
      // parameters rather than one array-valued one.
      const res = await db.prepare('DELETE FROM order_events WHERE id = ANY(?)').run([batch]);
      purged += res.changes || 0;
      process.stdout.write(`\r  purged ${purged}/${purge.length}   `);
    }
    console.log(`\r  purged ${purged} noise row(s)                `);
  }

  // ── 3. dedupe ─────────────────────────────────────────────────────────────
  let removed = 0;
  const dupeIds = dupes.map((d) => d.id);
  for (let i = 0; i < dupeIds.length; i += BATCH) {
    const batch = dupeIds.slice(i, i + BATCH);
    // See the flatten() note in the purge step above.
    const res = await db.prepare('DELETE FROM order_events WHERE id = ANY(?)').run([batch]);
    removed += res.changes || 0;
    process.stdout.write(`\r  removed ${removed}/${dupeIds.length} duplicate(s)   `);
  }
  console.log(`\r  removed ${removed} inferred duplicate(s)              `);

  const left = await db.prepare(`SELECT COUNT(*) c FROM order_events WHERE ${LEGACY}`).get();
  console.log(`\n✅ Done. ${left.c} untyped entr(ies) remain` +
    (left.c ? ' — all unrecognised wordings, kept deliberately.' : '.') + '\n');

  await db.close();
}

main().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
