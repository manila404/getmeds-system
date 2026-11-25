'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { isKnownCspProductName } = require('../constants/cspCatalog');
const { classifyOrder, normalizeEntityKey } = require('./orderClassificationService');
const { hasColumn } = require('./schemaColumns');
const { logEvent, resolveActor } = require('./auditService');
const { setCustomerTin, refreshCustomerComplianceFromZoho } = require('./customerTinService');
const zohoQuotaGuard = require('./zohoQuotaGuard');

class DispatchBatchError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'DispatchBatchError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

function manilaTodayDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const ITEM_BATCH_CACHE_TTL_MS = 3 * 60 * 1000;
const itemBatchCacheByAdapter = new WeakMap();

function isNonBatchSupplyName(name = '') {
  return /^packaging\b/i.test(String(name || '').trim());
}

function isZohoRateLimitOrUnavailable(err) {
  if (!err) return false;
  if (zohoQuotaGuard.isZohoDailyLimitError(err)) return true;
  if (err.isRateLimit || err.zohoUnavailable) return true;
  if (err.httpStatus === 429 || err.httpStatus >= 500) return true;
  const msg = String(err.message || '');
  return /rate limit|timed out|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg);
}

function invalidateItemBatchesCache(zohoItemIds = [], adapter = zoho) {
  const cache = getAdapterCache(itemBatchCacheByAdapter, adapter);
  if (!Array.isArray(zohoItemIds) || !zohoItemIds.length) {
    cache.clear();
    return;
  }
  for (const zid of zohoItemIds) {
    if (zid) cache.delete(String(zid));
  }
}

