#!/usr/bin/env node
/**
 * Repair audit-trail entries that were stamped with the time of the SYNC
 * rather than the time of the event.
 *
 * Sep 10, 2026. Until today, auditService.logEvent hard-coded created_at to
 * 'now', so every checkpoint the Zoho reconcile backfilled was dated to the
 * moment this app happened to look. A real example: SO-59395 was raised,
 * invoiced, paid and packed on 31 Jan 2026; its trail showed Confirmed,
 * Invoice Sent, Payment Received and Packed all at 08:08 on 10 Sep, credited
 * to whoever had opened the page.
 *
 * The code is fixed — new syncs read Zoho's own dates. This deals with the
 * entries already written.
 *
 * ── IT RE-DATES IN PLACE. IT DOES NOT DELETE ────────────────────────────────
 *
 * The first version of this script deleted the bad rows and let the next sync
 * rebuild them. That was wrong, and testing it on one order is what showed it:
 * the rebuilt trail came back MISSING its "Packed" entry.
 *
 * The reason was that the reconcile's branches were gated on the order's
 * current status — the package checkpoint only fired for an order still
 * sitting pre-packing. An order being repaired has long since advanced past
 * that, so the branch was skipped and the entry was gone for good. Run across
 * 1,200 orders it would have quietly destroyed every Packed and Shipped entry
 * it touched.
 *
 * (That gating was itself a bug and is now fixed — see the package branch in
 * zohoReconcileService. But re-dating in place is the better repair
 * regardless: it cannot lose an entry whose branch it does not understand, and
 * it is idempotent.)
 *
 * So: fetch each order's Sales Order from Zoho ONCE, read the real date for
 * each checkpoint out of it, and UPDATE the rows already there. Nothing is
 * deleted, no branch logic is involved, and an entry this script has no date
 * for is left exactly as it is rather than removed.
 *
 *   node scripts/repair-trail-dates.js                    # report only
 *   node scripts/repair-trail-dates.js --yes              # re-date, up to --limit
 *   node scripts/repair-trail-dates.js --yes --limit 200
 *   node scripts/repair-trail-dates.js --yes --order ZOHO-SO-59395   # just one
 *
 * One Zoho GET per order. --limit (default 500) keeps a run inside Zoho's
 * per-minute rate limit and daily budget; re-run to take the next batch. Safe
 * to repeat: a row it has fixed no longer matches the filter.
 */
require('dotenv').config();

const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { firstIso, notBefore } = require('../src/services/zohoDates');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const orderArg = args.indexOf('--order');
const ONLY_ORDER = orderArg !== -1 ? args[orderArg + 1] : null;
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) || 500 : 500;

/**
 * The event types the Zoho reconcile backfills, and the only ones this script
 * may touch.
 *
 * Deliberately NOT a wildcard. Events recorded when a person did something IN
 * this app — ORDER_SUBMITTED, FINANCE_VERIFIED, PAYMENT_PROOF_UPLOADED — are
 * correctly dated to when they happened, which was 'now' at the time.
 *
 * ORDER_IMPORTED_FROM_ZOHO is excluded: it already carries the Sales Order's
 * creation date, and it is this app's own record of the import rather than a
 * Zoho checkpoint. ZOHO_LOG is excluded too — those are copied from Zoho's
 * Comments & History with Zoho's own timestamps and were never affected.
 */
const REBUILDABLE = [
  'ZOHO_SO_CONFIRMED',
  'ZOHO_SO_EDITED',
  'ZOHO_SO_CANCELLED',
  'ZOHO_INVOICE_DRAFTED',
  'ZOHO_INVOICE_SENT',
  'ZOHO_PAYMENT_VERIFIED',
  'ZOHO_PACKAGE_CREATED',
  'ZOHO_DISPATCHED',
  'TRACKING_ENTERED',
  'ORDER_COMPLETED'
];

/**
 * A row is mis-stamped when it was written by the OLD code — which is to say,
 * when its metadata has no `syncedAt`. The fix adds that key to every
 * Zoho-sourced event it writes, so its presence is an exact marker of "this
 * row came from the correctly-dated path".
 *
 * Matching on the marker rather than on "the date looks wrong" matters: an
 * order genuinely confirmed today has an entry dated today, and a date-based
 * heuristic would rewrite it.
 */
