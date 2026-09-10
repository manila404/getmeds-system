'use strict';

/**
 * Reading Zoho's own Comments & History as the order's trail.
 *
 * Sep 10, 2026. Until now this app RECONSTRUCTED the trail: it compared Zoho's
 * current state against the local row and wrote a checkpoint for each
 * difference it could see. That gives the milestones but never their real
 * timing or the person behind them — reconcileOrder had to date "Confirmed" to
 * the Sales Order's creation because Zoho's SO record has no confirmed-at
 * field, and had to name the actor "Zoho" because it had no name.
 *
 * Zoho has all of it. Every Sales Order carries a Comments & History log with
 * the exact sequence, timestamps to the minute, and the actual person:
 *
 *   2026-09-10  8:30 AM  Aman Bishnoi   Package PKG-52370 shipped
 *   2026-09-10  8:30 AM  Aman Bishnoi   Sales order converted to invoice INV-12842298
 *   2026-09-10  8:29 AM  Aman Bishnoi   Sales Order marked as open
 *   2026-09-10  8:10 AM  Aman Bishnoi   Sales Order created for PHP5,000.00
 *
 * This module turns those lines into trail events. The inference in
 * zohoReconcileService stays as the fallback for orders whose history cannot
 * be read — but where the history exists, it wins, because it is a record
 * rather than a reconstruction.
 *
 * ── WHAT IS DROPPED, AND WHY ────────────────────────────────────────────────
 * Measured over 18 randomly sampled live orders: 620 history entries, of which
 * 417 (67%) were Zoho Inventory automation —
 *
 *   "The custom function status_update has been executed by the workflow
 *    CRM_status_update."
 *   "Could not execute Custom Function(s) [package_term_update28]. Reached the
 *    maximum limit for custom function triggered..."
 *
 * — and a further 96 were a bare "Sales Order updated." with no indication of
 * what changed. Ingesting everything would put ~2 million rows in order_events
 * for this org, ~80% of which no person would ever want to read.
 *
 * So the automation and the contentless edits are SKIPPED, and the number
 * skipped is recorded on each event's metadata. That matters: a filter that
 * silently discards is indistinguishable from a bug, and Zoho remains the
 * system of record for the raw log if anyone ever needs it.
 */

const db = require('../db/database');
const { toIsoWithTime } = require('./zohoDates');

/**
 * Zoho Inventory's automation chatter. Matched on the TEXT, not the author,
 * because "This Sales Order has been fulfilled" is also authored by Zoho
 * Inventory and is one of the most important lines in the log.
 */
const AUTOMATION = [
  /custom function/i,
  /^the workflow /i,
  /^could not execute/i,
  /reached the maximum limit/i,
  // Sep 10, 2026: Zoho reporting its own outbound webhook fired. Plumbing,
  // not a business event — and it is this app's webhook, so we already know.
  /^webhook \S+ triggered/i
];

/**
 * The lines that mean something, in the order they are tried.
 *
 * `type` deliberately reuses the event types the reconcile already writes
 * (ZOHO_SO_CONFIRMED, ZOHO_PACKAGE_CREATED, ZOHO_DISPATCHED...). That is what
 * makes the two paths cooperate rather than duplicate: the reconcile guards
 * every branch on `alreadyLogged(eventType)`, so once history has recorded the
 * real confirmation, the inference will not add a second, worse-dated one.
 */
