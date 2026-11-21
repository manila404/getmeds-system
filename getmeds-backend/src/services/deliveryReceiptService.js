'use strict';

const ExcelJS = require('exceljs');
const db = require('../db/database');
const zoho = require('../integrations/zoho');
const {
  normalizeEntityKey,
  formatEntitySiNumber,
  classifyOrder
} = require('./orderClassificationService');
const { assertCanActOnOrder, DispatchBatchError } = require('./dispatchBatchService');
const { claimOrder, releaseClaim } = require('./orderClaimService');
const { evaluateCompletion } = require('./orderCompletionService');
const { logEvent, resolveActor } = require('./auditService');
const { hasColumn } = require('./schemaColumns');
const stateMachine = require('../workflow/stateMachine');

const DR_ENTITY_PROFILES = Object.freeze({
  '2MG': {
    entity_key: '2MG',
    invoicing_from: '2mg Incorporated',
    legal_name: '2MG INCORPORATED',
    short_label: '2MG',
    subtitle: '2MG INCORPORATED · Delivery Receipt',
    address_line_1: '17 VATICAN BLDG. VATICAN CITY DRIVE BF RESORT VILLAGE TALON DOS',
    address_line_2: 'LAS PINAS CITY, FOURTH DISTRICT, NCR PHILIPPINES 1740',
    address: process.env.DR_2MG_ADDRESS || '17 VATICAN BLDG. VATICAN CITY DRIVE BF RESORT VILLAGE TALON DOS, LAS PINAS CITY, FOURTH DISTRICT, NCR PHILIPPINES 1740',
    email: process.env.DR_2MG_EMAIL || 'finance3@getmeds.ph',
    tel: process.env.DR_2MG_TEL || '0287091617',
    tin: process.env.DR_2MG_TIN || 'VAT-REG TIN 010-065-182-00000'
  },
  GPI: {
    entity_key: 'GPI',
    invoicing_from: 'Getmeds Philippines Inc.',
    legal_name: 'GETMEDS PHILIPPINES INC',
    short_label: 'GPI',
    subtitle: 'GETMEDS PHILIPPINES INC · Delivery Receipt',
    address_line_1: '17 VATICAN BLDG. VATICAN CITY DRIVE BF RESORT VILLAGE TALON DOS',
    address_line_2: 'LAS PINAS CITY, FOURTH DISTRICT, NCR PHILIPPINES 1740',
    address: process.env.DR_GPI_ADDRESS || '17 VATICAN BLDG. VATICAN CITY DRIVE BF RESORT VILLAGE TALON DOS, LAS PINAS CITY, FOURTH DISTRICT, NCR PHILIPPINES 1740',
    email: process.env.DR_GPI_EMAIL || 'finance@2mginc.com',
    tel: process.env.DR_GPI_TEL || '09945648231',
    tin: process.env.DR_GPI_TIN || 'VAT-REG TIN 605-059-166-00000'
  }
});

const PRINTABLE_ROWS_PER_PAGE = 11;

function manilaTodayDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function zohoTodayDate(now = new Date()) {
  return manilaTodayDate(now);
}

function monthNameOf(isoDate) {
  const m = Number(String(isoDate || '').slice(5, 7));
  const names = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return names[m] || '';
}

function chunkPrintableRows(items = [], perPage = PRINTABLE_ROWS_PER_PAGE) {
  if (!items.length) return [[]];
  const pages = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages;
}

/**
 * Format batched picks for one order line into concise, unambiguous ledger text
 * ("Batch BT26244A (Exp 2028-03-31) × 30") without losing multi-batch splits.
 */
function summarizeLineBatches(picks = []) {
  if (!picks.length) return { batchNumber: null, expiryDate: null, description: '' };
  if (picks.length === 1) {
    const p = picks[0];
    return {
      batchNumber: p.batch_number || null,
      expiryDate: p.expiry_date || null,
      description: `Batch: ${p.batch_number}${p.expiry_date ? ` | Exp. Date: ${p.expiry_date}` : ''}`
    };
  }
  return {
    batchNumber: picks.map((p) => p.batch_number).join(', '),
    expiryDate: picks.map((p) => p.expiry_date || '—').join(', '),
    description: picks
      .map((p) => `${p.batch_number} (${p.quantity}${p.expiry_date ? `, Exp ${p.expiry_date}` : ''})`)
      .join(' + ')
  };
}

const EXCLUDED_TRANSFER_WAREHOUSES = new Set([
  'EXPIRED STOCKS',
  'GLORIA DIAZ WAREHOUSE',
  'HOMESTOCKS- CHAD',
  'HOMESTOCKS- NASHRINA'
]);

const TRANSFER_WAREHOUSE_ADDRESSES = Object.freeze({
  'CEBU WAREHOUSE': 'Unit1023, City Soho Mall, 59 Mirasol St, Cebu City',
  'DAVAO WAREHOUSE': 'DAVAO CITY',
  'GETMEDS PHILIPPINES INC.': 'No. 17 Unit 305 Vatican Bldg Vatican Drive, Las Pinas, NCR'
});

function isExcludedTransferWarehouse(name) {
  return EXCLUDED_TRANSFER_WAREHOUSES.has(String(name || '').trim().toUpperCase());
}

