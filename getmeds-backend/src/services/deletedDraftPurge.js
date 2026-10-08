'use strict';

const db = require('../db/database');

/**
 * The last step of "Delete permanently" for a draft. Oct 8, 2026.
 *
 * Management's delete marks the draft (status 'deleted', draft_cancel_kind 'deleted',
 * draft_cancelled_at = when). The back office stops seeing it at once (draft_cancelled_at
 * hides it), but the MedRep keeps it in My Orders, marked Deleted, so the deletion does
 * not happen behind their back. The row is then erased for good, with everything that
 * cascades from it, by whichever comes first:
 *
 *   - the MedRep marks the deletion notification as read (purgeForNotification), or
 *   - one day passes (purgeExpired, run by the daily cron; until it runs, the MedRep's
 *     list already leaves out anything past the day: see EXPIRED_SQL).
 *
 * Only rows marked by that delete are ever touched: an order Zoho reported deleted also
 * has status 'deleted', but never draft_cancel_kind 'deleted'.
 */

const KEEP_MS = 24 * 60 * 60 * 1000;
const MARKED_SQL = "status = 'deleted' AND draft_cancel_kind = 'deleted'";

const cutoff = (now = Date.now()) => new Date(now - KEEP_MS).toISOString();

/** "Past its day": for list queries that alias orders as o. Takes one parameter: cutoff(). */
const EXPIRED_SQL = "(o.status = 'deleted' AND o.draft_cancel_kind = 'deleted' AND o.draft_cancelled_at < ?)";

async function purgeOrder(orderId) {
  const r = await db.prepare(`DELETE FROM orders WHERE id = ? AND ${MARKED_SQL}`).run(orderId);
  return r.changes;
}

/** Erases every marked draft past its day. Returns how many. */
async function purgeExpired(now = Date.now()) {
  const r = await db.prepare(`DELETE FROM orders WHERE ${MARKED_SQL} AND draft_cancelled_at < ?`).run(cutoff(now));
  return r.changes;
}

/** A deletion notification carries the order's id in its payload. Reading it erases the order. */
function deletedOrderIdOf(notification) {
  if (!notification?.payload) return null;
  try { return JSON.parse(notification.payload).deleted_order_id || null; } catch { return null; }
}

async function purgeForNotifications(notifications) {
  let n = 0;
  for (const row of notifications) {
    const id = deletedOrderIdOf(row);
    if (id) n += await purgeOrder(id);
  }
  return n;
}

module.exports = { KEEP_MS, EXPIRED_SQL, cutoff, purgeOrder, purgeExpired, purgeForNotifications, deletedOrderIdOf };
