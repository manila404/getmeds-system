'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');

/**
 * Management's stock check before approving an order. Oct 9, 2026.
 *
 * For each line of the order, how much of that item is available to sell in each Zoho
 * warehouse, so Management can pick the warehouse the order will be sent from (and see
 * at once if it cannot be filled). Read-only: it never changes anything in Zoho or here.
 *
 * "Available for sale" is Zoho's accounting figure: stock on hand minus what is already
 * committed to other open Sales Orders. That is the number Zoho itself compares an order to.
 *
 * Advisory by design. If Zoho cannot be reached, the answer is { available: false } and
 * approval carries on exactly as it did before this existed; a stock check must never be
 * the reason an order cannot be approved.
 *
 * Load: one Zoho read per distinct linked item in the order, cached for a minute, and at
 * most 3 at a time (Zoho refuses more than about 4 in-process requests at once).
 */

const CACHE_MS = 60 * 1000;
const PARALLEL = 3;
const cache = new Map(); // zohoItemId -> { at, warehouses }

async function warehousesOf(zohoItemId) {
  const hit = cache.get(zohoItemId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.warehouses;
  const res = await zoho.getItemWarehouses(zohoItemId);
  const warehouses = res?.warehouses || [];
  cache.set(zohoItemId, { at: Date.now(), warehouses });
  return warehouses;
}

/** For tests: forget everything remembered. */
function _clearCache() {
  cache.clear();
}

async function inBatches(list, size, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(...(await Promise.all(list.slice(i, i + size).map(fn))));
  }
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {number} orderId
 * @param {string|null} requestedWarehouseId  the warehouse to measure against (default: the order's
 *        saved one, else Zoho's main warehouse)
 */
async function checkOrderStock(orderId, requestedWarehouseId = null) {
  const order = await db.prepare('SELECT id, fulfil_warehouse_id FROM orders WHERE id = ?').get(orderId);
  if (!order) return { available: false, reason: 'Order not found.' };

  const lines = await db
    .prepare(
      `SELECT oi.id AS line_id, oi.quantity, oi.fulfil_warehouse_id AS line_warehouse_id, p.id AS product_id, p.name, p.sku, p.unit, p.zoho_item_id
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.id`
    )
    .all(orderId);
  if (!lines.length) return { available: false, reason: 'This order has no items.' };

  const itemIds = [...new Set(lines.map((l) => l.zoho_item_id).filter(Boolean))];
  const failures = new Map(); // zohoItemId -> message
  const stock = new Map(); // zohoItemId -> warehouses[]
  await inBatches(itemIds, PARALLEL, async (id) => {
    try {
      stock.set(id, await warehousesOf(id));
    } catch (err) {
      failures.set(id, err.message);
    }
  });
  if (itemIds.length && failures.size === itemIds.length) {
    return { available: false, reason: `Zoho could not be reached to check stock (${[...failures.values()][0]}).` };
  }

  // Every active warehouse Zoho reports for any of these items, main one first.
  const known = new Map();
  for (const ws of stock.values()) {
    for (const w of ws) {
      if (String(w.status || 'active').toLowerCase() !== 'active') continue;
      if (!known.has(String(w.warehouse_id))) {
        known.set(String(w.warehouse_id), { id: String(w.warehouse_id), name: w.warehouse_name, is_primary: !!w.is_primary });
      }
    }
  }
  const warehouses = [...known.values()].sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  if (!warehouses.length) return { available: false, reason: 'None of this order\'s items is linked to a Zoho item with warehouse stock.' };

  const selectedId =
    [requestedWarehouseId, order.fulfil_warehouse_id].map((x) => (x ? String(x) : null)).find((x) => x && known.has(x)) ||
    (warehouses.find((w) => w.is_primary) || warehouses[0]).id;

  // The same item on two lines is one demand on the shelf.
  const needed = new Map();
  for (const l of lines) if (l.zoho_item_id) needed.set(l.zoho_item_id, (needed.get(l.zoho_item_id) || 0) + num(l.quantity));

  const rows = lines.map((l) => {
    if (!l.zoho_item_id) {
      return { line_id: l.line_id, name: l.name, sku: l.sku, quantity: num(l.quantity), status: 'unknown', note: 'Not linked to a Zoho item.', per_warehouse: [] };
    }
    if (failures.has(l.zoho_item_id)) {
      return { line_id: l.line_id, name: l.name, sku: l.sku, quantity: num(l.quantity), status: 'unknown', note: 'Zoho did not answer for this item.', per_warehouse: [] };
    }
    const need = needed.get(l.zoho_item_id);
    const per = warehouses.map((w) => {
      const z = (stock.get(l.zoho_item_id) || []).find((x) => String(x.warehouse_id) === w.id) || {};
      const available = num(z.warehouse_available_for_sale_stock);
      return {
        warehouse_id: w.id,
        warehouse_name: w.name,
        on_hand: num(z.warehouse_stock_on_hand),
        committed: num(z.warehouse_committed_stock),
        available,
        physical_on_hand: num(z.warehouse_actual_available_stock),
        physical_committed: num(z.warehouse_actual_committed_stock),
        physical_available: num(z.warehouse_actual_available_for_sale_stock),
        enough: available >= need
      };
    });
    // A line with its own warehouse (set in Edit Items) is measured against that one; the rest
    // against the warehouse chosen for the order.
    const ownId = l.line_warehouse_id && known.has(String(l.line_warehouse_id)) ? String(l.line_warehouse_id) : null;
    const effectiveId = ownId || selectedId;
    const here = per.find((p) => p.warehouse_id === effectiveId);
    return {
      line_id: l.line_id,
      product_id: l.product_id,
      name: l.name,
      sku: l.sku,
      unit: l.unit || null,
      quantity: num(l.quantity),
      needed_total: need,
      warehouse_id: effectiveId,
      warehouse_name: (known.get(effectiveId) || {}).name,
      own_warehouse: !!ownId,
      status: here && here.enough ? 'ok' : 'short',
      short_by: here && !here.enough ? need - here.available : 0,
      per_warehouse: per
    };
  });

  // Per warehouse: could it fill every linked line?
  for (const w of warehouses) {
    const mine = rows.filter((r) => r.per_warehouse.length);
    const short = mine.filter((r) => !(r.per_warehouse.find((p) => p.warehouse_id === w.id) || {}).enough);
    w.short_lines = short.length;
    w.fills_all = short.length === 0;
  }

  const sel = warehouses.find((w) => w.id === selectedId);
  return {
    available: true,
    checked_at: new Date().toISOString(),
    selected_warehouse_id: selectedId,
    selected_warehouse_name: sel.name,
    warehouses,
    lines: rows,
    summary: {
      short_lines: rows.filter((r) => r.status === 'short').length,
      unknown_lines: rows.filter((r) => r.status === 'unknown').length,
      all_ok: rows.every((r) => r.status === 'ok')
    }
  };
}

/**
 * Are these per-line warehouse choices real? lines: [{ zoho_item_id, warehouse_id }]. Checks the
 * warehouse is one Zoho lists (active) for that item. Used when Management saves Edit Items.
 * @returns {Promise<{ok:boolean, unavailable?:string, bad?:string[]}>}
 */
async function validateLineWarehouses(lines) {
  const wanted = lines.filter((l) => l.warehouse_id);
  if (!wanted.length) return { ok: true };
  const bad = [];
  const ids = [...new Set(wanted.map((l) => l.zoho_item_id).filter(Boolean))];
  const stock = new Map();
  try {
    await inBatches(ids, PARALLEL, async (id) => stock.set(id, await warehousesOf(id)));
  } catch (err) {
    return { ok: false, unavailable: `Zoho could not be reached to check the warehouse (${err.message}).` };
  }
  for (const l of wanted) {
    const list = l.zoho_item_id ? stock.get(l.zoho_item_id) || [] : [];
    const hit = list.find((w) => String(w.warehouse_id) === String(l.warehouse_id) && String(w.status || 'active').toLowerCase() === 'active');
    if (!hit) bad.push(l.name || l.warehouse_id);
  }
  return bad.length ? { ok: false, bad } : { ok: true };
}

module.exports = { checkOrderStock, validateLineWarehouses, _clearCache };