const MIS_STAMPED = `
  e.event_type = ANY(?)
  AND o.getmeds_order_id LIKE 'ZOHO-%'
  AND (e.metadata IS NULL OR e.metadata NOT LIKE '%"syncedAt"%')
`;

/**
 * Bind params, working around db/pg.js's flatten().
 *
 * flatten() unwraps a lone array argument, preserving better-sqlite3's habit of
 * accepting both `.all(a, b)` and `.all([a, b])`. That makes a single
 * array-VALUED parameter ambiguous — `.all(REBUILDABLE)` is read as ten
 * separate parameters. Wrapping restores the meaning, and only when it is the
 * sole parameter.
 */
function bind(stmt, method, params) {
  return params.length === 1 ? stmt[method]([params[0]]) : stmt[method](...params);
}

/** The later of several ISO timestamps, ignoring nulls. */
function latestOf(...isos) {
  const known = isos.filter(Boolean).sort();
  return known.length ? known[known.length - 1] : null;
}

/**
 * The real date for each checkpoint, read off the Zoho Sales Order.
 *
 * Mirrors the occurredAt choices in zohoReconcileService exactly — if the two
 * disagreed, a repaired order and a freshly synced one would show the same
 * event on different days.
 */
function datesFor(so) {
  const invoices = Array.isArray(so.invoices) ? so.invoices : [];
  const packages = Array.isArray(so.packages) ? so.packages : [];
  const invoice = invoices.length ? invoices[invoices.length - 1] : null;
  const pkg = packages.length ? packages[packages.length - 1] : null;

  // Nothing that happens TO a Sales Order can predate it — see notBefore.
  const soCreated = firstIso(so.created_time, so.date);
  const invoiceDate = notBefore(firstIso(invoice && invoice.date, so.date), soCreated);
  const shipDate = notBefore(
    firstIso(pkg && pkg.shipment_date, pkg && pkg.date, so.shipment_date, so.date),
    soCreated
  );

  return {
    // Zoho records no separate "confirmed at", so this is the SO's own
    // creation time — the closest honest answer, same as the reconcile uses.
    ZOHO_SO_CONFIRMED: firstIso(so.created_time, so.date),
    ZOHO_SO_EDITED: firstIso(so.last_modified_time, so.date),
    ZOHO_SO_CANCELLED: firstIso(so.last_modified_time, so.date),
    ZOHO_INVOICE_DRAFTED: invoiceDate,
    ZOHO_INVOICE_SENT: invoiceDate,
    ZOHO_PAYMENT_VERIFIED: invoiceDate,
    ZOHO_PACKAGE_CREATED: notBefore(firstIso(pkg && pkg.date, so.shipment_date, so.date), soCreated),
    ZOHO_DISPATCHED: shipDate,
    TRACKING_ENTERED: shipDate,
    // Completed when BOTH facts were true, so the later of the two.
    ORDER_COMPLETED: latestOf(invoiceDate, shipDate)
  };
}