function defaultTransferAddress(warehouseName, zohoWarehousesByName = new Map()) {
  const key = String(warehouseName || '').trim().toUpperCase();
  if (TRANSFER_WAREHOUSE_ADDRESSES[key]) return TRANSFER_WAREHOUSE_ADDRESSES[key];
  const zw = zohoWarehousesByName.get(key);
  if (zw) {
    const parts = [zw.address, zw.city, zw.state].map((s) => String(s || '').trim()).filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  return '';
}

async function listZohoTransferOrders({ search = '', page = 1, perPage = 50, adapter = zoho } = {}) {
  await assertDrTablesReady();
  const [toRes, existingRows] = await Promise.all([
    adapter.listTransferOrders({ page, per_page: perPage }),
    db.prepare(`
      SELECT id, entity_key, dr_number, external_ref, status
        FROM delivery_receipts
       WHERE reference_type = 'transfer_order' AND status IN ('draft', 'issued')
       ORDER BY id DESC
    `).all()
  ]);

  const drByRef = new Map();
  for (const r of existingRows || []) {
    const refKey = String(r.external_ref || '').trim().toUpperCase();
    if (refKey && !drByRef.has(refKey)) drByRef.set(refKey, r);
  }

  const q = String(search || '').trim().toLowerCase();
  const filtered = (toRes.transfer_orders || [])
    .filter((to) => !isExcludedTransferWarehouse(to.to_warehouse_name) && !isExcludedTransferWarehouse(to.from_warehouse_name))
    .filter((to) => {
      if (!q) return true;
      return (
        String(to.transfer_order_number || '').toLowerCase().includes(q) ||
        String(to.to_warehouse_name || '').toLowerCase().includes(q) ||
        String(to.description || '').toLowerCase().includes(q)
      );
    })
    .map((to) => {
      const refKey = String(to.transfer_order_number || '').trim().toUpperCase();
      return {
        transfer_order_id: to.transfer_order_id,
        transfer_order_number: to.transfer_order_number,
        date: to.date,
        status: to.status,
        description: to.description || '',
        from_warehouse_name: to.from_warehouse_name || '',
        to_warehouse_name: to.to_warehouse_name || '',
        default_address: defaultTransferAddress(to.to_warehouse_name),
        quantity_transfer: to.quantity_transfer ?? null,
        existing_dr: drByRef.get(refKey) || null
      };
    });

  return { transfer_orders: filtered };
}

async function getZohoTransferOrderForDr({ transferOrderId, adapter = zoho } = {}) {
  await assertDrTablesReady();
  const [{ transfer_order: to }, whRes] = await Promise.all([
    adapter.getTransferOrder(transferOrderId),
    adapter.listWarehouses().catch(() => ({ warehouses: [] }))
  ]);
  if (!to) throw new DispatchBatchError(404, 'NOT_FOUND', 'Zoho Transfer Order not found.');
  if (isExcludedTransferWarehouse(to.to_warehouse_name)) {
    throw new DispatchBatchError(422, 'EXCLUDED_WAREHOUSE', `Transfer Orders to "${to.to_warehouse_name}" are excluded from DR issuance.`);
  }

  const zohoWarehousesByName = new Map();
  for (const w of whRes?.warehouses || []) {
    zohoWarehousesByName.set(String(w.warehouse_name || '').trim().toUpperCase(), w);
  }

  const lineItems = to.line_items || [];
  const zohoItemIds = Array.from(new Set(lineItems.map((li) => String(li.item_id || '').trim()).filter(Boolean)));
  const productByZohoId = new Map();
  if (zohoItemIds.length) {
    const prodRows = await db.prepare(`
      SELECT id, name, sku, unit, zoho_item_id
        FROM products
       WHERE zoho_item_id = ANY(?)
    `).all([zohoItemIds]);
    for (const p of prodRows || []) {
      productByZohoId.set(String(p.zoho_item_id), p);
    }
  }

  const expandedItems = [];
  for (const li of lineItems) {
    const mappedProd = li.item_id ? productByZohoId.get(String(li.item_id)) : null;
    const itemName = mappedProd?.name || li.name || 'Unnamed Item';
    const unit = mappedProd?.unit || li.unit || 'pc';
    const batches = Array.isArray(li.batches) ? li.batches : [];
    if (batches.length) {
      for (const b of batches) {
        const qty = Number(b.out_quantity ?? b.in_quantity ?? li.quantity_transfer ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        expandedItems.push({
          product_id: mappedProd?.id || null,
          item_name: itemName,
          batch_number: b.batch_number || b.batch_in_number || '',
          expiry_date: b.expiry_date || '',
          quantity: qty,
          unit
        });
      }
    } else {
      const qty = Number(li.quantity_transfer ?? li.quantity ?? 0);
      if (Number.isFinite(qty) && qty > 0) {
        expandedItems.push({
          product_id: mappedProd?.id || null,
          item_name: itemName,
          batch_number: '',
          expiry_date: '',
          quantity: qty,
          unit
        });
      }
    }
  }

  const existingDr = to.transfer_order_number
    ? await db.prepare(`
        SELECT id, entity_key, dr_number, external_ref, status, date_issued
          FROM delivery_receipts
         WHERE reference_type = 'transfer_order' AND external_ref = ? AND status IN ('draft', 'issued')
         ORDER BY id DESC LIMIT 1
      `).get(to.transfer_order_number)
    : null;

  return {
    transfer_order: {
      transfer_order_id: to.transfer_order_id,
      transfer_order_number: to.transfer_order_number,
      date: to.date,
      status: to.status,
      description: to.description || '',
      from_warehouse_name: to.from_warehouse_name || '',
      to_warehouse_name: to.to_warehouse_name || '',
      default_address: defaultTransferAddress(to.to_warehouse_name, zohoWarehousesByName)
    },
    items: expandedItems,
    existing_dr: existingDr || null
  };
}

/**
 * Match saved Hub `order_item_batches` (keyed by order_item_id) to Zoho's
 * `salesorder.line_items` (keyed by salesorder_item_id), handling B1T1 duplicate SKUs
 * deterministically in line order.
 */
function buildBatchesBySoLineItemId(orderItems = [], batches = [], soLineItems = []) {
  const batchesByOrderItemId = new Map();
  for (const b of batches) {
    if (!batchesByOrderItemId.has(b.order_item_id)) batchesByOrderItemId.set(b.order_item_id, []);
    batchesByOrderItemId.get(b.order_item_id).push(b);
  }

  const remainingSoLines = [...(soLineItems || [])];
  const out = {};

  for (const oi of orderItems) {
    const picks = batchesByOrderItemId.get(oi.id) || [];
    if (!picks.length) continue;

    let matchIdx = remainingSoLines.findIndex(
      (sol) => oi.zoho_item_id && sol.item_id && String(sol.item_id) === String(oi.zoho_item_id)
        && Number(sol.quantity) === Number(oi.quantity)
    );
    if (matchIdx === -1) {
      matchIdx = remainingSoLines.findIndex(
        (sol) => oi.zoho_item_id && sol.item_id && String(sol.item_id) === String(oi.zoho_item_id)
      );
    }
    if (matchIdx === -1) {
      matchIdx = remainingSoLines.findIndex(
        (sol) => String(sol.name || '').trim().toLowerCase() === String(oi.product_name || oi.name || '').trim().toLowerCase()
      );
    }
    if (matchIdx >= 0) {
      const [matched] = remainingSoLines.splice(matchIdx, 1);
      out[String(matched.line_item_id)] = picks;
    }
  }
  return out;
}

async function assertDrTablesReady() {
  if (!(await hasColumn('delivery_receipts', 'dr_number'))) {
    throw new DispatchBatchError(503, 'MIGRATION_REQUIRED', 'Delivery Receipt database tables are not migrated yet (run migrate:pg).');
  }
}

async function issueSalesOrderDr({
  orderId,
  entityKey = null,
  user,
  doctorName = null,
  terms = null,
  tin = null,
  ltoLicenseNumber = null,
  notes = null,
  expectedUpdatedAt = null,
  expectedCateredBy = null
}) {
  await assertDrTablesReady();
  const actor = await resolveActor(user);
  await assertCanActOnOrder({ orderId, user, expectedUpdatedAt, expectedCateredBy });

  const order = await db.prepare(`
    SELECT o.*, c.name AS customer_name,
           COALESCE(NULLIF(TRIM(c.tin), ''), NULLIF(TRIM(o.intake_tin), '')) AS customer_tin,
           c.lto_license_number AS customer_lto, c.category AS customer_category
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new DispatchBatchError(404, 'NOT_FOUND', 'Order not found.');

  const resolvedEntity = normalizeEntityKey(entityKey || order.invoicing_from || 'GPI');
  if (!resolvedEntity) {
    throw new DispatchBatchError(422, 'INVALID_ENTITY', 'Unable to determine invoicing entity (2MG or GPI).');
  }

  const allItems = await db.prepare(`
    SELECT oi.*, p.name AS product_name, p.sku, p.unit, p.is_csp
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?
     ORDER BY oi.id
  `).all(order.id);

  // Strict Hard Entity Separation: only include lines belonging to `resolvedEntity`.
  const orderPrimaryEntity = normalizeEntityKey(order.invoicing_from || 'GPI');
  const entityItems = allItems.filter((it) => {
    const lineEntity = normalizeEntityKey(it.invoicing_from) || orderPrimaryEntity;
    return lineEntity === resolvedEntity;
  });
  if (!entityItems.length) {
    throw new DispatchBatchError(422, 'NO_ENTITY_ITEMS', `Order ${order.getmeds_order_id} has no items under entity ${resolvedEntity}.`);
  }

  const batchRows = await db.prepare('SELECT * FROM order_item_batches WHERE order_id = ? ORDER BY id').all(order.id);
  const batchesByItem = new Map();
  for (const b of batchRows) {
    if (!batchesByItem.has(b.order_item_id)) batchesByItem.set(b.order_item_id, []);
    batchesByItem.get(b.order_item_id).push(b);
  }

  const now = new Date().toISOString();
  const today = manilaTodayDate();
  const finalDoctor = String(doctorName || order.dispatch_doctor_name || order.intake_doctor || 'NNH').trim() || 'NNH';
  const finalTerms = String(terms || order.intake_payment_terms || 'COD').trim();
  const finalTin = tin ?? order.customer_tin ?? null;
  const finalLto = ltoLicenseNumber ?? order.customer_lto ?? null;

  let createdDr;
  try {
    createdDr = await db.transaction(async () => {
      const existingActive = await db.prepare(`
        SELECT * FROM delivery_receipts
         WHERE order_id = ? AND entity_key = ? AND status IN ('draft', 'issued')
         LIMIT 1
      `).get(order.id, resolvedEntity);
      if (existingActive) {
        throw new DispatchBatchError(
          409,
          'DR_ALREADY_EXISTS',
          `${resolvedEntity} DR #${existingActive.dr_number} was already issued for ${order.getmeds_order_id}.`,
          { existing_dr: existingActive }
        );
      }

      const seqRow = await db.prepare('SELECT last_dr_no, last_item_no FROM dr_sequences WHERE entity_key = ? FOR UPDATE').get(resolvedEntity);
      if (!seqRow) {
        throw new DispatchBatchError(500, 'MISSING_SEQUENCE', `DR sequence for entity ${resolvedEntity} is not initialized.`);
      }

      const nextDrNo = Number(seqRow.last_dr_no) + 1;
      let nextItemSeq = Number(seqRow.last_item_no);
      const endItemSeq = nextItemSeq + entityItems.length;

      await db.prepare(`
        UPDATE dr_sequences SET last_dr_no = ?, last_item_no = ?, updated_at = ? WHERE entity_key = ?
      `).run(nextDrNo, endItemSeq, now, resolvedEntity);

      const insDr = await db.prepare(`
        INSERT INTO delivery_receipts (
          entity_key, dr_number, reference_type, order_id, external_ref, si_number,
          date_issued, customer_name, delivery_address, tin, lto_license_number,
          terms, doctor_name, status, notes, issued_by, issued_by_name, issued_at,
          created_at, updated_at
        ) VALUES (?, ?, 'sales_order', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedEntity,
        nextDrNo,
        order.id,
        order.zoho_so_number || order.getmeds_order_id,
        order.oojeema_si_number || null,
        today,
        order.customer_name || 'Unknown Customer',
        order.delivery_address || '',
        finalTin,
        finalLto,
        finalTerms,
        finalDoctor,
        notes || null,
        actor.id,
        actor.name,
        now,
        now,
        now
      );
      const drId = insDr.lastInsertRowid;

      for (const it of entityItems) {
        nextItemSeq += 1;
        const summary = summarizeLineBatches(batchesByItem.get(it.id) || []);
        const displayName = summary.description ? `${it.product_name} — ${summary.description}` : it.product_name;
        await db.prepare(`
          INSERT INTO delivery_receipt_items (
            delivery_receipt_id, entity_key, order_item_id, item_seq_no, si_or_to_no,
            product_id, item_name, batch_number, expiry_date,
            warehouse_id, warehouse_name, quantity, unit, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          drId,
          resolvedEntity,
          it.id,
          nextItemSeq,
          order.oojeema_si_number || 'PENDING SI',
          it.product_id || null,
          displayName,
          summary.batchNumber,
          summary.expiryDate,
          it.fulfil_warehouse_id || order.fulfil_warehouse_id || null,
          it.fulfil_warehouse_name || order.fulfil_warehouse_name || null,
          it.quantity,
          it.unit || 'pc',
          now
        );
      }

      await db.prepare(`
        UPDATE orders
           SET requires_si = COALESCE(requires_si, 1),
               requires_dr = COALESCE(requires_dr, 1),
               dispatch_doctor_name = ?,
               oojeema_entity = ?,
               updated_at = ?
         WHERE id = ?
      `).run(finalDoctor, resolvedEntity, now, order.id);

      await logEvent({
        orderId: order.id,
        eventType: 'DR_ISSUED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `${resolvedEntity} DR #${nextDrNo} issued by ${actor.name} (${entityItems.length} item row(s)).`,
        metadata: { drId, entityKey: resolvedEntity, drNumber: nextDrNo }
      });

      return { drId, now };
    })();
  } catch (err) {
    if (err?.code === '23505') {
      throw new DispatchBatchError(409, 'DR_ALREADY_EXISTS', `An active ${resolvedEntity} DR already exists for ${order.getmeds_order_id}.`);
    }
    throw err;
  }

  const printable = await getPrintableDr({ drId: createdDr.drId });
  return { ...printable, order_updated_at: createdDr.now };
}