const MILESTONES = [
  { re: /^sales order created for\s+(.+)$/i, type: 'ZOHO_SO_CREATED', label: (m) => `Sales Order created in Zoho for ${m[1]}` },
  { re: /^sales order marked as open$/i, type: 'ZOHO_SO_CONFIRMED', label: () => 'Sales Order confirmed in Zoho (marked as open)' },
  { re: /^sales order converted to invoice\s+(.+)$/i, type: 'ZOHO_INVOICE_SENT', label: (m) => `Converted to invoice ${m[1]} in Zoho` },
  { re: /^package\s+(\S+)\s+created$/i, type: 'ZOHO_PACKAGE_CREATED', label: (m) => `Package ${m[1]} created in Zoho` },
  { re: /^package\s+(\S+)\s+shipped$/i, type: 'ZOHO_DISPATCHED', label: (m) => `Package ${m[1]} shipped` },
  { re: /^package\(s\)\s+(.+)\s+delivered$/i, type: 'ZOHO_DELIVERED', label: (m) => `Package ${m[1]} delivered` },
  { re: /^this sales order has been fulfilled$/i, type: 'ZOHO_SO_FULFILLED', label: () => 'Sales Order fulfilled in Zoho' },
  { re: /^package\s+(\S+)\s+deleted$/i, type: 'ZOHO_PACKAGE_DELETED', label: (m) => `Package ${m[1]} deleted in Zoho` },
  { re: /^package\s+(\S+)\s+updated$/i, type: 'ZOHO_PACKAGE_UPDATED', label: (m) => `Package ${m[1]} updated in Zoho` },
  { re: /^attachment added$/i, type: 'ZOHO_ATTACHMENT_ADDED', label: () => 'Attachment added in Zoho' },

  // Sep 10, 2026: REVERSALS AND RETURNS.
  //
  // Found by the `unknown` bucket, which is the whole reason it is reported
  // separately from the two known-noise kinds rather than binned with them.
  // Twenty distinct wordings in the live history were unrecognised, and they
  // were not chatter — they were a shipment being undone, a delivery being
  // undone, an invoice being detached, and a customer RETURNING goods. Losing
  // any of those would leave a trail that shows only the happy path.
  { re: /^sales return\s+(\S+?)\.?\s*created\.?$/i, type: 'ZOHO_SALES_RETURN', label: (m) => `Sales Return ${m[1]} created in Zoho` },
  { re: /^package\s+(\S+)\s+unshipped$/i, type: 'ZOHO_PACKAGE_UNSHIPPED', label: (m) => `Package ${m[1]} un-shipped in Zoho — the shipment was reversed` },
  { re: /^package\(s\)\s+(.+)\s+undelivered$/i, type: 'ZOHO_UNDELIVERED', label: (m) => `Package ${m[1]} marked undelivered in Zoho` },
  { re: /^the sales order has been dissociated from the invoice\s+(.+?)\.?$/i, type: 'ZOHO_INVOICE_DETACHED', label: (m) => `Detached from invoice ${m[1]} in Zoho` },
  // An edit that SAYS what changed is worth keeping; the bare "Sales Order
  // updated." with nothing after it is not, and is handled below.
  { re: /^sales order updated\.\s*(.+)$/i, type: 'ZOHO_SO_EDITED', label: (m) => `Edited in Zoho — ${m[1]}` }
];

/** Contentless lines: real people, real timestamps, nothing said. */
const CONTENTLESS = [/^sales order updated\.?$/i, /^template has been updated$/i];

/**
 * What is this history line?
 *
 * Returns `{ kind: 'milestone', type, label }` for something worth recording,
 * or `{ kind: 'automation' | 'contentless' | 'unknown' }` for something not.
 *
 * 'unknown' is reported separately from the two known-noise kinds on purpose.
 * Zoho can add wording this module has never seen, and an unrecognised line
 * being counted as "unknown" rather than quietly lumped in with the workflow
 * chatter is how anyone would ever find out.
 */
function classify(description) {
  const text = String(description || '').trim();
  if (!text) return { kind: 'contentless' };

  if (AUTOMATION.some((re) => re.test(text))) return { kind: 'automation' };
  if (CONTENTLESS.some((re) => re.test(text))) return { kind: 'contentless' };

  for (const m of MILESTONES) {
    const match = m.re.exec(text);
    if (match) return { kind: 'milestone', type: m.type, label: m.label(match) };
  }

  return { kind: 'unknown' };
}

