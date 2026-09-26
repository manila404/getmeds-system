'use strict';

/**
 * Which dates order_events can still take — Sep 26, 2026.
 *
 * order_events is partitioned by created_at (see migrate.pg.js,
 * reconcileOrderEventsPartitioning). Once the old "historical" partition was exported
 * and dropped to reclaim space, only order_events_current is left, from 2026-03-01 on,
 * and Postgres refuses any row dated earlier: "no partition of relation "order_events"
 * found for row".
 *
 * That bit the Zoho sync. An order imported from Zoho gets its history backfilled with
 * Zoho's own dates ("Confirmed", "Invoice sent" on 12 Oct 2023), and one refused insert
 * failed the whole reconcile for that order, on every pass, forever.
 *
 * Those old-dated events are exactly the history that was dropped on purpose (Zoho
 * still holds it), so they are now skipped instead of written. Nothing else changes:
 * an event dated inside a live partition is written as always, and if the table has a
 * DEFAULT partition, is not partitioned, or cannot be inspected, every date counts as
 * covered and this stays out of the way.
 */

const db = require('../db/database');

const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, parts } where parts is null (cover everything) or [{ from, to }]
let skipped = 0;

function parseBound(expr) {
  const text = String(expr || '');
  if (/^\s*DEFAULT\s*$/i.test(text)) return { any: true };
  const m = text.match(/FROM \((MINVALUE|'([^']*)')\) TO \((MAXVALUE|'([^']*)')\)/i);
  if (!m) return { any: true }; // a shape we do not recognise: do not guess, do not block
  return { from: m[2] === undefined ? null : m[2], to: m[4] === undefined ? null : m[4] };
}

async function loadParts() {
  try {
    const rows = await db
      .prepare(
        `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'order_events'::regclass`
      )
      .all();
    if (!rows.length) return null;
    const parts = rows.map((r) => parseBound(r.bound));
    return parts.some((p) => p.any) ? null : parts;
  } catch (_) {
    return null;
  }
}

async function getParts() {
  if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), parts: await loadParts() };
  return cache.parts;
}

/** Can an event dated `iso` be written to order_events? */
async function isCovered(iso) {
  const parts = await getParts();
  if (!parts) return true;
  const at = String(iso || '');
  return parts.some((p) => (p.from === null || at >= p.from) && (p.to === null || at < p.to));
}

/**
 * The earliest date covered, for SQL that filters on it (`created_at >= ?`), or null
 * when there is no limit. Assumes the partitions run on from that date, which is the
 * layout here (one partition, from a cutoff to MAXVALUE).
 */
async function coverageFloor() {
  const parts = await getParts();
  if (!parts) return null;
  const froms = parts.map((p) => p.from);
  return froms.includes(null) ? null : froms.sort()[0];
}

/** Count and (rarely) say that an old-dated event was left out. */
function noteSkipped(what) {
  skipped += 1;
  if (skipped === 1 || skipped % 1000 === 0) {
    console.warn(
      `[ORDER_EVENTS] ${what} is dated before the oldest partition, so it was not recorded ` +
        `(${skipped} skipped so far this run). Old Zoho history is deliberately not kept here.`
    );
  }
}

function resetCoverageCache() {
  cache = null;
  skipped = 0;
}

module.exports = { isCovered, coverageFloor, noteSkipped, resetCoverageCache, parseBound };