async function issueTransferOrderDr({
  entityKey,
  externalRef,
  transferName,
  deliveryAddress = '',
  dateIssued = null,
  notes = null,
  items = [],
  user
}) {
  await assertDrTablesReady();
  const actor = await resolveActor(user);
  const resolvedEntity = normalizeEntityKey(entityKey);
  if (!resolvedEntity) throw new DispatchBatchError(422, 'INVALID_ENTITY', 'Entity must be GPI or 2MG.');
  const cleanRef = String(externalRef || '').trim();
  const cleanName = String(transferName || '').trim();
  if (!cleanRef || !cleanName) {
    throw new DispatchBatchError(422, 'MISSING_TRANSFER_DETAILS', 'Transfer reference (e.g. TO # 0014) and Transfer Name (e.g. GPI WH -> 2MG WH) are required.');
  }
  if (!Array.isArray(items) || !items.length) {
    throw new DispatchBatchError(422, 'MISSING_ITEMS', 'At least one item line is required for a Transfer Order DR.');
  }

  const now = new Date().toISOString();
  const issueDate = dateIssued ? String(dateIssued).slice(0, 10) : manilaTodayDate();

  const drId = await db.transaction(async () => {
    const seqRow = await db.prepare('SELECT last_dr_no, last_item_no FROM dr_sequences WHERE entity_key = ? FOR UPDATE').get(resolvedEntity);
    if (!seqRow) throw new DispatchBatchError(500, 'MISSING_SEQUENCE', `DR sequence missing for ${resolvedEntity}.`);

    const nextDrNo = Number(seqRow.last_dr_no) + 1;
    let nextItemSeq = Number(seqRow.last_item_no);

    await db.prepare('UPDATE dr_sequences SET last_dr_no = ?, last_item_no = ?, updated_at = ? WHERE entity_key = ?')
      .run(nextDrNo, nextItemSeq + items.length, now, resolvedEntity);

    const ins = await db.prepare(`
      INSERT INTO delivery_receipts (
        entity_key, dr_number, reference_type, order_id, external_ref, si_number,
        date_issued, customer_name, delivery_address, tin, terms, status, notes,
        issued_by, issued_by_name, issued_at, created_at, updated_at
      ) VALUES (?, ?, 'transfer_order', NULL, ?, ?, ?, ?, ?, '—', 'TO', 'issued', ?, ?, ?, ?, ?, ?)
    `).run(
      resolvedEntity, nextDrNo, cleanRef, cleanRef, issueDate,
      cleanName, deliveryAddress, notes, actor.id, actor.name, now, now, now
    );

    for (const it of items) {
      const qty = Number(it.quantity);
      if (!it.item_name || !Number.isFinite(qty) || qty <= 0) {
        throw new DispatchBatchError(422, 'INVALID_TRANSFER_ITEM', 'Each transfer item requires item_name and quantity > 0.');
      }
      nextItemSeq += 1;
      const cleanItemName = String(it.item_name).trim();
      const batchNo = it.batch_number ? String(it.batch_number).trim() : null;
      const expDate = it.expiry_date ? String(it.expiry_date).slice(0, 10) : null;
      const batchDesc = [batchNo ? `Batch: ${batchNo}` : null, expDate ? `Exp: ${expDate}` : null].filter(Boolean).join(' · ');
      const displayItemName = batchDesc && !cleanItemName.includes('Batch:') ? `${cleanItemName} — ${batchDesc}` : cleanItemName;
      await db.prepare(`
        INSERT INTO delivery_receipt_items (
          delivery_receipt_id, entity_key, order_item_id, item_seq_no, si_or_to_no,
          product_id, item_name, batch_number, expiry_date, warehouse_name, quantity, unit, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ins.lastInsertRowid,
        resolvedEntity,
        nextItemSeq,
        cleanRef,
        it.product_id || null,
        displayItemName,
        batchNo,
        expDate,
        it.warehouse_name || cleanName || null,
        qty,
        it.unit || 'pc',
        now
      );
    }

    return ins.lastInsertRowid;
  })();

  return getPrintableDr({ drId });
}

async function voidDeliveryReceipt({ drId, user, reason, switchToNoSi = false, expectedUpdatedAt = null }) {
  await assertDrTablesReady();
  const actor = await resolveActor(user);
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new DispatchBatchError(422, 'REASON_REQUIRED', 'A reason is required to void a Delivery Receipt.');

  const dr = await db.prepare('SELECT * FROM delivery_receipts WHERE id = ?').get(drId);
  if (!dr) throw new DispatchBatchError(404, 'NOT_FOUND', 'Delivery Receipt not found.');
  if (dr.status === 'void') {
    throw new DispatchBatchError(409, 'ALREADY_VOID', `${dr.entity_key} DR #${dr.dr_number} is already void.`);
  }
  if (dr.order_id) {
    await assertCanActOnOrder({ orderId: dr.order_id, user, expectedUpdatedAt });
  }

  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE delivery_receipts
         SET status = 'void', void_reason = ?, voided_by = ?, voided_at = ?, updated_at = ?
       WHERE id = ?
    `).run(cleanReason, actor.id, now, now, dr.id);

    if (dr.order_id) {
      if (switchToNoSi) {
        await db.prepare(`
          UPDATE orders
             SET requires_si = 0, requires_dr = 0, si_override_reason = ?, updated_at = ?
           WHERE id = ?
        `).run(cleanReason, now, dr.order_id);
      } else {
        await db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(now, dr.order_id);
      }

      await logEvent({
        orderId: dr.order_id,
        eventType: 'DR_VOIDED',
        actorId: actor.id,
        actorName: actor.name,
        notes: `${dr.entity_key} DR #${dr.dr_number} marked VOID by ${actor.name}: ${cleanReason}`,
        metadata: { drId: dr.id, entityKey: dr.entity_key, drNumber: dr.dr_number, switchToNoSi }
      });
    }
  })();

  const printable = await getPrintableDr({ drId: dr.id });
  return { ...printable, order_updated_at: now };
}