function getAdapterCache(map, adapter) {
  const key = adapter && typeof adapter === 'object' ? adapter : zoho;
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

/**
 * Extract warehouse-specific remaining quantity from a Zoho Inventory batch object.
 * Confirmed live: Zoho's /items/batches?item_id= returns top-level `warehouse_id: ""`
 * and per-warehouse quantities inside `associated_warehouses[]`.
 */
function warehouseBalanceForBatch(batch, warehouseId) {
  if (!batch) return 0;
  const assoc = Array.isArray(batch.associated_warehouses) ? batch.associated_warehouses : [];
  if (warehouseId) {
    if (assoc.length > 0) {
      const match = assoc.find((w) => String(w.warehouse_id) === String(warehouseId));
      return match ? Number(match.balance_quantity || 0) : 0;
    }
    if (batch.warehouse_id) {
      return String(batch.warehouse_id) === String(warehouseId) ? Number(batch.balance_quantity || 0) : 0;
    }
    return 0;
  }
  return Number(batch.balance_quantity || 0);
}

/**
 * Filter active batches for a target physical warehouse and sort FEFO (earliest expiry first).
 * Expired batches (`expiry_date < today`) are tagged `is_expired: true` and placed after valid ones.
 */
function filterAndSortBatchesForWarehouse(zohoBatches = [], warehouseId = null, { today = manilaTodayDate() } = {}) {
  const out = [];
  for (const b of zohoBatches) {
    if (String(b.status || 'active').toLowerCase() === 'inactive') continue;
    const avail = warehouseBalanceForBatch(b, warehouseId);
    if (avail <= 0) continue;
    const expiry = b.expiry_date ? String(b.expiry_date).slice(0, 10) : null;
    const isExpired = Boolean(expiry && expiry < today);
    out.push({
      zoho_batch_id: b.batch_id ? String(b.batch_id) : null,
      zoho_batch_in_id: b.batch_in_id ? String(b.batch_in_id) : null,
      batch_number: String(b.batch_number || ''),
      manufacturer_batch_no: b.manufacturer_batch_number ? String(b.manufacturer_batch_number) : null,
      manufactured_date: b.manufactured_date ? String(b.manufactured_date).slice(0, 10) : null,
      expiry_date: expiry,
      warehouse_id: warehouseId ? String(warehouseId) : (b.warehouse_id ? String(b.warehouse_id) : null),
      available_quantity: avail,
      is_expired: isExpired
    });
  }

  out.sort((a, b) => {
    if (a.is_expired !== b.is_expired) return a.is_expired ? 1 : -1;
    if (a.expiry_date && b.expiry_date) {
      if (a.expiry_date !== b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : 1;
    } else if (a.expiry_date || b.expiry_date) {
      return a.expiry_date ? -1 : 1;
    }
    return a.batch_number.localeCompare(b.batch_number);
  });

  return out;
}

/**
 * Suggest a single valid FEFO batch that can fulfill the entire `requiredQty` (matching
 * operational Zoho picking: 1 batch per medicine line). If no single batch covers the
 * full quantity, return the earliest-expiring partial lot and flag `no_single_batch`
 * so Dispatch can Hold the order or manually split only if approved.
 */
function suggestFefoPicks(sortedBatches = [], requiredQty = 0) {
  const req = Number(requiredQty || 0);
  if (req <= 0) return { picks: [], unallocated_quantity: 0, no_single_batch: false };

  const valid = sortedBatches.filter((b) => !b.is_expired && Number(b.available_quantity || 0) > 0);
  if (!valid.length) return { picks: [], unallocated_quantity: req, no_single_batch: true };

  // Prefer the earliest-expiring (FEFO) batch that can fulfill the entire order line in one lot.
  const singleFull = valid.find((b) => Number(b.available_quantity || 0) >= req);
  if (singleFull) {
    return {
      picks: [{
        zoho_batch_id: singleFull.zoho_batch_id,
        zoho_batch_in_id: singleFull.zoho_batch_in_id,
        batch_number: singleFull.batch_number,
        manufacturer_batch_no: singleFull.manufacturer_batch_no,
        manufactured_date: singleFull.manufactured_date,
        expiry_date: singleFull.expiry_date,
        warehouse_id: singleFull.warehouse_id,
        quantity: req
      }],
      unallocated_quantity: 0,
      no_single_batch: false
    };
  }

  // No single batch can cover the full quantity: pre-fill the first valid batch with its
  // available qty and report the shortfall so Dispatch can Hold the order (or split manually).
  const first = valid[0];
  const take = Math.min(req, Number(first.available_quantity));
  return {
    picks: [{
      zoho_batch_id: first.zoho_batch_id,
      zoho_batch_in_id: first.zoho_batch_in_id,
      batch_number: first.batch_number,
      manufacturer_batch_no: first.manufacturer_batch_no,
      manufactured_date: first.manufactured_date,
      expiry_date: first.expiry_date,
      warehouse_id: first.warehouse_id,
      quantity: take
    }],
    unallocated_quantity: Math.max(0, req - take),
    no_single_batch: true
  };
}

/**
 * Validate submitted batch allocations keyed strictly by `order_item_id` (B1T1-safe).
 * Rejects expired lots, unknown/out-of-warehouse batches, negative qty, over-allocation,
 * and partial totals when warehouse batches exist for a non-CSP item.
 */
function validatePickedBatches({ items = [], picksByItemId = new Map(), availableBatchesByItemId = new Map(), today = manilaTodayDate() } = {}) {
  const normalized = [];
  // Track batch consumption across ALL lines of the order (e.g. Buy-1-Take-1 duplicate items)
  // so two lines cannot both allocate the same remaining stock in the same warehouse.
  const seenBatchUsage = new Map();

  for (const it of items) {
    const isCsp = Number(it.is_csp) === 1 || it.is_csp === true || isKnownCspProductName(it.product_name || it.name);
    const itemPicks = picksByItemId.get(Number(it.id)) || [];
    const availList = availableBatchesByItemId.get(Number(it.id)) || [];

    if (isCsp && itemPicks.length === 0) continue;

    if (!itemPicks.length) {
      if (availList.some((b) => !b.is_expired && Number(b.available_quantity) > 0)) {
        throw new DispatchBatchError(
          422,
          'BATCH_SELECTION_REQUIRED',
          `Please select batch allocation(s) for "${it.product_name || it.name}" (qty ${it.quantity}).`
        );
      }
      continue;
    }

    const byBatchKey = new Map();
    for (const b of availList) {
      byBatchKey.set(String(b.batch_number), b);
      if (b.zoho_batch_id) byBatchKey.set(String(b.zoho_batch_id), b);
    }

    let pickedSum = 0;
    for (const p of itemPicks) {
      const qty = Number(p.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new DispatchBatchError(422, 'INVALID_BATCH_QTY', `Batch quantity for "${it.product_name || it.name}" must be greater than 0.`);
      }

      const match = (p.zoho_batch_id && byBatchKey.get(String(p.zoho_batch_id)))
        || (p.batch_number && byBatchKey.get(String(p.batch_number)));
      if (!match) {
        throw new DispatchBatchError(
          422,
          'BATCH_NOT_IN_WAREHOUSE',
          `Batch "${p.batch_number || p.zoho_batch_id}" is not available in "${it.fulfil_warehouse_name || 'assigned warehouse'}" for "${it.product_name || it.name}".`
        );
      }

      const exp = match.expiry_date || (p.expiry_date ? String(p.expiry_date).slice(0, 10) : null);
      if (exp && exp < today) {
        throw new DispatchBatchError(
          422,
          'EXPIRED_BATCH_FORBIDDEN',
          `Batch "${match.batch_number}" expired on ${exp} and cannot be picked.`
        );
      }

      // A packaging batch taken from another warehouse (see supplyFallbackBatches) is
      // counted, saved and invoiced against the warehouse that holds it.
      const pickWarehouseId = match.other_warehouse
        ? match.warehouse_id
        : (it.effective_warehouse_id || match.warehouse_id || null);
      const poolKey = `${pickWarehouseId || 'DEFAULT'}::${it.zoho_item_id || it.product_id || ''}::${match.batch_number}`;
      const prevUsed = seenBatchUsage.get(poolKey) || 0;
      const nextUsed = prevUsed + qty;
      if (nextUsed > Number(match.available_quantity)) {
        throw new DispatchBatchError(
          422,
          'INSUFFICIENT_BATCH_STOCK',
          `Batch "${match.batch_number}" only has ${match.available_quantity} available in warehouse, cannot take ${nextUsed}.`
        );
      }
      seenBatchUsage.set(poolKey, nextUsed);
      pickedSum += qty;

      normalized.push({
        order_item_id: Number(it.id),
        zoho_item_id: it.zoho_item_id || null,
        zoho_batch_id: match.zoho_batch_id || p.zoho_batch_id || null,
        zoho_batch_in_id: match.zoho_batch_in_id || p.zoho_batch_in_id || null,
        batch_number: match.batch_number,
        manufacturer_batch_no: match.manufacturer_batch_no || p.manufacturer_batch_no || null,
        manufactured_date: match.manufactured_date || p.manufactured_date || null,
        expiry_date: exp,
        warehouse_id: pickWarehouseId,
        warehouse_name: match.other_warehouse ? null : (it.effective_warehouse_name || null),
        quantity: qty
      });
    }

    if (Math.abs(pickedSum - Number(it.quantity)) > 1e-6) {
      throw new DispatchBatchError(
        422,
        'BATCH_QTY_MISMATCH',
        `Total picked batch qty (${pickedSum}) must equal ordered qty (${it.quantity}) for "${it.product_name || it.name}".`
      );
    }
  }

  return normalized;
}

/**
 * Strict validation when Zoho Inventory API is unreachable/rate-limited and Dispatch enters
 * manual Batch # + Expiry Date from physical stock / Zoho web UI. Rejects empty batch numbers,
 * placeholders ("N/A"), missing/expired expiry dates, non-positive quantities, and qty mismatches.
 */
function validateManualFallbackBatches({ items = [], picksByItemId = new Map(), today = manilaTodayDate() } = {}) {
  const normalized = [];
  for (const it of items) {
    const label = it.product_name || it.name || `Item #${it.id}`;
    const isCsp = Number(it.is_csp) === 1 || it.is_csp === true || isKnownCspProductName(label);
    const isSupply = isNonBatchSupplyName(label);
    const itemPicks = picksByItemId.get(Number(it.id)) || [];

    if ((isCsp || isSupply) && itemPicks.length === 0) continue;

    if (!itemPicks.length) {
      throw new DispatchBatchError(
        422,
        'BATCH_SELECTION_REQUIRED',
        `Please enter Batch # and Expiry Date for "${label}" (qty ${it.quantity}).`
      );
    }

    let pickedSum = 0;
    for (const p of itemPicks) {
      const batchNo = String(p.batch_number || '').trim();
      if (batchNo.length < 2 || /^(n\/a|na|none|tbd|-+)$/i.test(batchNo)) {
        throw new DispatchBatchError(
          422,
          'INVALID_BATCH_NUMBER',
          `Enter a valid Batch # for "${label}".`
        );
      }
      const exp = p.expiry_date ? String(p.expiry_date).slice(0, 10) : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) {
        throw new DispatchBatchError(
          422,
          'INVALID_EXPIRY_DATE',
          `Enter a valid Expiry Date (YYYY-MM-DD) for "${label}" batch "${batchNo}".`
        );
      }
      if (exp < today) {
        throw new DispatchBatchError(
          422,
          'EXPIRED_BATCH_FORBIDDEN',
          `Batch "${batchNo}" expired on ${exp} and cannot be picked.`
        );
      }
      const qty = Number(p.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new DispatchBatchError(
          422,
          'INVALID_BATCH_QTY',
          `Batch quantity for "${label}" must be greater than 0.`
        );
      }
      pickedSum += qty;
      normalized.push({
        order_item_id: Number(it.id),
        zoho_item_id: it.zoho_item_id || null,
        zoho_batch_id: p.zoho_batch_id || null,
        zoho_batch_in_id: p.zoho_batch_in_id || null,
        batch_number: batchNo,
        manufacturer_batch_no: p.manufacturer_batch_no || null,
        manufactured_date: p.manufactured_date || null,
        expiry_date: exp,
        warehouse_id: it.effective_warehouse_id || p.warehouse_id || null,
        warehouse_name: it.effective_warehouse_name || null,
        quantity: qty
      });
    }

    if (Math.abs(pickedSum - Number(it.quantity)) > 1e-6) {
      throw new DispatchBatchError(
        422,
        'BATCH_QTY_MISMATCH',
        `Total picked batch qty (${pickedSum}) must equal ordered qty (${it.quantity}) for "${label}".`
      );
    }
  }
  return normalized;
}

/**
 * Stale-tab & multi-user safeguard: blocks writes if another dispatcher caters the
 * order or if the order updated since the user's modal opened.
 */
async function assertCanActOnOrder({ orderId, user, expectedUpdatedAt = null, expectedCateredBy = null }) {
  const order = await db.prepare('SELECT id, getmeds_order_id, status, updated_at FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new DispatchBatchError(404, 'NOT_FOUND', 'Order not found.');

  const latestCater = await db.prepare(`
    SELECT event_type, actor_id, actor_name, created_at
      FROM order_events
     WHERE order_id = ? AND event_type IN ('DISPATCH_CATERED', 'DISPATCH_RELEASED')
     ORDER BY id DESC LIMIT 1
  `).get(orderId);

  const currentCaterer = latestCater && latestCater.event_type === 'DISPATCH_CATERED' ? latestCater : null;
  if (currentCaterer && Number(currentCaterer.actor_id) !== Number(user?.id)) {
    throw new DispatchBatchError(
      409,
      'CATERED_BY_ANOTHER',
      `Order ${order.getmeds_order_id} is currently handled by ${currentCaterer.actor_name}. Click "Take Over" on the order before making changes.`,
      { current_caterer: currentCaterer }
    );
  }

  if (expectedCateredBy !== null && expectedCateredBy !== undefined && expectedCateredBy !== '') {
    const currentId = currentCaterer ? Number(currentCaterer.actor_id) : null;
    if (currentId !== Number(expectedCateredBy)) {
      throw new DispatchBatchError(
        409,
        'STALE_STATE',
        `Someone else took over order ${order.getmeds_order_id}. Click Refresh to check who is handling it.`
      );
    }
  }

  if (expectedUpdatedAt && order.updated_at && String(order.updated_at) !== String(expectedUpdatedAt)) {
    throw new DispatchBatchError(
      409,
      'STALE_STATE',
      `Order ${order.getmeds_order_id} was just updated. Click Refresh to load the latest details before saving.`
    );
  }

  return { order, currentCaterer };
}

async function loadOrderWithItemsForBatches(orderId) {
  const hasDrCols = await hasColumn('orders', 'requires_si');
  const prodHasCsp = await hasColumn('products', 'is_csp');
  const drOrderCols = hasDrCols
    ? ', o.requires_si, o.requires_dr, o.is_csp, o.si_override_reason, o.dispatch_doctor_name, o.oojeema_si_number, o.oojeema_entity, o.slip_printed_by_name, o.slip_printed_at, o.slip_print_count'
    : '';
  const order = await db.prepare(`
    SELECT o.id, o.getmeds_order_id, o.customer_id, o.status, o.division, o.intake_source, o.invoicing_from,
           o.intake_gl_number, o.intake_payment_terms, o.intake_is_doctor, o.intake_doctor,
           o.intake_tin, o.intake_delivery_method,
           o.delivery_address, o.zoho_so_id, o.zoho_so_number, o.zoho_invoice_id, o.zoho_invoice_number,
           o.fulfil_warehouse_id, o.fulfil_warehouse_name, o.updated_at,
           c.name AS customer_name, c.zoho_contact_id,
           COALESCE(NULLIF(TRIM(c.tin), ''), NULLIF(TRIM(o.intake_tin), '')) AS tin,
           c.lto_license_number, c.category AS customer_category,
           d.zoho_package_id, d.zoho_package_number, d.zoho_shipment_id, d.zoho_shipment_number,
           d.courier, d.tracking_number${drOrderCols}
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN dispatch_records d ON d.order_id = o.id
     WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new DispatchBatchError(404, 'NOT_FOUND', 'Order not found.');

  const items = await db.prepare(`
    SELECT oi.id, oi.order_id, oi.product_id, oi.quantity, oi.unit_price, oi.subtotal, oi.invoicing_from,
           oi.fulfil_warehouse_id, oi.fulfil_warehouse_name,
           p.name AS product_name, p.sku, p.unit, p.zoho_item_id${prodHasCsp ? ', p.is_csp' : ''}
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?
     ORDER BY oi.id
  `).all(order.id);

  const enrichedItems = items.map((it) => ({
    ...it,
    effective_warehouse_id: it.fulfil_warehouse_id || order.fulfil_warehouse_id || null,
    effective_warehouse_name: it.fulfil_warehouse_name || order.fulfil_warehouse_name || null
  }));

  const hasDrTable = await hasColumn('delivery_receipts', 'dr_number');
  const [glProofs, splits, activeDrs, latestTrackingEvent] = await Promise.all([
    db.prepare("SELECT file_type FROM payment_proofs WHERE order_id = ? AND lower(file_type) = 'gl' LIMIT 1").all(order.id),
    db.prepare(`
      SELECT id, order_id, invoicing_from, zoho_so_id, zoho_so_number, zoho_so_status,
             zoho_sync_status, zoho_sync_error, zoho_invoice_id, zoho_invoice_number,
             zoho_invoiced_status, zoho_package_id, zoho_package_number,
             zoho_shipment_id, zoho_shipment_number, zoho_shipped_status, payment_status
        FROM order_split_sales_orders
       WHERE order_id = ?
       ORDER BY id
    `).all(order.id),
    hasDrTable
      ? db.prepare(`
          SELECT id, entity_key, dr_number, external_ref, si_number, status, date_issued, doctor_name, printed_at, print_count
            FROM delivery_receipts
           WHERE order_id = ? AND status IN ('draft', 'issued')
           ORDER BY id
        `).all(order.id)
      : Promise.resolve([]),
    db.prepare(`
      SELECT actor_name, created_at, metadata
        FROM order_events
       WHERE order_id = ? AND event_type = 'DISPATCH_TRACKING_ADDED'
       ORDER BY id DESC LIMIT 1
    `).get(order.id)
  ]);

  let enteredTracking = null;
  if (latestTrackingEvent?.metadata) {
    try {
      const meta = JSON.parse(latestTrackingEvent.metadata);
      if (meta?.tracking_number || meta?.courier) {
        enteredTracking = {
          courier: meta.courier || null,
          tracking_number: meta.tracking_number || null,
          by: latestTrackingEvent.actor_name || null,
          at: latestTrackingEvent.created_at || null
        };
      }
    } catch {
      enteredTracking = null;
    }
  }
  order.entered_tracking = enteredTracking;

  const classification = classifyOrder({
    order,
    customer: { category: order.customer_category },
    items: enrichedItems,
    paymentProofs: glProofs,
    splits
  });

  return { order, items: enrichedItems, classification, splits, activeDrs };
}

async function fetchWarehouseBatchesForItems(
  items,
  { adapter = zoho, today = manilaTodayDate(), failSoft = false, forceRefresh = false } = {}
) {
  const uniqueZohoIds = Array.from(new Set(items.map((it) => it.zoho_item_id).filter(Boolean)));
  const cache = getAdapterCache(itemBatchCacheByAdapter, adapter);
  const recentDailyLimit = !forceRefresh ? await zohoQuotaGuard.getDailyLimitStatus() : { limited: false };

  const rawByZohoId = new Map();
  let zohoUnavailable = false;
  let zohoError = null;

  if (recentDailyLimit.limited && uniqueZohoIds.some((zid) => {
    const c = cache.get(String(zid));
    return !c || c.expiresAt <= Date.now();
  })) {
    zohoUnavailable = true;
    zohoError = recentDailyLimit.reason;
    if (!failSoft) {
      const err = new Error(zohoError);
      err.zohoUnavailable = true;
      err.isRateLimit = true;
      throw err;
    }
  }

  if (!zohoUnavailable) {
    await Promise.all(
      uniqueZohoIds.map(async (zid) => {
        const key = String(zid);
        const cached = !forceRefresh ? cache.get(key) : null;
        if (cached && cached.expiresAt > Date.now()) {
          rawByZohoId.set(key, cached.batches);
          return;
        }
        try {
          const res = await adapter.getItemBatches(zid);
          const batches = res?.batches || [];
          cache.set(key, { batches, expiresAt: Date.now() + ITEM_BATCH_CACHE_TTL_MS });
          rawByZohoId.set(key, batches);
        } catch (err) {
          if (zohoQuotaGuard.isZohoDailyLimitError(err)) {
            await zohoQuotaGuard.tripDailyLimit(err.message);
          }
          if (!failSoft) throw err;
          if (isZohoRateLimitOrUnavailable(err)) {
            zohoUnavailable = true;
            if (!zohoError) zohoError = err.message;
          } else {
            throw err;
          }
        }
      })
    );
    if (!zohoUnavailable && forceRefresh) {
      await zohoQuotaGuard.clearDailyLimit();
    }
  }

  const availableBatchesByItemId = new Map();
  const stockElsewhereByItemId = new Map();
  for (const it of items) {
    const raw = it.zoho_item_id ? (rawByZohoId.get(String(it.zoho_item_id)) || []) : [];
    const sorted = filterAndSortBatchesForWarehouse(raw, it.effective_warehouse_id, { today });
    if (!sorted.length && it.effective_warehouse_id && isNonBatchSupplyName(it.product_name || it.name)) {
      const elsewhere = supplyFallbackBatches(raw, { today })
        .filter((b) => String(b.warehouse_id) !== String(it.effective_warehouse_id));
      const qty = elsewhere.reduce((s, b) => s + Number(b.available_quantity || 0), 0);
      if (qty > 0) stockElsewhereByItemId.set(Number(it.id), qty);
    }
    availableBatchesByItemId.set(Number(it.id), sorted);
  }
  return { availableBatchesByItemId, stockElsewhereByItemId, zohoUnavailable, zohoError };
}

/**
 * Nov 25, 2026: packaging (e.g. "Packaging : Cake Roll with Cover-Styro") is
 * batch-tracked in Zoho — one batch "NA", stocked in the main GPI warehouse
 * only. An order shipped from another warehouse (Davao) found no batch there,
 * sent the line without one, and Zoho refused the invoice ("The batch number
 * cannot be left empty").
 *
 * Taking the batch from the main warehouse instead does not work either: Zoho
 * refuses an invoice line whose warehouse differs from its Sales Order line
 * ("Warehouse cannot be changed in a invoice generated from a sales order").
 * So this only tells WHERE the stock is: the line shows it, and invoicing
 * stops with a clear message — the stock has to be transferred in Zoho to the
 * warehouse the order ships from.
 */
function supplyFallbackBatches(zohoBatches = [], { today = manilaTodayDate() } = {}) {
  const out = [];
  for (const b of zohoBatches) {
    const assoc = Array.isArray(b.associated_warehouses) && b.associated_warehouses.length
      ? b.associated_warehouses
      : (b.warehouse_id ? [{ warehouse_id: b.warehouse_id }] : []);
    for (const w of assoc) {
      if (!w.warehouse_id) continue;
      for (const x of filterAndSortBatchesForWarehouse([b], w.warehouse_id, { today })) {
        out.push({ ...x, other_warehouse: true });
      }
    }
  }
  out.sort((a, b) => (a.is_expired !== b.is_expired ? (a.is_expired ? 1 : -1) : Number(b.available_quantity) - Number(a.available_quantity)));
  return out;
}

/**
 * Nov 25, 2026: at "Convert to Zoho Invoice", a packaging line with no batch
 * saved gets one picked from its own warehouse and saved automatically, so
 * the invoice never sends it to Zoho empty. A packaging pick saved from a
 * different warehouse (b12466d did that) is dropped first — Zoho refuses it.
 * When the packaging is only stocked in another warehouse, this stops with a
 * clear message instead of Zoho's.
 */
async function autoPickSupplyBatches({ orderId, itemIds = null, user = null, adapter = zoho, today = manilaTodayDate() } = {}) {
  if (!(await hasColumn('order_item_batches', 'order_item_id'))) return [];
  const { order, items } = await loadOrderWithItemsForBatches(orderId);
  const supplyItems = items.filter((it) => (!itemIds || itemIds.has(Number(it.id)))
    && it.zoho_item_id && isNonBatchSupplyName(it.product_name || it.name));
  if (!supplyItems.length) return [];

  for (const it of supplyItems) {
    if (!it.effective_warehouse_id) continue;
    await db.prepare(`
      DELETE FROM order_item_batches
       WHERE order_id = ? AND order_item_id = ? AND warehouse_id IS NOT NULL AND warehouse_id <> ?
    `).run(order.id, it.id, String(it.effective_warehouse_id));
  }
  const saved = await db.prepare('SELECT order_item_id FROM order_item_batches WHERE order_id = ?').all(order.id);
  const have = new Set(saved.map((r) => Number(r.order_item_id)));
  const targets = supplyItems.filter((it) => !have.has(Number(it.id)));
  if (!targets.length) return [];

  const { availableBatchesByItemId, stockElsewhereByItemId } = await fetchWarehouseBatchesForItems(targets, { adapter, today, failSoft: true });
  for (const it of targets) {
    const own = (availableBatchesByItemId.get(Number(it.id)) || []).some((b) => !b.is_expired && Number(b.available_quantity) > 0);
    const elsewhere = stockElsewhereByItemId.get(Number(it.id)) || 0;
    if (!own && elsewhere > 0) {
      throw new DispatchBatchError(
        422,
        'PACKAGING_NOT_IN_WAREHOUSE',
        `"${it.product_name || it.name}" has no stock in ${it.effective_warehouse_name || 'this order\'s warehouse'} in Zoho `
        + `(${elsewhere} pcs are in another warehouse). Ask the warehouse to transfer some to ${it.effective_warehouse_name || 'this warehouse'} `
        + 'in Zoho (Transfer Order), then try again.'
      );
    }
  }
  const actor = user ? await resolveActor(user) : { id: null, name: 'System (auto packaging batch)' };
  const now = new Date().toISOString();
  const picked = [];
  for (const it of targets) {
    const avail = availableBatchesByItemId.get(Number(it.id)) || [];
    const fefo = suggestFefoPicks(avail, it.quantity);
    if (!fefo.picks.length || fefo.unallocated_quantity > 0) continue;
    for (const p of fefo.picks) {
      const fromOther = avail.find((b) => b.batch_number === p.batch_number && String(b.warehouse_id) === String(p.warehouse_id))?.other_warehouse;
      const row = {
        order_item_id: Number(it.id),
        zoho_item_id: it.zoho_item_id,
        zoho_batch_id: p.zoho_batch_id || null,
        zoho_batch_in_id: p.zoho_batch_in_id || null,
        batch_number: p.batch_number,
        manufacturer_batch_no: p.manufacturer_batch_no || null,
        manufactured_date: p.manufactured_date || null,
        expiry_date: p.expiry_date || null,
        warehouse_id: p.warehouse_id || it.effective_warehouse_id || null,
        warehouse_name: fromOther ? null : (it.effective_warehouse_name || null),
        quantity: p.quantity
      };
      await db.prepare(`
        INSERT INTO order_item_batches (
          order_id, order_item_id, zoho_item_id, zoho_batch_id, zoho_batch_in_id,
          batch_number, manufacturer_batch_no, manufactured_date, expiry_date,
          warehouse_id, warehouse_name, quantity, picked_by, picked_by_name, picked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        order.id, row.order_item_id, row.zoho_item_id, row.zoho_batch_id, row.zoho_batch_in_id,
        row.batch_number, row.manufacturer_batch_no, row.manufactured_date, row.expiry_date,
        row.warehouse_id, row.warehouse_name, row.quantity, actor.id, actor.name, now
      );
      picked.push(row);
    }
  }
  return picked;
}

async function getOrderBatchOptions({
  orderId,
  adapter = zoho,
  today = manilaTodayDate(),
  skipZoho = false,
  forceRefresh = false
} = {}) {
  const { order, items, classification, splits, activeDrs } = await loadOrderWithItemsForBatches(orderId);
  if (skipZoho) {
    return {
      order,
      classification,
      splits,
      active_drs: activeDrs,
      lines: [],
      zoho_batches_unavailable: false,
      zoho_batches_error: null
    };
  }
  if ((!order.tin || !order.lto_license_number) && order.customer_id && order.zoho_contact_id) {
    try {
      const refreshed = await refreshCustomerComplianceFromZoho(order.customer_id, order.zoho_contact_id, adapter);
      if (!order.tin && refreshed.tin) order.tin = refreshed.tin;
      if (!order.lto_license_number && refreshed.lto_license_number) order.lto_license_number = refreshed.lto_license_number;
    } catch (err) {
      if (!isZohoRateLimitOrUnavailable(err)) {
        console.warn(`[DISPATCH_BATCH] customer compliance lookup failed for order ${orderId}:`, err.message);
      }
    }
  }
  const { availableBatchesByItemId, stockElsewhereByItemId, zohoUnavailable, zohoError } = await fetchWarehouseBatchesForItems(items, {
    adapter,
    today,
    failSoft: true,
    forceRefresh
  });

  const hasBatchTable = await hasColumn('order_item_batches', 'order_item_id');
  const savedRows = hasBatchTable
    ? await db.prepare('SELECT * FROM order_item_batches WHERE order_id = ? ORDER BY id').all(order.id)
    : [];
  const savedByItem = new Map();
  for (const r of savedRows) {
    if (!savedByItem.has(r.order_item_id)) savedByItem.set(r.order_item_id, []);
    savedByItem.get(r.order_item_id).push(r);
  }

  const consumedByBatchKey = new Map();
  const batchPoolKey = (it, batchNumber) =>
    `${it.effective_warehouse_id || 'DEFAULT'}::${it.zoho_item_id || it.product_id || ''}::${batchNumber || ''}`;

  for (const it of items) {
    for (const s of savedByItem.get(it.id) || []) {
      const k = batchPoolKey(it, s.batch_number);
      consumedByBatchKey.set(k, (consumedByBatchKey.get(k) || 0) + Number(s.quantity || 0));
    }
  }

  const primaryEntity = classification?.primary_entity || normalizeEntityKey(order.invoicing_from) || 'GPI';
  const lines = items.map((it) => {
    const avail = availableBatchesByItemId.get(Number(it.id)) || [];
    const saved = savedByItem.get(it.id) || [];
    let fefo = { picks: [], unallocated_quantity: 0, no_single_batch: false };
    if (!saved.length) {
      const remainingAvail = avail.map((b) => {
        const used = consumedByBatchKey.get(batchPoolKey(it, b.batch_number)) || 0;
        return { ...b, available_quantity: Math.max(0, Number(b.available_quantity || 0) - used) };
      });
      fefo = suggestFefoPicks(remainingAvail, it.quantity);
      for (const p of fefo.picks) {
        const k = batchPoolKey(it, p.batch_number);
        consumedByBatchKey.set(k, (consumedByBatchKey.get(k) || 0) + Number(p.quantity || 0));
      }
    }
    return {
      order_item_id: it.id,
      product_id: it.product_id,
      product_name: it.product_name,
      sku: it.sku,
      unit: it.unit,
      quantity: it.quantity,
      unit_price: Number(it.unit_price || 0),
      subtotal: Number(it.subtotal != null ? it.subtotal : Number(it.quantity || 0) * Number(it.unit_price || 0)),
      invoicing_from: it.invoicing_from || null,
      entity_key: normalizeEntityKey(it.invoicing_from) || primaryEntity,
      is_csp: Number(it.is_csp) === 1 || isKnownCspProductName(it.product_name),
      warehouse_id: it.effective_warehouse_id,
      warehouse_name: it.effective_warehouse_name,
      available_batches: avail,
      // Nov 25, 2026: packaging with no stock here but some in another warehouse.
      stock_elsewhere: stockElsewhereByItemId.get(Number(it.id)) || 0,
      saved_picks: saved,
      suggested_picks: saved.length ? saved : fefo.picks,
      unallocated_quantity: saved.length ? 0 : fefo.unallocated_quantity,
      no_single_batch: saved.length ? false : Boolean(fefo.no_single_batch)
    };
  });

  return {
    order,
    classification,
    splits,
    active_drs: activeDrs,
    lines,
    zoho_batches_unavailable: Boolean(zohoUnavailable),
    zoho_batches_error: zohoError || null
  };
}

async function saveOrderBatchPicks({
  orderId,
  entityKey = null,
  user,
  doctorName,
  requiresSi = null,
  siOverrideReason = null,
  picks = [],
  manualFallback = false,
  expectedUpdatedAt = null,
  expectedCateredBy = null,
  adapter = zoho,
  today = manilaTodayDate()
}) {
  const actor = await resolveActor(user);
  if (!(await hasColumn('order_item_batches', 'order_item_id'))) {
    throw new DispatchBatchError(503, 'MIGRATION_REQUIRED', 'Batch & DR database schema is not migrated yet (run migrate:pg).');
  }
  await assertCanActOnOrder({ orderId, user, expectedUpdatedAt, expectedCateredBy });

  const { order, items, classification } = await loadOrderWithItemsForBatches(orderId);
  const resolvedEntity = entityKey ? normalizeEntityKey(entityKey) : null;
  const primaryEntity = classification?.primary_entity || normalizeEntityKey(order.invoicing_from) || 'GPI';
  const targetItems = resolvedEntity
    ? items.filter((it) => (normalizeEntityKey(it.invoicing_from) || primaryEntity) === resolvedEntity)
    : items;
  if (resolvedEntity && !targetItems.length) {
    throw new DispatchBatchError(422, 'NO_ENTITY_ITEMS', `Order ${order.getmeds_order_id} has no items under entity ${resolvedEntity}.`);
  }
  let availableBatchesByItemId = new Map();
  let usedManualFallback = false;
  let zohoFallbackReason = null;
  try {
    const batchRes = await fetchWarehouseBatchesForItems(targetItems, { adapter, today, failSoft: false });
    availableBatchesByItemId = batchRes.availableBatchesByItemId;
  } catch (err) {
    if (isZohoRateLimitOrUnavailable(err)) {
      if (!manualFallback) {
        throw new DispatchBatchError(
          503,
          'ZOHO_BATCHES_UNAVAILABLE',
          `Zoho Inventory batches unavailable (${err.message}). Enter Batch # and Expiry Date manually to proceed.`
        );
      }
      usedManualFallback = true;
      zohoFallbackReason = err.message;
    } else {
      throw err;
    }
  }

  const targetItemIds = new Set(targetItems.map((it) => Number(it.id)));
  const picksByItemId = new Map();
  for (const p of picks || []) {
    const itemId = Number(p.order_item_id);
    if (!targetItemIds.has(itemId)) continue;
    if (!picksByItemId.has(itemId)) picksByItemId.set(itemId, []);
    picksByItemId.get(itemId).push(p);
  }

  const normalizedPicks = usedManualFallback
    ? validateManualFallbackBatches({ items: targetItems, picksByItemId, today })
    : validatePickedBatches({
        items: targetItems,
        picksByItemId,
        availableBatchesByItemId,
        today
      });

  const now = new Date().toISOString();
  const cleanDoctor = String(doctorName || order.dispatch_doctor_name || order.intake_doctor || 'NNH').trim() || 'NNH';
  const reqSiFlag = requiresSi === null || requiresSi === undefined ? null : (requiresSi ? 1 : 0);

  await db.transaction(async () => {
    if (resolvedEntity) {
      await db.prepare('DELETE FROM order_item_batches WHERE order_id = ? AND order_item_id = ANY(?)')
        .run(order.id, Array.from(targetItemIds));
    } else {
      await db.prepare('DELETE FROM order_item_batches WHERE order_id = ?').run(order.id);
    }
    for (const p of normalizedPicks) {
      await db.prepare(`
        INSERT INTO order_item_batches (
          order_id, order_item_id, zoho_item_id, zoho_batch_id, zoho_batch_in_id,
          batch_number, manufacturer_batch_no, manufactured_date, expiry_date,
          warehouse_id, warehouse_name, quantity, picked_by, picked_by_name, picked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        order.id, p.order_item_id, p.zoho_item_id, p.zoho_batch_id, p.zoho_batch_in_id,
        p.batch_number, p.manufacturer_batch_no, p.manufactured_date, p.expiry_date,
        p.warehouse_id, p.warehouse_name, p.quantity, actor.id, actor.name, now
      );
    }

    await db.prepare(`
      UPDATE orders
         SET dispatch_doctor_name = ?,
             requires_si = COALESCE(?, requires_si),
             requires_dr = COALESCE(?, requires_dr),
             si_override_reason = COALESCE(?, si_override_reason),
             updated_at = ?
       WHERE id = ?
    `).run(cleanDoctor, reqSiFlag, reqSiFlag, siOverrideReason ? String(siOverrideReason).trim() : null, now, order.id);

    await logEvent({
      orderId: order.id,
      eventType: 'DISPATCH_BATCHES_PICKED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: usedManualFallback
        ? `Batch selection saved via manual Zoho-rate-limit fallback (Doctor: ${cleanDoctor}, ${normalizedPicks.length} batch row(s)).`
        : `Batch selection saved (Doctor: ${cleanDoctor}, ${normalizedPicks.length} batch row(s)).`,
      metadata: {
        doctorName: cleanDoctor,
        pickCount: normalizedPicks.length,
        manualFallback: usedManualFallback,
        zohoFallbackReason
      }
    });
  })();

  return getOrderBatchOptions({ orderId: order.id, adapter, today });
}

async function saveOrderCustomerCompliance({
  orderId,
  user,
  tin = null,
  ltoLicenseNumber = null,
  expectedUpdatedAt = null,
  expectedCateredBy = null
}) {
  const actor = await resolveActor(user);
  await assertCanActOnOrder({ orderId, user, expectedUpdatedAt, expectedCateredBy });

  const order = await db.prepare('SELECT id, getmeds_order_id, customer_id, status FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new DispatchBatchError(404, 'NOT_FOUND', 'Order not found.');
  if (!order.customer_id) throw new DispatchBatchError(422, 'MISSING_CUSTOMER', 'Order is not linked to a customer record.');

  const cleanTin = tin === null || tin === undefined ? null : (String(tin).trim() || null);
  const cleanLto = ltoLicenseNumber === null || ltoLicenseNumber === undefined ? null : (String(ltoLicenseNumber).trim() || null);

  let zohoPushed = false;
  let zohoError = null;
  if (tin !== undefined) {
    const tinRes = await setCustomerTin(order.customer_id, cleanTin);
    zohoPushed = Boolean(tinRes.zohoPushed);
    zohoError = tinRes.zohoError || null;
  }

  const now = new Date().toISOString();
  await db.transaction(async () => {
    if (ltoLicenseNumber !== undefined) {
      await db.prepare('UPDATE customers SET lto_license_number = ? WHERE id = ?').run(cleanLto, order.customer_id);
    }
    if (tin !== undefined && cleanTin) {
      await db.prepare('UPDATE orders SET intake_tin = ?, updated_at = ? WHERE id = ?').run(cleanTin, now, order.id);
    } else {
      await db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(now, order.id);
    }

    // Keep any active (non-void) DR for this order in sync so printing Step 2 reflects updated TIN/LTO immediately.
    await db.prepare(`
      UPDATE delivery_receipts
         SET tin = COALESCE(?, tin),
             lto_license_number = COALESCE(?, lto_license_number),
             updated_at = ?
       WHERE order_id = ? AND status IN ('draft', 'issued')
    `).run(cleanTin, cleanLto, now, order.id);

    await logEvent({
      orderId: order.id,
      eventType: 'CUSTOMER_COMPLIANCE_UPDATED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: `Updated customer compliance in Dispatch modal (TIN: ${cleanTin || '—'}, LTO: ${cleanLto || '—'}).`,
      metadata: { tin: cleanTin, ltoLicenseNumber: cleanLto, zohoPushed, zohoError }
    });
  })();

  const refreshed = await db.prepare('SELECT tin, lto_license_number FROM customers WHERE id = ?').get(order.customer_id);
  return {
    customer_id: order.customer_id,
    tin: refreshed?.tin || cleanTin || null,
    lto_license_number: refreshed?.lto_license_number || cleanLto || null,
    zoho_pushed: zohoPushed,
    zoho_error: zohoError,
    order_updated_at: now
  };
}

module.exports = {
  DispatchBatchError,
  warehouseBalanceForBatch,
  filterAndSortBatchesForWarehouse,
  suggestFefoPicks,
  validatePickedBatches,
  validateManualFallbackBatches,
  isZohoRateLimitOrUnavailable,
  assertCanActOnOrder,
  getOrderBatchOptions,
  saveOrderBatchPicks,
  saveOrderCustomerCompliance,
  invalidateItemBatchesCache,
  supplyFallbackBatches,
  autoPickSupplyBatches
};
