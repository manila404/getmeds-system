'use strict';

/**
 * Turning Zoho's dates into the ISO timestamps order_events stores.
 *
 * Sep 10, 2026. Pulled out of zohoOrderImportService so the reconcile can use
 * it too, after the audit trail on imported orders was found to be stamped
 * with the time of the SYNC rather than the time of the event. An order raised
 * on 31 Jan showed "Confirmed", "Invoice sent", "Payment received" and
 * "Packed" all at 08:08 on 10 Sep, which is a record of when this app looked,
 * not of what happened.
 *
 * Zoho reports dates two ways and both need handling:
 *   'created_time': '2026-01-31T16:17:52+0800'  — a full timestamp, offset included
 *   'date':         '2026-01-31'                — a bare date, offset implied
 */

/**
 * The org's UTC offset, for bare dates that carry none.
 *
 * +08:00 because this org is Philippine — Asia/Manila has no DST, so a fixed
 * offset is exact rather than an approximation. Set ZOHO_ORG_UTC_OFFSET if
 * that stops being true.
 */
const ORG_UTC_OFFSET = process.env.ZOHO_ORG_UTC_OFFSET || '+08:00';

/**
 * Zoho date or timestamp -> UTC ISO string, or null if it cannot be read.
 *
 * Returns null rather than falling back to "now" on purpose. The caller has to
 * decide what an unknown date means, and silently substituting the current
 * time is exactly the bug this module exists to fix — it produces a trail that
 * looks precise and is wrong.
 *
 *   '2026-01-31T16:17:52+0800' -> '2026-01-31T08:17:52.000Z'
 *   '2026-01-31'               -> '2026-01-30T16:00:00.000Z'  (midnight at +08:00)
 */
function toIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  // A bare date: give it the org's midnight rather than UTC's, or an order
  // filed on the 31st sorts into the 30th for anyone reading it locally.
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00${ORG_UTC_OFFSET}` : raw;

  // Zoho writes '+0800'; Date wants '+08:00'.
  const normalised = bare.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A bare Zoho date plus a clock time from its history log.
 *
 * Used for the Comments & History entries, which report '2026-01-31' and
 * '10:32 AM' as separate fields with the org's timezone implied.
 */
function toIsoWithTime(date, time) {
  const day = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  let hours = 0;
  let minutes = 0;
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(String(time || '').trim());
  if (m) {
    minutes = parseInt(m[2], 10);
    if (m[3]) {
      hours = parseInt(m[1], 10) % 12;
      if (m[3].toLowerCase() === 'pm') hours += 12;
    } else {
      hours = parseInt(m[1], 10); // 24-hour clock, no meridiem
    }
  }

  return toIso(
    `${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00${ORG_UTC_OFFSET}`
  );
}

/**
 * The first readable date among several candidates.
 *
 * Checkpoints differ in how precisely Zoho dates them — an edit has an exact
 * last_modified_time, a package only has a date — so each call site lists what
 * it has, best first.
 */
function firstIso(...candidates) {
  for (const c of candidates) {
    const iso = toIso(c);
    if (iso) return iso;
  }
  return null;
}

/**
 * Never earlier than `floor`.
 *
 * Sep 10, 2026. Zoho dates its Sales Order to the second (created_time) but its
 * invoices and packages only to the day. Taken literally that puts an invoice
 * dated '2026-01-31' at midnight and the Sales Order it belongs to at 16:17 the
 * same day — so the trail read Invoiced, Paid, Packed, and only then Confirmed.
 *
 * An invoice cannot predate the Sales Order it invoices, and a package cannot
 * predate the order it packs. Clamping to the Sales Order's own creation is not
 * a fudge to make the list look tidy; it is the one thing about the missing
 * time that IS known. Same-day events then tie, and the trail falls back to the
 * order they were recorded in, which is the sequence they happened in.
 */
function notBefore(iso, floor) {
  if (!iso) return null;
  if (!floor) return iso;
  return iso < floor ? floor : iso;
}

module.exports = { toIso, toIsoWithTime, firstIso, notBefore, ORG_UTC_OFFSET };