async function recordDrPrint({ drId, user }) {
  await assertDrTablesReady();
  const actor = await resolveActor(user);
  const dr = await db.prepare('SELECT * FROM delivery_receipts WHERE id = ?').get(drId);
  if (!dr) throw new DispatchBatchError(404, 'NOT_FOUND', 'Delivery Receipt not found.');
  if (dr.order_id) await assertCanActOnOrder({ orderId: dr.order_id, user });

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE delivery_receipts
       SET printed_by = ?, printed_by_name = ?, printed_at = ?,
           print_count = COALESCE(print_count, 0) + 1, updated_at = ?
     WHERE id = ?
  `).run(actor.id, actor.name, now, now, dr.id);

  if (dr.order_id) {
    await logEvent({
      orderId: dr.order_id,
      eventType: 'DR_PRINTED',
      actorId: actor.id,
      actorName: actor.name,
      notes: `${dr.entity_key} DR #${dr.dr_number} printed by ${actor.name}.`,
      metadata: { drId: dr.id, drNumber: dr.dr_number, entityKey: dr.entity_key }
    });
  }

  const printable = await getPrintableDr({ drId: dr.id });
  return { ...printable, order_updated_at: now };
}

async function loadTargetSalesOrder(adapter, targetSoId, order, entityItems, splitTarget = null) {
  let { salesorder: so } = await adapter.getSalesOrder(targetSoId);
  const rawAdapter = typeof adapter?.getZohoAdapter === 'function' ? adapter.getZohoAdapter() : adapter;
  if (!so && adapter.mode === 'mock' && rawAdapter?._salesOrders) {
    // Re-hydrate in-memory mock Sales Order from DB across server restarts or local simulation seeds.
    const mockSo = {
      salesorder_id: targetSoId,
      salesorder_number: splitTarget?.zoho_so_number || order.zoho_so_number || `SO-${order.id}`,
      reference_number: order.getmeds_order_id,
      status: 'confirmed',
      customer_id: `MOCK-CONTACT-${order.customer_id}`,
      total: order.total_amount,
      invoices: [],
      packages: [],
      line_items: entityItems.map((it, idx) => ({
        line_item_id: `${targetSoId}-L${idx + 1}`,
        item_id: it.zoho_item_id || undefined,
        name: it.product_name,
        rate: it.unit_price,
        quantity: it.quantity,
        quantity_invoiced: 0,
        quantity_packed: 0
      }))
    };
    rawAdapter._salesOrders.set(targetSoId, mockSo);
    so = mockSo;
  }
  if (!so) {
    throw new DispatchBatchError(404, 'ZOHO_SO_NOT_FOUND', `Zoho Sales Order ${targetSoId} could not be loaded.`);
  }
  return so;
}