/** Strip the sync boilerplate the old code wrote into what a person reads. */
function cleanNotes(notes) {
  return String(notes || '')
    .replace(/\s*—\s*backfilled by manual sync;[^.]*happened\.?/gi, '')
    .replace(/\s*—\s*backfilled by manual sync\.?/gi, '')
    .replace(/\s*—\s*payment recorded by manual sync\.?/gi, '.')
    .replace(/\s+found in Zoho/gi, ' in Zoho')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function main() {
  await db.init();

  const params = [REBUILDABLE];
  let scope = '';
  if (ONLY_ORDER) {
    scope = ' AND o.getmeds_order_id = ?';
    params.push(ONLY_ORDER);
  }

  const summary = await bind(
    db.prepare(
      `SELECT e.event_type, COUNT(*) AS c, COUNT(DISTINCT e.order_id) AS orders
         FROM order_events e JOIN orders o ON e.order_id = o.id
        WHERE ${MIS_STAMPED}${scope}
        GROUP BY e.event_type
        ORDER BY c DESC`
    ),
    'all',
    params
  );

  if (!summary.length) {
    console.log('\nNothing to repair — every Zoho-sourced trail entry already carries its real date.\n');
    await db.close();
    return;
  }

  const totalEvents = summary.reduce((a, r) => a + Number(r.c), 0);
  const affected = await bind(
    db.prepare(
      `SELECT COUNT(DISTINCT e.order_id) AS c
         FROM order_events e JOIN orders o ON e.order_id = o.id
        WHERE ${MIS_STAMPED}${scope}`
    ),
    'get',
    params
  );

  console.log('\nTrail entries stamped with the sync time instead of the event time:\n');
  for (const r of summary) {
    console.log(`  ${String(r.c).padStart(6)}  ${r.event_type.padEnd(24)} across ${r.orders} order(s)`);
  }
  console.log(`\n  ${totalEvents} entr(ies) on ${affected.c} order(s).`);

  if (!confirmed) {
    console.log(
      `\nReport only — nothing written. Re-run with --yes to re-date up to ${LIMIT}\n` +
        "order(s) from Zoho's own dates. Nothing is deleted.\n"
    );
    await db.close();
    return;
  }

  const targets = await bind(
    db.prepare(
      `SELECT DISTINCT e.order_id AS id, o.getmeds_order_id, o.zoho_so_id
         FROM order_events e JOIN orders o ON e.order_id = o.id
        WHERE ${MIS_STAMPED}${scope}
        ORDER BY e.order_id
        LIMIT ${LIMIT}`
    ),
    'all',
    params
  );

  console.log(`\nRe-dating ${targets.length} order(s) from Zoho (mode: ${zoho.mode})…\n`);

  let fixed = 0;
  let rows = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of targets) {
    if (!t.zoho_so_id) {
      skipped++;
      continue;
    }
    try {
      const detail = await zoho.getSalesOrder(t.zoho_so_id);
      const so = detail && detail.salesorder;
      if (!so) {
        skipped++;
        continue;
      }

      const dates = datesFor(so);
      const events = await db
        .prepare(
          `SELECT id, event_type, notes, metadata FROM order_events
            WHERE order_id = ? AND event_type = ANY(?)
              AND (metadata IS NULL OR metadata NOT LIKE '%"syncedAt"%')`
        )
        .all(t.id, REBUILDABLE);

      for (const e of events) {
        const occurredAt = dates[e.event_type];
        // No date for this checkpoint — leave the row completely alone rather
        // than guessing or removing it. A wrong date is worse than an old one.
        if (!occurredAt) continue;

        let meta = {};
        try {
          meta = JSON.parse(e.metadata || '{}');
        } catch (_) {
          meta = {};
        }
        meta.syncedAt = new Date().toISOString();
        meta.syncedBy = 'Trail repair';
        meta.repairedFrom = 'zoho_dates';

        await db
          .prepare(
            `UPDATE order_events
                SET created_at = ?, actor_name = 'Zoho', actor_id = NULL, notes = ?, metadata = ?
              WHERE id = ?`
          )
          .run(occurredAt, cleanNotes(e.notes), JSON.stringify(meta), e.id);
        rows++;
      }
      fixed++;
    } catch (err) {
      failed++;
      if (failed <= 10) console.warn(`  ! ${t.getmeds_order_id}: ${err.message}`);
    }

    if ((fixed + failed + skipped) % 25 === 0) {
      process.stdout.write(`\r  ${fixed + failed + skipped}/${targets.length}   `);
    }
  }

  console.log(
    `\r  ${fixed} order(s) re-dated, ${rows} entr(ies) updated, ${failed} failed, ${skipped} skipped.        \n`
  );

  const left = await bind(
    db.prepare(
      `SELECT COUNT(DISTINCT e.order_id) AS c
         FROM order_events e JOIN orders o ON e.order_id = o.id
        WHERE ${MIS_STAMPED}${scope}`
    ),
    'get',
    params
  );
  if (left.c > 0) {
    console.log(`  ${left.c} order(s) still to go — run this again to take the next ${LIMIT}.\n`);
  } else {
    console.log('  Every trail now carries its real Zoho dates.\n');
  }

  await db.close();
}

main().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
