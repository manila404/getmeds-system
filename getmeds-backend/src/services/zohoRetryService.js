const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { logEvent } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');
const { buildZohoSalesOrderPayload } = require('./zohoPayloadBuilder');
const { pushUnsyncedAttachments } = require('./zohoAttachmentSync');
// Sep 22, 2026: split-invoicing orders — see this file's own processOne/
// processSplitRetry notes below and services/orderSplitService.js.
const { groupItemsByInvoicingFrom } = require('./orderSplitService');

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
 *
 * Sep 22, 2026: `invoicingFrom` — omitted (or null), this retries the
 * order's PRIMARY Sales Order, exactly as before this parameter existed. A
 * value queues a retry for that split-invoicing entity's own Sales Order
 * instead — see services/orderSplitService.js.
 */
async function enqueue({ orderId, payload, error, invoicingFrom }) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO zoho_sync_queue (order_id, payload, status, attempts, last_error, next_attempt_at, created_at, updated_at, invoicing_from)
    VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?)
  `).run(orderId, JSON.stringify(payload), error || null, now, now, now, invoicingFrom || null);
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
  // Sep 22, 2026: a split-invoicing entity's own retry — see
  // services/orderSplitService.js. Everything below this point is the
  // PRIMARY path, unchanged from before this branch existed; a row with no
  // invoicing_from (every row before today, and the overwhelming majority
  // since) never reaches processSplitRetry at all.
  if (row.invoicing_from) return await processSplitRetry(row);

  try {
    // Sep 14, 2026: never a second Sales Order. This retries a CREATE, and
    // an order that already carries a Zoho id has been created — by an earlier
    // attempt, or by a retry that raced this one. Re-creating would put a
    // second Sales Order in Zoho and point the order at it, stranding the
    // first. The row's job is done, so it is closed as such.
    const existing = await db.prepare('SELECT zoho_so_id, zoho_so_number FROM orders WHERE id = ?').get(row.order_id);
    if (existing && existing.zoho_so_id) {
      await db.prepare(`UPDATE zoho_sync_queue SET status = 'succeeded', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), row.id);
      return { orderId: row.order_id, queueId: row.id, outcome: 'already_in_zoho', zohoSoNumber: existing.zoho_so_number };
    }

    // Aug 31, 2026: rebuilt fresh from the order's CURRENT state (customer +
    // live order_items) on every attempt — not JSON.parse(row.payload), the
    // one-time snapshot frozen at the moment of the original failure. That
    // frozen snapshot is what made PATCH /api/orders/:id/items ("Edit
    // Items", added the same day to fix a bad line item) invisible to
    // retries: an order could be edited any number of times and every retry
    // would still resend the original, already-corrected-away item. See
    // zohoPayloadBuilder.js for the full story. row.payload is left in the
    // table only as a historical record of what the very first attempt sent.
    //
    // Sep 22, 2026: filtered to the PRIMARY's own items before rebuilding —
    // without this, a primary retry on a split-invoicing order would bundle
    // the split entity's items onto the PRIMARY's Sales Order too (fetching
    // order_items unfiltered is exactly what buildZohoSalesOrderPayload does
    // with no override). For an order with no split this is simply every
    // item, so the payload is identical to before this filtering existed.
    const orderRow = await db.prepare('SELECT invoicing_from FROM orders WHERE id = ?').get(row.order_id);
    if (!orderRow) {
      throw new Error(`Order ${row.order_id} no longer exists — cannot retry Zoho sync.`);
    }
    const allItems = await db.prepare(`
      SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit
        FROM order_items oi
        LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?
    `).all(row.order_id);
    const { primaryItems } = groupItemsByInvoicingFrom(allItems, orderRow.invoicing_from);
    const payload = await buildZohoSalesOrderPayload(row.order_id, { items: primaryItems });
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

    // Sep 21, 2026: same reasoning as syncOrderToZohoAndFinalize's own call —
    // this order may have gathered attachments (proof of payment, etc.)
    // during however long it sat in the retry queue with no zoho_so_id to
    // push them to. Catch them up now that one finally exists.
    try {
      await pushUnsyncedAttachments(row.order_id, zohoResult.salesorder.salesorder_id);
    } catch (err) {
      console.warn(`[ZOHO_RETRY] pushUnsyncedAttachments failed for order ${row.order_id}:`, err.message);
    }

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
 * Sep 22, 2026: the split-invoicing counterpart to `processOne` above —
 * same shape (already-synced guard, rebuild-fresh-from-the-database
 * payload, success write-back, exponential backoff, give-up-and-notify),
 * targeting `order_split_sales_orders` instead of `orders`. Kept as its own
 * function rather than branching deep inside `processOne` so the primary
 * path — every row before this feature existed, and the overwhelming
 * majority since — stays exactly as it was, unread and unrisked by this.
 */