/**
 * Bridge DR + Oojeema SI (or auto-invoice for Patient/Doctor) + Zoho Warehouse Batches
 * into Zoho Inventory, then mark the invoice Sent. Respects orderClaimService lock.
 */
function resolveTargetSalesOrderForEntity({ order, splits = [], resolvedEntity }) {
  const explicitPrimaryEntity = normalizeEntityKey(order.invoicing_from);
  const primaryEntity = explicitPrimaryEntity || 'GPI';
  const splitTarget = resolvedEntity !== primaryEntity
    ? splits.find((s) => normalizeEntityKey(s.invoicing_from) === resolvedEntity)
    : null;
  if (explicitPrimaryEntity && resolvedEntity !== explicitPrimaryEntity && !splitTarget) {
    throw new DispatchBatchError(
      422,
      'ENTITY_MISMATCH',
      `Sales Order ${order.zoho_so_number || order.getmeds_order_id} is under ${order.invoicing_from} (${explicitPrimaryEntity}) and cannot be fulfilled under ${DR_ENTITY_PROFILES[resolvedEntity].invoicing_from} (${resolvedEntity}).`
    );
  }
  const targetSoId = splitTarget ? splitTarget.zoho_so_id : order.zoho_so_id;
  if (!targetSoId) {
    throw new DispatchBatchError(422, 'MISSING_ZOHO_SO', `No Zoho Sales Order found for entity ${resolvedEntity}.`);
  }
  return { primaryEntity, splitTarget, targetSoId };
}