/**
 * Write one Sales Order's history into its trail.
 *
 * Idempotent by Zoho's own `comment_id`, held in each event's metadata, so
 * re-running adds only what has appeared since. Entries Zoho gives no id for
 * fall back to a hash of their content, which is stable for the same reason.
 *
 * NEVER throws: an order whose history cannot be read still keeps whatever the
 * reconcile inferred for it.
 */
async function ingestHistory({ orderId, salesorderId, comments, source = 'zoho_history' }) {
  const log = Array.isArray(comments) ? comments : [];
  if (!log.length) return { written: 0, automation: 0, contentless: 0, unknown: 0, unknownSamples: [] };

  // One read of what is already recorded rather than one per line — this runs
  // for every order, and a per-entry probe would be a network round trip each
  // against a hosted database.
  const existingRows = await db
    .prepare(
      `SELECT metadata FROM order_events
        WHERE order_id = ? AND metadata LIKE '%"zohoCommentId"%'`
    )
    .all(orderId);

  const seen = new Set();
  for (const row of existingRows) {
    try {
      const key = JSON.parse(row.metadata || '{}').zohoCommentId;
      if (key) seen.add(String(key));
    } catch (_) {
      // A malformed metadata blob is not a reason to refuse the ingest; the
      // worst case is one duplicated trail entry.
    }
  }

  const counts = { written: 0, automation: 0, contentless: 0, unknown: 0 };
  const unknownSamples = [];
  const fresh = [];

  for (const entry of log) {
    const verdict = classify(entry.description);
    if (verdict.kind !== 'milestone') {
      counts[verdict.kind] = (counts[verdict.kind] || 0) + 1;
      if (verdict.kind === 'unknown' && unknownSamples.length < 5) {
        unknownSamples.push(String(entry.description || '').slice(0, 120));
      }
      continue;
    }

    const key = String(
      entry.comment_id || `${entry.date || ''}|${entry.time || ''}|${entry.description || ''}`
    );
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ entry, key, verdict });
  }

  if (!fresh.length) {
    return { ...counts, unknownSamples };
  }

  // Oldest first, so the rows are inserted in the sequence they happened and
  // same-minute entries tie-break correctly when the trail is read back by
  // (created_at, id). Zoho returns them newest-first.
  fresh.reverse();

  const insert = db.prepare(`
    INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata, created_at)
    VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
  `);

  for (const { entry, key, verdict } of fresh) {
    // actor_id stays NULL: the person named is a Zoho user, and users(id) is
    // this app's own table. Writing a local id would claim an equivalence that
    // does not exist. The NAME is what the trail shows, and unlike the
    // inferred checkpoints it is a real one — "Aman Bishnoi", not "Zoho".
    const actorName = entry.commented_by || 'Zoho';
    const occurredAt = toIsoWithTime(entry.date, entry.time) || new Date().toISOString();

    await insert.run(
      orderId,
      verdict.type,
      actorName,
      verdict.label,
      JSON.stringify({
        zohoCommentId: key,
        zohoOperationType: entry.operation_type || null,
        zohoDate: entry.date || null,
        zohoTime: entry.time || null,
        zohoDescription: entry.description || null,
        // Recorded so a filtered-out line is never silently invisible — see
        // this module's header.
        skipped: { automation: counts.automation, contentless: counts.contentless, unknown: counts.unknown },
        source,
        // Marks this as coming from the correctly-dated path, the same way the
        // reconcile does — see scripts/repair-trail-dates.js.
        syncedAt: new Date().toISOString(),
        syncedBy: 'Zoho history'
      }),
      occurredAt
    );
    counts.written++;
  }

  if (unknownSamples.length) {
    console.warn(
      `[ZOHO_HISTORY] order ${orderId}: ${counts.unknown} unrecognised history line(s) — ` +
        unknownSamples.join(' | ')
    );
  }

  return { ...counts, unknownSamples };
}

module.exports = { classify, ingestHistory, MILESTONES, AUTOMATION, CONTENTLESS };
