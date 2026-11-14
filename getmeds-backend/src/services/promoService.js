'use strict';

/**
 * Buy 1 Take 1 promos. Nov 14, 2026 (Aaron).
 *
 * Dispatch or Finance announce Buy 1 Take 1 on a product (a stock_announcements row of kind
 * 'promo_b1t1', open until someone ends it). While it is open, every NEW order with that product
 * gets the same product again, free (₱0), in the same quantity as bought: 30 bought, 30 free.
 *
 * The server applies it when the order is created, whatever the form sent: a free line typed by
 * hand is replaced by the correct one, so the free quantity is always exactly the bought quantity,
 * never more. Only products on an open promo are touched. Orders already created are not changed
 * when a promo starts or ends; Management edits those by hand as before.
 */

const db = require('../db/database');
const { tableExists } = require('./schemaColumns');

const PROMO_KIND = 'promo_b1t1';
const FREE_REMARK = 'Buy 1 Take 1 promo (free)';

/** Product ids with an open Buy 1 Take 1 promo. */
async function activeB1T1ProductIds() {
  if (!(await tableExists('stock_announcements'))) return new Set();
  const rows = await db.prepare(
    `SELECT DISTINCT product_id FROM stock_announcements WHERE kind = ? AND resolved_at IS NULL`
  ).all(PROMO_KIND);
  return new Set(rows.map((r) => Number(r.product_id)));
}

/**
 * Pure: the order lines with the free promo lines put right. For each promo product the paid
 * lines (price above ₱0) are kept, any ₱0 line of it is dropped, and one free line is added after
 * the paid ones with the total paid quantity. Returns { lines, added: [{ product_id, name, quantity }] }.
 */
function applyB1T1(lines, promoIds) {
  if (!promoIds || !promoIds.size) return { lines, added: [] };
  // A promo product with no paid line at all (only ₱0 lines, e.g. a free sample) is left as it is.
  const hasPaid = new Set(lines.filter((l) => Number(l.unit_price) > 0).map((l) => Number(l.product_id)));
  const out = [];
  const paid = new Map(); // product_id -> { qty, first paid line }
  for (const l of lines) {
    const pid = Number(l.product_id);
    if (!promoIds.has(pid) || !hasPaid.has(pid)) { out.push(l); continue; }
    if (Number(l.unit_price) > 0) {
      out.push(l);
      const p = paid.get(pid) || { qty: 0, line: l };
      p.qty += Number(l.quantity) || 0;
      paid.set(pid, p);
    }
    // a ₱0 line of a promo product is replaced by the one added below
  }
  const added = [];
  for (const [pid, { qty, line }] of paid) {
    if (qty <= 0) continue;
    out.push({
      ...line,
      quantity: qty,
      unit_price: 0,
      subtotal: 0,
      discount_amount: 0,
      line_total: 0,
      price_remark: FREE_REMARK
    });
    added.push({ product_id: pid, name: line.name, quantity: qty });
  }
  return { lines: out, added };
}

module.exports = { PROMO_KIND, FREE_REMARK, activeB1T1ProductIds, applyB1T1 };