async function finalizeZohoInvoiceForOrder({
  orderId,
  entityKey = null,
  siSuffix = null,
  doctorName = null,
  user,
  expectedUpdatedAt = null,
  expectedCateredBy = null,
  adapter = zoho
}) {
  const actor = await resolveActor(user);
  await assertCanActOnOrder({ orderId, user, expectedUpdatedAt, expectedCateredBy });

  const order = await db.prepare(`
    SELECT o.*, c.category AS customer_category
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new DispatchBatchError(404, 'NOT_FOUND', 'Order not found.');

  const resolvedEntity = normalizeEntityKey(entityKey || order.invoicing_from || 'GPI');
  const orderItems = await db.prepare(`
    SELECT oi.*, p.name AS product_name, p.zoho_item_id, p.is_csp
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?
     ORDER BY oi.id
  `).all(order.id);
  const splits = await db.prepare('SELECT * FROM order_split_sales_orders WHERE order_id = ?').all(order.id);
  const glProofs = await db.prepare("SELECT file_type FROM payment_proofs WHERE order_id = ? AND lower(file_type) = 'gl' LIMIT 1").all(order.id);

  const classification = classifyOrder({
    order,
    customer: { category: order.customer_category },
    items: orderItems,
    paymentProofs: glProofs,
    splits
  });

  const { primaryEntity, splitTarget, targetSoId } = resolveTargetSalesOrderForEntity({ order, splits, resolvedEntity });

  let customInvoiceNumber = null;
  let activeDr = null;
  if (classification.requires_si) {
    await assertDrTablesReady();
    activeDr = await db.prepare(`
      SELECT * FROM delivery_receipts
       WHERE order_id = ? AND entity_key = ? AND status IN ('draft', 'issued')
       LIMIT 1
    `).get(order.id, resolvedEntity);
    if (!activeDr) {
      throw new DispatchBatchError(422, 'DR_REQUIRED', `Generate ${resolvedEntity} Delivery Receipt before entering the Oojeema SI number.`);
    }
    if (!String(siSuffix || '').trim()) {
      throw new DispatchBatchError(422, 'SI_REQUIRED', 'Enter the Oojeema SI number (e.g. SI000004987) before converting to Zoho Invoice.');
    }
    customInvoiceNumber = formatEntitySiNumber(resolvedEntity, siSuffix);
  }

  const claimableStatuses = [
    'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing'
  ];
  const token = await claimOrder(order.id, claimableStatuses, `Finalize Zoho invoice by ${actor.name}`);
  if (!token) {
    throw new DispatchBatchError(
      409,
      'CLAIM_CONFLICT',
      `Order ${order.getmeds_order_id} cannot be invoiced right now — another user or tab may have just updated it. Click Refresh and try again.`
    );
  }

  try {
    const entityItems = orderItems.filter((it) => (normalizeEntityKey(it.invoicing_from) || primaryEntity) === resolvedEntity);
    let so = await loadTargetSalesOrder(adapter, targetSoId, order, entityItems, splitTarget);
    const savedBatches = (await hasColumn('order_item_batches', 'order_item_id'))
      ? await db.prepare('SELECT * FROM order_item_batches WHERE order_id = ? ORDER BY id').all(order.id)
      : [];

    const batchesBySoLineItemId = buildBatchesBySoLineItemId(entityItems, savedBatches, so.line_items || []);
    const finalDoctor = String(doctorName || order.dispatch_doctor_name || order.intake_doctor || 'NNH').trim() || 'NNH';
    const invoicingFrom = DR_ENTITY_PROFILES[resolvedEntity].invoicing_from;

    const existingInv = (so.invoices || []).find((i) => !['void', 'deleted'].includes(String(i.status || '').toLowerCase()));
    if (!existingInv && String(so.status || '').toLowerCase() === 'draft') {
      const finRow = splitTarget
        ? (splitTarget.payment_status === 'verified' ? { ok: 1 } : null)
        : await db.prepare("SELECT 1 AS ok FROM order_events WHERE order_id = ? AND event_type = 'FINANCE_VERIFIED' LIMIT 1").get(order.id);
      if (!finRow) {
        throw new DispatchBatchError(
          409,
          'NOT_CONFIRMED_IN_ZOHO',
          `Sales Order ${so.salesorder_number || targetSoId} is still a draft in Zoho and Finance has not verified it yet. Confirm it in Zoho Books first.`
        );
      }
      await adapter.confirmSalesOrder(so.salesorder_id || targetSoId);
      so = { ...so, status: 'confirmed' };
    }
    let invoice;
    if (existingInv) {
      invoice = existingInv;
    } else {
      const created = await adapter.createInvoiceFromSalesOrder(so, {
        date: zohoTodayDate(),
        invoiceNumber: customInvoiceNumber,
        doctorName: finalDoctor,
        invoicingFrom,
        orderSource: order.intake_source || null,
        batchesBySoLineItemId
      });
      invoice = created.invoice;
    }

    if (!['sent', 'paid', 'overdue', 'partially_paid'].includes(String(invoice.status || '').toLowerCase())) {
      await adapter.markInvoiceSent(invoice.invoice_id);
      invoice = { ...invoice, status: 'sent' };
    }

    const now = new Date().toISOString();
    await db.transaction(async () => {
      if (splitTarget) {
        await db.prepare(`
          UPDATE order_split_sales_orders
             SET zoho_invoice_id = ?, zoho_invoice_number = ?, zoho_invoiced_status = 'sent', updated_at = ?
           WHERE id = ?
        `).run(invoice.invoice_id, invoice.invoice_number || customInvoiceNumber, now, splitTarget.id);
      } else {
        const nextStatus = ['ready_for_draft_invoice', 'ready_for_invoice_sent'].includes(order.status) && stateMachine.canTransition(order.status, 'ready_for_dispatch')
          ? 'ready_for_dispatch'
          : order.status;
        await db.prepare(`
          UPDATE orders
             SET zoho_invoice_id = ?, zoho_invoice_number = ?, oojeema_si_number = COALESCE(?, oojeema_si_number),
                 oojeema_entity = COALESCE(?, oojeema_entity), dispatch_doctor_name = ?, status = ?, updated_at = ?
           WHERE id = ?
        `).run(
          invoice.invoice_id,
          invoice.invoice_number || customInvoiceNumber,
          siSuffix ? String(siSuffix).trim() : null,
          resolvedEntity,
          finalDoctor,
          nextStatus,
          now,
          order.id
        );
      }

      if (activeDr && siSuffix) {
        const cleanSuffix = String(siSuffix).trim();
        await db.prepare('UPDATE delivery_receipts SET si_number = ?, updated_at = ? WHERE id = ?').run(cleanSuffix, now, activeDr.id);
        await db.prepare('UPDATE delivery_receipt_items SET si_or_to_no = ? WHERE delivery_receipt_id = ?').run(cleanSuffix, activeDr.id);
      }

      await logEvent({
        orderId: order.id,
        eventType: 'ZOHO_INVOICE_SENT',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `Zoho Invoice ${invoice.invoice_number || customInvoiceNumber || ''} created & marked Sent (${resolvedEntity}).`,
        metadata: {
          zohoInvoiceId: invoice.invoice_id,
          zohoInvoiceNumber: invoice.invoice_number || customInvoiceNumber,
          entityKey: resolvedEntity,
          drNumber: activeDr?.dr_number || null
        }
      });
    })();

    return {
      entity_key: resolvedEntity,
      zoho_invoice_id: invoice.invoice_id,
      zoho_invoice_number: invoice.invoice_number || customInvoiceNumber,
      dr_number: activeDr?.dr_number || null,
      order_updated_at: now
    };
  } finally {
    await releaseClaim(order.id, token);
  }
}

/**
 * Create (or adopt) Zoho Package + Shipment after invoicing so the Sales Order
 * carries its Mode of Delivery in Zoho Inventory without re-allocating batches
 * already deducted on the Invoice.
 */
function normalizeZohoDeliveryMethod(method) {
  const raw = String(method || '').trim();
  if (!raw) return '';
  const low = raw.toLowerCase().replace(/\s+/g, ' ');
  if (/customer pick-?up|office pick-?up|^pick-?up$|^pickup$|^walk-?in$|^will call$/.test(low)) {
    return 'Customer Pick-up';
  }
  if (/^(in-?\s?house|own rider(\s*\/\s*company vehicle)?|company vehicle|internal delivery)$/.test(low)) {
    return 'Inhouse';
  }
  return raw;
}

function isTrackingExemptDeliveryMethod(method) {
  const normalized = normalizeZohoDeliveryMethod(method);
  return normalized === 'Customer Pick-up' || normalized === 'Inhouse';
}

async function shipInvoicedOrderInZoho({
  orderId,
  entityKey = null,
  deliveryMethod = null,
  trackingNumber = '',
  requireTracking = false,
  user,
  expectedUpdatedAt = null,
  expectedCateredBy = null,
  adapter = zoho
}) {
  const actor = await resolveActor(user);
  await assertCanActOnOrder({ orderId, user, expectedUpdatedAt, expectedCateredBy });

  const order = await db.prepare(`
    SELECT o.*, d.id AS dispatch_id, d.courier AS dispatch_courier,
           d.tracking_number AS dispatch_tracking_number
      FROM orders o
      LEFT JOIN dispatch_records d ON d.order_id = o.id
     WHERE o.id = ?
  `).get(orderId);
  if (!order) throw new DispatchBatchError(404, 'NOT_FOUND', 'Order not found.');

  const resolvedMethod = normalizeZohoDeliveryMethod(
    deliveryMethod || order.intake_delivery_method || order.dispatch_courier || ''
  );
  if (!resolvedMethod) {
    throw new DispatchBatchError(422, 'DELIVERY_METHOD_REQUIRED', 'Choose a Mode of Delivery before creating the Zoho package and shipment.');
  }
  const cleanTracking = String(trackingNumber ?? order.dispatch_tracking_number ?? '').trim();
  if (requireTracking && !isTrackingExemptDeliveryMethod(resolvedMethod) && !cleanTracking) {
    throw new DispatchBatchError(
      422,
      'TRACKING_REQUIRED',
      `Enter a Tracking Number for ${resolvedMethod} before marking shipped (or choose Customer Pick-up / Inhouse).`
    );
  }

  const resolvedEntity = normalizeEntityKey(entityKey || order.oojeema_entity || order.invoicing_from || 'GPI');
  const orderItems = await db.prepare(`
    SELECT oi.*, p.name AS product_name, p.zoho_item_id, p.is_csp
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?
     ORDER BY oi.id
  `).all(order.id);
  const splits = await db.prepare('SELECT * FROM order_split_sales_orders WHERE order_id = ?').all(order.id);
  const { primaryEntity, splitTarget, targetSoId } = resolveTargetSalesOrderForEntity({ order, splits, resolvedEntity });

  const claimableStatuses = [
    'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared', 'completed'
  ];
  const token = await claimOrder(order.id, claimableStatuses, `Package & ship in Zoho by ${actor.name}`);
  if (!token) {
    throw new DispatchBatchError(
      409,
      'CLAIM_CONFLICT',
      `Order ${order.getmeds_order_id} cannot be shipped right now — another user or tab may have just updated it. Click Refresh and try again.`
    );
  }

  try {
    const entityItems = orderItems.filter((it) => (normalizeEntityKey(it.invoicing_from) || primaryEntity) === resolvedEntity);
    let so = await loadTargetSalesOrder(adapter, targetSoId, order, entityItems, splitTarget);

    let pkg = (so.packages || [])[0] || null;
    let adoptedPackage = Boolean(pkg);
    if (!pkg) {
      const savedBatches = (await hasColumn('order_item_batches', 'order_item_id'))
        ? await db.prepare('SELECT * FROM order_item_batches WHERE order_id = ? ORDER BY id').all(order.id)
        : [];
      const batchesBySoLineItemId = buildBatchesBySoLineItemId(entityItems, savedBatches, so.line_items || []);
      const createdPkg = await adapter.createPackageForSalesOrder(so, {
        date: zohoTodayDate(),
        skipBatchesForInvoicedLines: true,
        carrier: resolvedMethod,
        batchesBySoLineItemId
      });
      pkg = createdPkg.package;
      adoptedPackage = false;
    }

    const existingShipped = (so.packages || []).find((p) => p.shipment_id);
    let shipment = existingShipped
      ? { shipment_id: existingShipped.shipment_id, shipment_number: existingShipped.shipment_number || null }
      : null;
    let adoptedShipment = Boolean(shipment);
    if (!shipment) {
      const createdShp = await adapter.createShipmentForPackage({
        salesorderId: targetSoId,
        packageId: pkg.package_id,
        date: zohoTodayDate(),
        deliveryMethod: resolvedMethod,
        trackingNumber: cleanTracking
      });
      shipment = createdShp.shipmentorder;
      adoptedShipment = false;
    }

    const now = new Date().toISOString();
    let finalOrderStatus = order.status;
    await db.transaction(async () => {
      if (!splitTarget) {
        if (order.dispatch_id) {
          await db.prepare(`
            UPDATE dispatch_records
               SET status = 'dispatched',
                   courier = ?,
                   tracking_number = COALESCE(NULLIF(?, ''), tracking_number),
                   zoho_package_id = COALESCE(?, zoho_package_id),
                   zoho_package_number = COALESCE(?, zoho_package_number),
                   zoho_shipment_id = COALESCE(?, zoho_shipment_id),
                   zoho_shipment_number = COALESCE(?, zoho_shipment_number),
                   dispatched_by = COALESCE(dispatched_by, ?),
                   dispatched_at = COALESCE(dispatched_at, ?)
             WHERE order_id = ?
          `).run(
            resolvedMethod,
            cleanTracking,
            pkg.package_id || null,
            pkg.package_number || null,
            shipment?.shipment_id || null,
            shipment?.shipment_number || null,
            actor.id,
            now,
            order.id
          );
        } else {
          await db.prepare(`
            INSERT INTO dispatch_records (
              order_id, status, courier, tracking_number,
              zoho_package_id, zoho_package_number, zoho_shipment_id, zoho_shipment_number,
              dispatched_by, dispatched_at, created_at
            ) VALUES (?, 'dispatched', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            order.id,
            resolvedMethod,
            cleanTracking || null,
            pkg.package_id || null,
            pkg.package_number || null,
            shipment?.shipment_id || null,
            shipment?.shipment_number || null,
            actor.id,
            now,
            now
          );
        }

        if (stateMachine.canTransition(finalOrderStatus, 'dispatched')) {
          finalOrderStatus = 'dispatched';
        }
        if (cleanTracking && stateMachine.canTransition(finalOrderStatus, 'tracking_shared')) {
          finalOrderStatus = 'tracking_shared';
        }
        await db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
          .run(finalOrderStatus, now, order.id);
      } else {
        await db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(now, order.id);
      }

      if (!adoptedPackage) {
        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_PACKAGE_CREATED',
          oldStatus: order.status,
          newStatus: finalOrderStatus,
          actorId: actor.id,
          actorName: actor.name,
          notes: `Package ${pkg.package_number || ''} created in Zoho (${resolvedMethod}).`,
          metadata: { zohoPackageId: pkg.package_id, zohoPackageNumber: pkg.package_number, entityKey: resolvedEntity, source: 'getmeds' }
        });
      }
      if (!adoptedShipment) {
        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_DISPATCHED',
          oldStatus: order.status,
          newStatus: finalOrderStatus,
          actorId: actor.id,
          actorName: actor.name,
          notes: `Shipped in Zoho — ${resolvedMethod}${cleanTracking ? ` (Tracking: ${cleanTracking})` : ''}.`,
          metadata: {
            zohoShipmentId: shipment?.shipment_id || null,
            zohoShipmentNumber: shipment?.shipment_number || null,
            courier: resolvedMethod,
            trackingNumber: cleanTracking || null,
            entityKey: resolvedEntity,
            adoptedShipment,
            source: 'getmeds'
          }
        });
      }
    })();

    try {
      await evaluateCompletion(order.id);
    } catch (err) {
      console.warn(`[DR_SHIP] evaluateCompletion failed for order ${order.id}:`, err.message);
    }

    return {
      entity_key: resolvedEntity,
      zoho_package_id: pkg.package_id || null,
      zoho_package_number: pkg.package_number || null,
      zoho_shipment_id: shipment?.shipment_id || null,
      zoho_shipment_number: shipment?.shipment_number || null,
      delivery_method: resolvedMethod,
      tracking_number: cleanTracking || null,
      status: finalOrderStatus,
      adopted_package: adoptedPackage,
      adopted_shipment: adoptedShipment,
      order_updated_at: now
    };
  } finally {
    await releaseClaim(order.id, token);
  }
}