async function processSplitRetry(row) {
  try {
    // Same "never a second Sales Order" guard as processOne, scoped to
    // this split's own row instead of the orders table.
    const existing = await db
      .prepare('SELECT zoho_so_id, zoho_so_number FROM order_split_sales_orders WHERE order_id = ? AND invoicing_from = ?')
      .get(row.order_id, row.invoicing_from);
    if (existing && existing.zoho_so_id) {
      await db.prepare(`UPDATE zoho_sync_queue SET status = 'succeeded', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), row.id);
      return { orderId: row.order_id, queueId: row.id, outcome: 'already_in_zoho', zohoSoNumber: existing.zoho_so_number };
    }

    // Rebuilt fresh, same reasoning as processOne: this split's own items
    // as they stand NOW, not a frozen snapshot from the original failure.
    const splitItems = await db
      .prepare(
        `SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit
           FROM order_items oi
           LEFT JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = ? AND oi.invoicing_from = ?`
      )
      .all(row.order_id, row.invoicing_from);
    if (!splitItems.length) {
      throw new Error(`Order ${row.order_id} has no items left tagged for ${row.invoicing_from} — cannot retry this split's Zoho sync.`);
    }

    const payload = await buildZohoSalesOrderPayload(row.order_id, { items: splitItems, invoicingFrom: row.invoicing_from });
    if (!payload) {
      throw new Error(`Order ${row.order_id} no longer exists — cannot retry Zoho sync.`);
    }
    const zohoResult = await zoho.createSalesOrder(payload);
    const now = new Date().toISOString();

    const txn = db.transaction(async () => {
      await db.prepare(`
        UPDATE order_split_sales_orders
           SET zoho_so_id = ?, zoho_so_number = ?, zoho_sync_status = 'synced', zoho_sync_error = NULL, updated_at = ?
         WHERE order_id = ? AND invoicing_from = ?
      `).run(zohoResult.salesorder.salesorder_id, zohoResult.salesorder.salesorder_number, now, row.order_id, row.invoicing_from);

      await db.prepare(`UPDATE zoho_sync_queue SET status = 'succeeded', updated_at = ? WHERE id = ?`).run(now, row.id);

      await logEvent({
        orderId: row.order_id,
        eventType: 'ZOHO_SYNC_RECOVERED',
        actorName: 'System (Zoho Retry Job)',
        notes: `Zoho SO created on retry attempt #${row.attempts + 1} for ${row.invoicing_from}: ${zohoResult.salesorder.salesorder_number}`
      });
    });
    await txn();

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
    if (order && order.medrep_id) {
      await notify({
        orderId: row.order_id,
        recipientIds: [order.medrep_id],
        message: `Order ${order.getmeds_order_id}'s ${row.invoicing_from} Sales Order sync recovered automatically.`,
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
      await db.prepare(`UPDATE order_split_sales_orders SET zoho_sync_status = 'failed', zoho_sync_error = ?, updated_at = ? WHERE order_id = ? AND invoicing_from = ?`)
        .run(err.message, now, row.order_id, row.invoicing_from);

      await logEvent({
        orderId: row.order_id,
        eventType: 'ZOHO_SYNC_FAILED_PERMANENT',
        actorName: 'System (Zoho Retry Job)',
        notes: `Gave up on ${row.invoicing_from} after ${attempts} attempts: ${err.message}`
      });

      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
      const mgmtIds = await getUserIdsByRole('management', 'admin');
      if (order && mgmtIds.length) {
        await notify({
          orderId: row.order_id,
          recipientIds: mgmtIds,
          message: `Order ${order.getmeds_order_id}'s ${row.invoicing_from} Sales Order could not be synced to Zoho after ${attempts} attempts. Manual intervention required.`,
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
      notes: `Attempt #${attempts} on ${row.invoicing_from} failed: ${err.message}. Next retry at ${nextAttemptAt}.`
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
  intervalHandle = setInterval(() => {
    processQueue().catch((err) => console.error('[ZOHO_RETRY] queue processing error:', err.message));
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
