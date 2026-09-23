'use strict';

const db = require('../db/database');

/**
 * Retention for the `notifications` table.
 *
 * Sep 23, 2026. Notifications are a transient, in-app "you have a ping"
 * signal, not a system of record — order_events already IS the durable
 * audit trail (see its own comment block), so nothing about an order's
 * history is lost when an old notification is removed. Left unmanaged, this
 * table went from nothing to 258,000+ rows and ~80 MB in 16 days, on track
 * to become the single largest table in the database, while 94% of those
 * rows were never read at all — the volume was pure carry weight, not
 * signal anyone was consuming.
 *
 * Two-tier retention: a notification someone actually read is cleared
 * quickly (it did its job); one that's still unread gets a longer runway
 * before assuming it never will be. Both are generous relative to how this
 * feature is actually used (a bell icon, not an inbox) — this is a floor
 * against unbounded growth, not an aggressive prune.
 */

const READ_RETENTION_DAYS = parseInt(process.env.NOTIFICATION_READ_RETENTION_DAYS, 10) || 30;
const UNREAD_RETENTION_DAYS = parseInt(process.env.NOTIFICATION_UNREAD_RETENTION_DAYS, 10) || 90;

// Deletes run in batches rather than one statement — this table has had six
// figures of rows accumulate, and one unbounded DELETE would hold a lock and
// generate a WAL spike proportional to however large the backlog has grown.
// A batch loop yields the same end state with no single slow transaction.
const BATCH_SIZE = 5000;

async function deleteBatches(whereSql, param) {
  let total = 0;
  for (;;) {
    const res = await db
      .prepare(
        `DELETE FROM notifications WHERE id IN (
           SELECT id FROM notifications WHERE ${whereSql} LIMIT ?
         )`
      )
      .run(param, BATCH_SIZE);
    const deleted = res.changes || 0;
    total += deleted;
    if (deleted < BATCH_SIZE) break;
  }
  return total;
}

/**
 * Run one purge pass. Safe to call repeatedly — each call only removes rows
 * that are still past their own cutoff at the time it runs.
 */
async function purgeOnce() {
  const now = Date.now();
  const readCutoff = new Date(now - READ_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const unreadCutoff = new Date(now - UNREAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const deletedRead = await deleteBatches('is_read = 1 AND sent_at < ?', readCutoff);
  const deletedUnread = await deleteBatches('is_read = 0 AND sent_at < ?', unreadCutoff);

  return {
    deletedRead,
    deletedUnread,
    total: deletedRead + deletedUnread,
    readCutoff,
    unreadCutoff,
    readRetentionDays: READ_RETENTION_DAYS,
    unreadRetentionDays: UNREAD_RETENTION_DAYS
  };
}

module.exports = { purgeOnce, READ_RETENTION_DAYS, UNREAD_RETENTION_DAYS };