async function getPrintableDr({ drId }) {
  await assertDrTablesReady();
  const dr = await db.prepare('SELECT * FROM delivery_receipts WHERE id = ?').get(drId);
  if (!dr) throw new DispatchBatchError(404, 'NOT_FOUND', 'Delivery Receipt not found.');
  const items = await db.prepare('SELECT * FROM delivery_receipt_items WHERE delivery_receipt_id = ? ORDER BY item_seq_no, id').all(dr.id);

  return {
    receipt: dr,
    entity_profile: DR_ENTITY_PROFILES[dr.entity_key] || DR_ENTITY_PROFILES.GPI,
    items,
    pages: chunkPrintableRows(items, PRINTABLE_ROWS_PER_PAGE),
    rows_per_page: PRINTABLE_ROWS_PER_PAGE,
    signatory: {
      issued_by_label: 'Issued by:',
      issued_by_name: dr.issued_by_name || '',
      delivered_by_label: 'Delivered by:',
      receiver_declaration: 'Received the above goods in good order and condition.',
      signature_label: "Customer's Signature over Printed Name",
      disclaimer: '"THIS DOCUMENTS IS NOT VALID FOR CLAIM OF INPUT TAX"'
    }
  };
}

async function listLedger({
  entityKey = null,
  referenceType = null,
  status = null,
  fromDate = null,
  toDate = null,
  search = null,
  page = 1,
  limit = 50
} = {}) {
  await assertDrTablesReady();
  const where = [];
  const params = [];

  const cleanEntity = normalizeEntityKey(entityKey);
  if (cleanEntity) {
    where.push('dr.entity_key = ?');
    params.push(cleanEntity);
  }
  if (referenceType && ['sales_order', 'transfer_order'].includes(referenceType)) {
    where.push('dr.reference_type = ?');
    params.push(referenceType);
  }
  if (status && ['draft', 'issued', 'void'].includes(status)) {
    where.push('dr.status = ?');
    params.push(status);
  }
  if (fromDate) {
    where.push('dr.date_issued >= ?');
    params.push(String(fromDate).slice(0, 10));
  }
  if (toDate) {
    where.push('dr.date_issued <= ?');
    params.push(String(toDate).slice(0, 10));
  }
  if (search && String(search).trim()) {
    const like = `%${String(search).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(`(
      CAST(dr.dr_number AS TEXT) ILIKE ? OR dr.customer_name ILIKE ? OR
      COALESCE(dr.si_number, '') ILIKE ? OR COALESCE(dr.external_ref, '') ILIKE ? OR
      COALESCE(dri.item_name, '') ILIKE ?
    )`);
    params.push(like, like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const [rows, countRow, sequences] = await Promise.all([
    db.prepare(`
      SELECT dr.id AS dr_id, dr.entity_key, dr.dr_number, dr.reference_type, dr.order_id,
             dr.external_ref, dr.si_number, dr.date_issued, dr.customer_name,
             dr.delivery_address, dr.tin, dr.terms, dr.doctor_name, dr.status,
             dr.void_reason, dr.issued_by_name, dr.printed_by_name, dr.printed_at, dr.print_count,
             dri.id AS dr_item_id, dri.item_seq_no, dri.si_or_to_no, dri.item_name,
             dri.batch_number, dri.expiry_date, dri.warehouse_name, dri.quantity, dri.unit
        FROM delivery_receipts dr
        LEFT JOIN delivery_receipt_items dri ON dri.delivery_receipt_id = dr.id
       ${whereSql}
       ORDER BY dr.dr_number DESC, dri.item_seq_no ASC
       LIMIT ? OFFSET ?
    `).all([...params, safeLimit, offset]),
    db.prepare(`
      SELECT COUNT(*) AS total
        FROM delivery_receipts dr
        LEFT JOIN delivery_receipt_items dri ON dri.delivery_receipt_id = dr.id
       ${whereSql}
    `).get(params),
    db.prepare('SELECT entity_key, last_dr_no, last_item_no FROM dr_sequences ORDER BY entity_key').all()
  ]);

  const seenDrs = new Set();
  const formattedRows = rows.map((r) => {
    const isFirstRowOfDr = !seenDrs.has(r.dr_id);
    seenDrs.add(r.dr_id);
    return {
      ...r,
      month: monthNameOf(r.date_issued),
      display_dr_no: isFirstRowOfDr ? r.dr_number : ''
    };
  });

  const total = Number(countRow?.total || 0);
  return {
    rows: formattedRows,
    sequences,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    }
  };
}

/**
 * Generate an Excel (.xlsx) workbook mirroring the 14-column Google Sheets SUMMARY tab:
 * Month | Date | DR No. | Name | Address | TIN No. | Terms | Item No. | SI No. |
 * Item Name | Description | Qty | Unit | Status
 */
async function exportLedgerXlsx(filters = {}) {
  const { rows } = await listLedger({ ...filters, page: 1, limit: 500 });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SUMMARY');

  ws.columns = [
    { header: 'Month', key: 'month', width: 12 },
    { header: 'Date', key: 'date', width: 13 },
    { header: 'DR No.', key: 'dr_no', width: 10 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Address', key: 'address', width: 32 },
    { header: 'TIN No.', key: 'tin', width: 16 },
    { header: 'Terms', key: 'terms', width: 10 },
    { header: 'Item No.', key: 'item_no', width: 10 },
    { header: 'SI No.', key: 'si_no', width: 16 },
    { header: 'Item Name', key: 'item_name', width: 34 },
    { header: 'Description', key: 'description', width: 28 },
    { header: 'Qty', key: 'qty', width: 9 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Status', key: 'status', width: 10 }
  ];
  ws.getRow(1).font = { bold: true };

  for (const r of rows) {
    const descParts = [];
    if (r.batch_number) descParts.push(`Batch: ${r.batch_number}`);
    if (r.expiry_date) descParts.push(`Exp. Date: ${r.expiry_date}`);
    ws.addRow({
      month: r.month,
      date: r.date_issued,
      dr_no: r.display_dr_no === '' ? '' : r.display_dr_no,
      name: r.customer_name,
      address: r.delivery_address || '',
      tin: r.tin || '',
      terms: r.terms || '',
      item_no: r.item_seq_no || '',
      si_no: r.si_or_to_no || r.si_number || r.external_ref || '',
      item_name: r.item_name || '',
      description: descParts.join(' | '),
      qty: r.quantity || '',
      unit: r.unit || '',
      status: String(r.status || '').toUpperCase()
    });
  }

  return wb.xlsx.writeBuffer();
}

module.exports = {
  DR_ENTITY_PROFILES,
  PRINTABLE_ROWS_PER_PAGE,
  chunkPrintableRows,
  summarizeLineBatches,
  buildBatchesBySoLineItemId,
  issueSalesOrderDr,
  issueTransferOrderDr,
  listZohoTransferOrders,
  getZohoTransferOrderForDr,
  isExcludedTransferWarehouse,
  voidDeliveryReceipt,
  recordDrPrint,
  finalizeZohoInvoiceForOrder,
  shipInvoicedOrderInZoho,
  normalizeZohoDeliveryMethod,
  isTrackingExemptDeliveryMethod,
  getPrintableDr,
  listLedger,
  exportLedgerXlsx
};
