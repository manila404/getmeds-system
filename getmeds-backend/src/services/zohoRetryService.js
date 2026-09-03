const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { logEvent } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');
const { buildZohoSalesOrderPayload } = require('./zohoPayloadBuilder');

/**
 * Zoho sync retry/outbox service.
 *
 * Design: orders.controller.js never blocks (or partially writes) an order
 * because Zoho is unreachable. If `zoho.createSalesOrder(...)` rejects, the
 * order is still created/submitted normally with `zoho_sync_status='failed'`,
 * and a row is enqueued here via `enqueue()` (called from inside the same
 * DB transaction that writes the order, so the two can never disagree).
 *
 * This module is the background half: `processQueue()` retries every
 * still-pending row whose backoff window has elapsed, with exponential
 * backoff up to ZOHO_RETRY_MAX_ATTEMPTS, after which the row is marked
 * 'failed_permanent' and Management is notified for manual follow-up
 * (per the QA mandate to explicitly account for Zoho API downtime).
 *
 * `start(intervalMs)` wires this to a setInterval for production/dev use;
 * `processQueue({ force: true })` lets an admin (or a test) trigger an
 * immediate pass on demand — e.g. to demo "Zoho comes back up" live
 * without waiting out the backoff window.
 */

const MAX_ATTEMPTS = parseInt(process.env.ZOHO_RETRY_MAX_ATTEMPTS, 10) || 5;
const BASE_DELAY_MS = parseInt(process.env.ZOHO_RETRY_BASE_DELAY_MS, 10) || 30000; // 30s
const MAX_DELAY_MS = parseInt(process.env.ZOHO_RETRY_MAX_DELAY_MS, 10) || 30 * 60 * 1000; // 30min

function backoffDelayMs(attempts) {
  const delay = BASE_DELAY_MS * Math.pow(2, attempts);
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Queue a failed Zoho sync for retry. Safe to call from inside an open
 * db.transaction() — this is a plain synchronous statement on the same
 * connection, not a new transaction.
 */
async function enqueue({ orderId, payload, error }) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO zoho_sync_queue (order_id, payload, status, attempts, last_error, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)
  `).run(orderId, JSON.stringify(payload), error || null, now, now, now);
}

async function listQueue() {
  return await db.prepare(`
    SELECT q.*, o.getmeds_order_id, o.status as order_status
    FROM zoho_sync_queue q
    LEFT JOIN orders o ON o.id = q.order_id
    ORDER BY q.created_at DESC
  `).all();
}

async function processOne(row) {
  try {
    // Aug 31, 2026: rebuilt fresh from the order's CURRENT state (customer +
    // live order_items) on every attempt — not JSON.parse(row.payload), the
    // one-time snapshot frozen at the moment of the original failure. That
    // frozen snapshot is what made PATCH /api/orders/:id/items ("Edit
    // Items", added the same day to fix a bad line item) invisible to
    // retries: an order could be edited any number of times and every retry
    // would still resend the original, already-corrected-away item. See
    // zohoPayloadBuilder.js for the full story. row.payload is left in the
    // table only as a historical record of what the very first attempt sent.
    const payload = await buildZohoSalesOrderPayload(row.order_id);
    if (!payload) {
      throw new Error(`Order ${row.order_id} no longer exists — cannot retry Zoho sync.`);
    }
    const zohoResult = await zoho.createSalesOrder(payload);
    const now = new Date().toISOString();

    const txn = db.transaction(async () => {
      await db.prepare(`
        UPDATE orders SET zoho_so_id = ?, zoho_so_number = ?, zoho_sync_status = 'synced', updated_at = ?
        WHERE id = ?
      `).run(zohoResult.salesorder.salesorder_id, zohoResult.salesorder.salesorder_number, now, row.order_id);

      await db.prepare(`UPDATE zoho_sync_queue SET status = 'succeeded', updated_at = ? WHERE id = ?`).run(now, row.id);

      await logEvent({
        orderId: row.order_id,
        eventType: 'ZOHO_SYNC_RECOVERED',
        actorName: 'System (Zoho Retry Job)',
        notes: `Zoho SO created on retry attempt #${row.attempts + 1}: ${zohoResult.salesorder.salesorder_number}`
      });
    });
    await txn();

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
    if (order && order.medrep_id) {
      await notify({
        orderId: row.order_id,
        recipientIds: [order.medrep_id],
        message: `Order ${order.getmeds_order_id}'s Zoho Sales Order sync recovered automatically.`,
        eventType: 'ZOHO_SYNC_RECOVERED',
        orderData: order
      });
    }

    return { orderId: row.order_id, queueId: row.id, outcome: 'succeeded' };
  } catch (err) {
    const attempts = row.attempts + 1;
    const now = new Date().toISOString();

    if (attempts >= MAX_ATTEMPTS) {
      await db.prepare(`
        UPDATE zoho_sync_queue SET status = 'failed_permanent', attempts = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(attempts, err.message, now, row.id);

      await logEvent({
        orderId: row.order_id,
        eventType: 'ZOHO_SYNC_FAILED_PERMANENT',
        actorName: 'System (Zoho Retry Job)',
        notes: `Gave up after ${attempts} attempts: ${err.message}`
      });

      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
      const mgmtIds = await getUserIdsByRole('management', 'admin');
      if (order && mgmtIds.length) {
        await notify({
          orderId: row.order_id,
          recipientIds: mgmtIds,
          message: `Order ${order.getmeds_order_id} could not be synced to Zoho after ${attempts} attempts. Manual intervention required.`,
          eventType: 'ZOHO_SYNC_FAILED_PERMANENT',
          orderData: order
        });
      }

      return { orderId: row.order_id, queueId: row.id, outcome: 'failed_permanent', error: err.message };
    }

    const nextAttemptAt = new Date(Date.now() + backoffDelayMs(attempts)).toISOString();
    await db.prepare(`
      UPDATE zoho_sync_queue SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?
    `).run(attempts, err.message, nextAttemptAt, now, row.id);

    await logEvent({
      orderId: row.order_id,
      eventType: 'ZOHO_SYNC_RETRY_FAILED',
      actorName: 'System (Zoho Retry Job)',
      notes: `Attempt #${attempts} failed: ${err.message}. Next retry at ${nextAttemptAt}.`
    });

    return { orderId: row.order_id, queueId: row.id, outcome: 'retry_scheduled', error: err.message, nextAttemptAt };
  }
}

/**
 * Process all eligible pending rows. Pass { force: true } to ignore each
 * row's backoff window (used by the on-demand admin/test endpoint).
 */
async function processQueue({ force = false } = {}) {
  const now = new Date().toISOString();
  const rows = force
    ? await db.prepare(`SELECT * FROM zoho_sync_queue WHERE status = 'pending' ORDER BY created_at ASC`).all()
    : await db.prepare(`SELECT * FROM zoho_sync_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC`).all(now);

  const results = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential, low volume, avoids hammering Zoho concurrently
    results.push(await processOne(row));
  }
  return results;
}

let intervalHandle = null;

/** Start the background polling loop. No-op if already started. */
function start(intervalMs = parseInt(process.env.ZOHO_RETRY_INTERVAL_MS, 10) || 30000) {
  if (intervalHandle) return intervalHandle;
  intervalHandle = setInterval(async () => {
    (await processQueue()).catch((err) => console.error('[ZOHO_RETRY] queue processing error:', err.message));
  }, intervalMs);
  if (intervalHandle.unref) intervalHandle.unref();
  return intervalHandle;
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { enqueue, listQueue, processQueue, processOne, start, stop, MAX_ATTEMPTS };
