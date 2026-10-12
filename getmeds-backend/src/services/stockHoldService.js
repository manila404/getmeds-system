'use strict';

const db = require('../db/database');
const { hasColumn } = require('./schemaColumns');
const { notify, getUserIdsByRole } = require('./notificationService');

/**
 * Drafts waiting for stock (orders.stock_hold_at). Oct 12, 2026.
 *
 * A draft Management put on hold stays a draft, so nothing else notices it. Every REMIND_DAYS days
 * Management and the MedRep are reminded, so a held order cannot sit forgotten. Runs on the daily
 * cron tick (controllers/cron.controller.js). Does nothing until the columns exist.
 */
const REMIND_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

async function remindDue(now = Date.now()) {
  if (!(await hasColumn('orders', 'stock_hold_at'))) return { reminded: 0, skipped: 'columns not migrated yet' };
  const cutoff = new Date(now - REMIND_DAYS * DAY_MS).toISOString();
  const rows = await db
    .prepare(
      `SELECT o.id, o.getmeds_order_id, o.medrep_id, o.raised_by_id, o.stock_hold_at, o.stock_hold_reason, o.stock_hold_item,
              c.name AS customer_name
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.status = 'draft' AND o.stock_hold_at IS NOT NULL AND o.stock_hold_at <= ?
          AND (o.stock_hold_reminded_at IS NULL OR o.stock_hold_reminded_at <= ?)
          AND o.zoho_so_id IS NULL`
    )
    .all(cutoff, cutoff);

  let reminded = 0;
  const management = await getUserIdsByRole('management', 'admin');
  for (const o of rows) {
    const days = Math.max(REMIND_DAYS, Math.floor((now - Date.parse(o.stock_hold_at)) / DAY_MS));
    const what = o.stock_hold_item ? ` (${o.stock_hold_item})` : '';
    await notify({
      orderId: o.id,
      recipientIds: [...new Set([...management, o.medrep_id, o.raised_by_id].filter(Boolean))],
      message: `Order ${o.getmeds_order_id}${o.customer_name ? ` for ${o.customer_name}` : ''} has been waiting for stock${what} for ${days} days. Check the stock and release it, or cancel it.`,
      eventType: 'STOCK_HOLD_REMINDER',
      orderData: { getmeds_order_id: o.getmeds_order_id, customer_name: o.customer_name, status: 'draft' }
    });
    await db.prepare('UPDATE orders SET stock_hold_reminded_at = ? WHERE id = ?').run(new Date(now).toISOString(), o.id);
    reminded++;
  }
  return { reminded };
}

module.exports = { remindDue, REMIND_DAYS };
