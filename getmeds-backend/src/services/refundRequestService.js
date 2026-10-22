'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { logEvent, resolveActor } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');
const teamScopeService = require('./teamScopeService');

/**
 * Refund requests for orders that are already paid for. Oct 22, 2026.
 *
 * Until now only a paid DRAFT could be refunded (orders.controller cancelDraft: cancel and keep
 * record, then Finance records the refund). Once an order had a Sales Order, or an invoice, there
 * was no way to ask for one. This is that path, in three cases decided by where the order is:
 *
 *   draft     no Zoho Sales Order       MedRep asks, Management approves: the order is cancelled and
 *                                       the refund goes on Finance's list.
 *   so        Sales Order, no invoice   same, and Dispatch closes the Sales Order in Zoho (does not
 *                                       hold the refund up).
 *   invoiced  has an invoice            MedRep asks, Management approves, then (as they apply):
 *                                       Finance removes the payment in Zoho, Dispatch records the goods
 *                                       as returned and voids the invoice IN ZOHO BY HAND, the app only
 *                                       READS Zoho to check; then Management presses Refund.
 *
 * Nothing here writes to Zoho (the write lock refuses deletes and voids on purpose). The refund
 * itself rides the existing fields on `orders` (draft_cancel_*, refund_*), so Finance's Refunds page,
 * the Record refund dialog and the summary keep working unchanged.
 *
 * Status: requested -> approved (invoiced only) -> voided -> queued -> done | not_due
 *         requested -> rejected | withdrawn
 */

const OPEN = ['requested', 'approved', 'voided', 'queued'];
const GOODS = ['not_shipped', 'returning', 'customer_returns', 'customer_keeps'];
const GOODS_NEED_RETURN = ['returning', 'customer_returns'];
const CLOSED_SO_STATUSES = ['void', 'cancelled'];

class RefundError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new RefundError(status, code, message); };

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Where the order is, which decides the path. */
function stageOf(order) {
  if (order.zoho_invoice_id || order.zoho_invoice_number) return 'invoiced';
  if (order.zoho_so_id) return 'so';
  return 'draft';
}

async function loadOrder(orderId) {
  return db.prepare(
    `SELECT o.*, c.name AS customer_name, u.email AS medrep_email, u.name AS medrep_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.medrep_id
      WHERE o.id = ?`
  ).get(orderId);
}

const shaped = async (id) => SHAPE(await loadRequest(id));

async function loadRequest(id) {
  const r = await db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(id);
  if (!r) fail(404, 'NOT_FOUND', 'Refund request not found.');
  return r;
}

/** May this person ask for a refund on this order? */
async function canRequest(user, order) {
  const role = String(user.role || '').toLowerCase();
  if (role === 'admin' || role === 'management') return true;
  if (role === 'medrep') return order.medrep_id === user.id || order.raised_by_id === user.id;
  if (role === 'team_lead') {
    if (order.medrep_id === user.id || order.raised_by_id === user.id) return true;
    const ids = await teamScopeService.teamMedrepIds(user.id);
    return Array.isArray(ids) ? ids.includes(order.medrep_id) : Boolean(ids && ids.has && ids.has(order.medrep_id));
  }
  return false;
}

/**
 * What Zoho says about the order's invoice, read-only. Prefers GET /invoices/{id}; falls back to the
 * invoices listed on the Sales Order. Throws RefundError(502) when Zoho cannot be read.
 */
async function zohoInvoiceState(order) {
  let inv = null;
  let so = null;
  try {
    if (order.zoho_invoice_id && typeof zoho.getInvoice === 'function') {
      const r = await zoho.getInvoice(order.zoho_invoice_id);
      if (r && r.invoice) inv = r.invoice;
    }
  } catch (err) { /* fall through to the Sales Order's own list */ }
  if (!inv && order.zoho_so_id) {
    let r;
    try { r = await zoho.getSalesOrder(order.zoho_so_id); } catch (err) { fail(502, 'ZOHO_UNREADABLE', `Could not read Zoho: ${err.message}`); }
    so = r && r.salesorder;
    if (!so) fail(502, 'ZOHO_UNREADABLE', `Could not read the Sales Order from Zoho${r && r.message ? ` (${r.message})` : ''}.`);
    const list = Array.isArray(so.invoices) ? so.invoices : [];
    inv = list.find((i) => order.zoho_invoice_id && String(i.invoice_id) === String(order.zoho_invoice_id))
      || list.find((i) => order.zoho_invoice_number && i.invoice_number === order.zoho_invoice_number)
      || list.find((i) => String(i.status).toLowerCase() !== 'void')
      || list[0] || null;
  }
  if (!inv) fail(502, 'ZOHO_UNREADABLE', 'Zoho did not return this invoice.');
  const status = String(inv.status || '').toLowerCase();
  const total = Number(inv.total) || 0;
  const balance = inv.balance === undefined || inv.balance === null ? total : Number(inv.balance);
  return {
    number: inv.invoice_number || order.zoho_invoice_number || null,
    id: inv.invoice_id || order.zoho_invoice_id || null,
    status, total, balance,
    voided: status === 'void',
    paymentApplied: status === 'paid' || status === 'partially_paid' || (total > 0 && balance < total - 0.005)
  };
}

async function zohoSalesOrderStatus(order) {
  let r;
  try { r = await zoho.getSalesOrder(order.zoho_so_id); } catch (err) { fail(502, 'ZOHO_UNREADABLE', `Could not read Zoho: ${err.message}`); }
  const so = r && r.salesorder;
  if (!so) fail(502, 'ZOHO_UNREADABLE', `Could not read the Sales Order from Zoho${r && r.message ? ` (${r.message})` : ''}.`);
  return String(so.status || '').toLowerCase();
}

const touch = (id, sets, params) =>
  db.prepare(`UPDATE refund_requests SET ${sets}, updated_at = ? WHERE id = ?`).run(...params, new Date().toISOString(), id);

// ── 1. The MedRep (or Team Lead, Management, Admin) asks ─────────────────────────────────────────
async function create({ user, orderId, reason, goodsStatus, amount }) {
  const text = String(reason || '').trim();
  if (!text) fail(400, 'VALIDATION_ERROR', 'Say why the customer wants a refund: Management reads it first.');
  if (text.length > 500) fail(400, 'VALIDATION_ERROR', 'The reason is too long (500 characters at most).');

  const order = await loadOrder(orderId);
  if (!order) fail(404, 'NOT_FOUND', 'Order not found.');
  if (!(await canRequest(user, order))) fail(403, 'FORBIDDEN', 'Only the person who owns or raised this order (or their Team Lead) can ask for a refund.');
  if (['cancelled', 'deleted'].includes(order.status)) fail(409, 'NOT_REFUNDABLE', `This order is ${order.status}, so there is nothing to refund.`);

  const open = await db.prepare(`SELECT id FROM refund_requests WHERE order_id = ? AND status = ANY(?)`).get(order.id, [OPEN]);
  if (open) fail(409, 'ALREADY_REQUESTED', 'A refund request is already open for this order.');

  const stage = stageOf(order);
  const goods = stage === 'draft' ? 'not_shipped' : String(goodsStatus || '');
  if (!GOODS.includes(goods)) fail(400, 'VALIDATION_ERROR', 'Say where the goods are: not shipped, coming back to us, delivered (customer returns them), or the customer keeps them.');

  const total = Number(order.total_amount) || 0;
  const asked = amount === undefined || amount === null || amount === '' ? total : Number(amount);
  if (!Number.isFinite(asked) || asked <= 0) fail(400, 'VALIDATION_ERROR', 'Enter the amount to refund.');
  if (asked > total + 0.005) fail(400, 'VALIDATION_ERROR', `The refund cannot be more than the order total (${peso(total)}).`);

  const actor = await resolveActor(user, String(user.role || '').toLowerCase());
  const now = new Date().toISOString();
  const ins = await db.prepare(
    `INSERT INTO refund_requests (order_id, requested_by, requested_at, reason, requested_amount, amount_paid, goods_status, stage,
                                  status, zoho_invoice_id, zoho_invoice_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`
  ).run(order.id, actor.id, now, text, asked, total, goods, stage, order.zoho_invoice_id || null, order.zoho_invoice_number || null, now, now);
  const id = ins.lastInsertRowid;

  await logEvent({
    orderId: order.id, eventType: 'REFUND_REQUESTED', oldStatus: order.status, newStatus: order.status,
    actorId: actor.id, actorName: actor.name,
    notes: `Refund requested by ${actor.name} (${peso(asked)}): ${text}`,
    metadata: { requestId: id, stage, goods_status: goods, amount: asked }
  });
  const managers = (await getUserIdsByRole('management', 'admin')).filter((x) => x !== actor.id);
  await notify({
    orderId: order.id, recipientIds: managers,
    message: `Refund requested for ${order.getmeds_order_id} (${peso(asked)}, ${stage === 'invoiced' ? 'invoiced' : stage === 'so' ? 'Sales Order, not invoiced' : 'draft'}) by ${actor.name}: ${text}`,
    eventType: 'REFUND_REQUESTED', orderData: order
  });
  return shaped(id);
}

// ── 2. Withdraw / reject ─────────────────────────────────────────────────────────────────────────
async function withdraw({ user, id }) {
  const r = await loadRequest(id);
  const role = String(user.role || '').toLowerCase();
  if (r.requested_by !== user.id && role !== 'admin') fail(403, 'FORBIDDEN', 'Only the person who asked can withdraw it.');
  if (r.status !== 'requested') fail(409, 'TOO_LATE', 'Management has already decided, so it can no longer be withdrawn.');
  const order = await loadOrder(r.order_id);
  const actor = await resolveActor(user, role);
  await touch(id, "status = 'withdrawn', decided_at = ?, decided_by = ?, decision_note = ?", [new Date().toISOString(), actor.id, 'Withdrawn by the requester']);
  await logEvent({ orderId: order.id, eventType: 'REFUND_REQUEST_WITHDRAWN', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Refund request withdrawn by ${actor.name}.`, metadata: { requestId: id } });
  return shaped(id);
}

async function reject({ user, id, note }) {
  const text = String(note || '').trim();
  if (!text) fail(400, 'VALIDATION_ERROR', 'Say why: the requester reads it.');
  const r = await loadRequest(id);
  if (r.status !== 'requested') fail(409, 'NOT_PENDING', `This request is already ${r.status}.`);
  const order = await loadOrder(r.order_id);
  const actor = await resolveActor(user, 'management');
  await touch(id, "status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?", [actor.id, new Date().toISOString(), text]);
  await logEvent({ orderId: order.id, eventType: 'REFUND_REQUEST_REJECTED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Refund request rejected by ${actor.name}: ${text}`, metadata: { requestId: id, note: text } });
  await notify({ orderId: order.id, recipientIds: [r.requested_by, order.medrep_id].filter(Boolean), message: `The refund request for ${order.getmeds_order_id} was rejected by ${actor.name}: ${text}`, eventType: 'REFUND_REQUEST_REJECTED', orderData: order });
  return shaped(id);
}

// ── 3. Management approves ───────────────────────────────────────────────────────────────────────
async function approve({ user, id, note }) {
  const r = await loadRequest(id);
  if (r.status !== 'requested') fail(409, 'NOT_PENDING', `This request is already ${r.status}.`);
  const order = await loadOrder(r.order_id);
  if (!order || ['cancelled', 'deleted'].includes(order.status)) fail(409, 'NOT_REFUNDABLE', 'This order was cancelled in the meantime.');
  const actor = await resolveActor(user, 'management');
  const decidedNote = String(note || '').trim() || null;
  const now = new Date().toISOString();

  // The stage is read again: an order may have been invoiced since it was asked for.
  const stage = stageOf(order);
  if (stage !== 'invoiced') {
    await touch(id, "stage = ?, status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?", [stage, actor.id, now, decidedNote]);
    await logEvent({ orderId: order.id, eventType: 'REFUND_REQUEST_APPROVED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Refund request approved by ${actor.name}.${decidedNote ? ` ${decidedNote}` : ''}`, metadata: { requestId: id, stage } });
    return queueRefund({ user, id, viaApprove: true });
  }

  // Invoiced: read Zoho once so Finance and Dispatch know what is waiting for them.
  let inv = null;
  let unreadable = null;
  try { inv = await zohoInvoiceState(order); } catch (err) { unreadable = err.message; }
  const paymentApplied = inv ? inv.paymentApplied : null; // null: could not be read, Finance and Dispatch check later
  const alreadyVoid = Boolean(inv && inv.voided);
  await touch(id, `stage = 'invoiced', status = ?, decided_by = ?, decided_at = ?, decision_note = ?, zoho_invoice_id = ?, zoho_invoice_number = ?, payment_applied = ?, voided_at = ?, voided_by = ?`,
    [alreadyVoid ? 'voided' : 'approved', actor.id, now, decidedNote, inv?.id || order.zoho_invoice_id || null, inv?.number || order.zoho_invoice_number || null, paymentApplied, alreadyVoid ? now : null, alreadyVoid ? actor.id : null]);
  await logEvent({
    orderId: order.id, eventType: 'REFUND_REQUEST_APPROVED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name,
    notes: `Refund request approved by ${actor.name}.${decidedNote ? ` ${decidedNote}` : ''} ` +
      (alreadyVoid ? 'The invoice is already void in Zoho.' : `Waiting for ${paymentApplied ? 'Finance to remove the payment, ' : ''}Dispatch to ${GOODS_NEED_RETURN.includes(r.goods_status) ? 'record the goods as returned and ' : ''}void ${inv?.number || order.zoho_invoice_number} in Zoho.`) +
      (unreadable ? ` (Zoho could not be read just now: ${unreadable})` : ''),
    metadata: { requestId: id, stage, payment_applied: paymentApplied, already_void: alreadyVoid }
  });
  if (!alreadyVoid) {
    const dispatch = await getUserIdsByRole('dispatch');
    await notify({ orderId: order.id, recipientIds: dispatch, message: `Void ${inv?.number || order.zoho_invoice_number} in Zoho for ${order.getmeds_order_id}: Management approved a refund (${r.reason}).${paymentApplied ? ' Finance is removing the payment first.' : ''}`, eventType: 'VOID_REQUESTED', orderData: order });
    if (paymentApplied !== false) {
      const finance = await getUserIdsByRole('finance');
      await notify({ orderId: order.id, recipientIds: finance, message: `Remove the payment from ${inv?.number || order.zoho_invoice_number} in Zoho (${order.getmeds_order_id}, ${peso(r.amount_paid)}) so Dispatch can void it: refund approved.`, eventType: 'PAYMENT_REMOVAL_REQUESTED', orderData: order });
    }
  }
  await notify({ orderId: order.id, recipientIds: [r.requested_by, order.medrep_id].filter(Boolean), message: `Your refund request for ${order.getmeds_order_id} was approved by ${actor.name}. ${alreadyVoid ? 'The invoice is already void; Management will send it to Finance.' : 'Dispatch and Finance are clearing the invoice in Zoho first.'}`, eventType: 'REFUND_REQUEST_APPROVED', orderData: order });
  return shaped(id);
}

// ── 4. Finance: the payment is off the invoice ───────────────────────────────────────────────────
async function paymentRemoved({ user, id }) {
  const r = await loadRequest(id);
  if (r.status !== 'approved' || r.stage !== 'invoiced') fail(409, 'NOT_WAITING', 'This request is not waiting for a payment to be removed.');
  const order = await loadOrder(r.order_id);
  const inv = await zohoInvoiceState(order);
  if (inv.paymentApplied && !inv.voided) {
    fail(409, 'PAYMENT_STILL_APPLIED', `Zoho still shows a payment on ${inv.number} (status ${inv.status}, balance ${peso(inv.balance)} of ${peso(inv.total)}). Remove it in Zoho first.`);
  }
  const actor = await resolveActor(user, 'finance');
  const now = new Date().toISOString();
  await touch(id, 'payment_applied = ?, payment_removed_by = ?, payment_removed_at = ?', [r.payment_applied === null ? false : r.payment_applied, actor.id, now]);
  await logEvent({ orderId: order.id, eventType: 'PAYMENT_REMOVED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Payment removed from ${inv.number} in Zoho, confirmed by ${actor.name}: Zoho shows no payment on it.`, metadata: { requestId: id, invoice: inv.number } });
  await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('dispatch'), message: `${inv.number} (${order.getmeds_order_id}) has no payment on it any more: Dispatch can void it in Zoho${GOODS_NEED_RETURN.includes(r.goods_status) && !r.goods_returned_at ? ' once the goods are recorded as returned' : ''}.`, eventType: 'PAYMENT_REMOVED', orderData: order });
  return shaped(id);
}

// ── 5. Dispatch: goods returned, then void (by hand in Zoho), then check ─────────────────────────
async function goodsReturned({ user, id, note }) {
  const r = await loadRequest(id);
  if (r.status !== 'approved') fail(409, 'NOT_WAITING', 'This request is not waiting for the goods.');
  if (!GOODS_NEED_RETURN.includes(r.goods_status)) fail(409, 'NOT_NEEDED', 'The customer keeps the goods on this request, so there is nothing to record as returned.');
  if (r.goods_returned_at) return SHAPE(r);
  const order = await loadOrder(r.order_id);
  const actor = await resolveActor(user, 'dispatch');
  const text = String(note || '').trim().slice(0, 500) || null;
  await touch(id, 'goods_returned_by = ?, goods_returned_at = ?, goods_returned_note = ?', [actor.id, new Date().toISOString(), text]);
  await logEvent({ orderId: order.id, eventType: 'GOODS_RETURNED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Goods recorded as returned by ${actor.name}.${text ? ` ${text}` : ''}`, metadata: { requestId: id } });
  return shaped(id);
}

async function checkVoid({ user, id }) {
  const r = await loadRequest(id);
  if (r.status !== 'approved' || r.stage !== 'invoiced') fail(409, 'NOT_WAITING', 'This request is not waiting for the invoice to be voided.');
  if (GOODS_NEED_RETURN.includes(r.goods_status) && !r.goods_returned_at) {
    fail(409, 'GOODS_NOT_RECORDED', 'Record the goods as returned first.');
  }
  const order = await loadOrder(r.order_id);
  const inv = await zohoInvoiceState(order);
  if (!inv.voided) {
    if (inv.paymentApplied) fail(409, 'PAYMENT_STILL_APPLIED', `Zoho still shows a payment on ${inv.number}. Finance has to remove it before the invoice can be voided.`);
    fail(409, 'NOT_VOID_YET', `Zoho still says ${inv.number} is ${inv.status === 'void' ? 'void' : inv.status.replace(/_/g, ' ')}. Void it in Zoho first, then check again.`);
  }
  const actor = await resolveActor(user, 'dispatch');
  const now = new Date().toISOString();
  await touch(id, "status = 'voided', voided_by = ?, voided_at = ?", [actor.id, now]);
  await logEvent({ orderId: order.id, eventType: 'INVOICE_VOIDED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `${inv.number} confirmed void by ${actor.name}: Zoho reports it as void.`, metadata: { requestId: id, invoice: inv.number } });
  await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('management', 'admin'), message: `${inv.number} is void in Zoho (${order.getmeds_order_id}): press Refund to put ${peso(r.requested_amount)} on Finance's list.`, eventType: 'INVOICE_VOIDED', orderData: order });
  return shaped(id);
}

/** Case B: the Sales Order is closed in Zoho too. Never holds the refund up. */
async function checkSalesOrderClosed({ user, id }) {
  const r = await loadRequest(id);
  if (r.stage !== 'so') fail(409, 'NOT_NEEDED', 'This request has no open Sales Order to close.');
  if (r.so_closed_at) return SHAPE(r);
  const order = await loadOrder(r.order_id);
  const status = await zohoSalesOrderStatus(order);
  if (!CLOSED_SO_STATUSES.includes(status)) fail(409, 'SO_STILL_OPEN', `Zoho still says ${order.zoho_so_number} is ${status.replace(/_/g, ' ')}. Void or cancel it in Zoho first, then check again.`);
  const actor = await resolveActor(user, 'dispatch');
  await touch(id, 'so_closed_by = ?, so_closed_at = ?', [actor.id, new Date().toISOString()]);
  await logEvent({ orderId: order.id, eventType: 'SALES_ORDER_CLOSED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `${order.zoho_so_number} confirmed ${status} in Zoho by ${actor.name}.`, metadata: { requestId: id } });
  return shaped(id);
}

// ── 6. Put it on Finance's list ──────────────────────────────────────────────────────────────────
async function queueRefund({ user, id, viaApprove = false }) {
  const r = await loadRequest(id);
  const ready = r.stage === 'invoiced' ? r.status === 'voided' : r.status === 'approved';
  if (!ready) fail(409, 'NOT_READY', r.stage === 'invoiced' ? 'The invoice has to be confirmed void before the refund can go to Finance.' : `This request is ${r.status}.`);
  const order = await loadOrder(r.order_id);
  const actor = await resolveActor(user, 'management');
  const now = new Date().toISOString();
  const kept = Number(r.amount_paid || order.total_amount) || 0;

  await db.transaction(async () => {
    // The order is cancelled (direct update: the state machine has no cancelled edge from every stage).
    await db.prepare(
      `UPDATE orders SET status = 'cancelled', draft_cancelled_at = ?, draft_cancelled_by = ?, draft_cancel_reason = ?, draft_cancel_kind = 'keep_record',
                         refund_status = 'pending', refund_received_amount = ?, refund_amount = NULL, refund_reference = NULL, refund_at = NULL,
                         refund_note = NULL, refund_by = NULL, refund_updated_at = NULL, updated_at = ? WHERE id = ?`
    ).run(now, actor.id, `Refund: ${r.reason}`, kept, now, order.id);
    if (order.stock_hold_at) {
      await db.prepare('UPDATE orders SET stock_hold_at = NULL, stock_hold_by = NULL, stock_hold_reason = NULL, stock_hold_item = NULL, stock_hold_reminded_at = NULL WHERE id = ?').run(order.id);
    }
    await touch(id, "status = 'queued', queued_by = ?, queued_at = ?", [actor.id, now]);
    await logEvent({
      orderId: order.id, eventType: 'REFUND_QUEUED', oldStatus: order.status, newStatus: 'cancelled', actorId: actor.id, actorName: actor.name,
      notes: `Order cancelled and ${peso(r.requested_amount)} put on Finance's refund list by ${actor.name}${viaApprove ? '' : ' (the invoice is void in Zoho)'}: ${r.reason}`,
      metadata: { requestId: id, stage: r.stage, amount: r.requested_amount }
    });
  })();
  await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('finance', 'admin'), message: `Refund to arrange: ${order.getmeds_order_id} (${peso(r.requested_amount)}, ${r.stage === 'invoiced' ? `invoice ${r.zoho_invoice_number} void` : r.stage === 'so' ? 'Sales Order' : 'draft'}). Reason: ${r.reason}`, eventType: 'REFUND_QUEUED', orderData: order });
  await notify({ orderId: order.id, recipientIds: [r.requested_by, order.medrep_id].filter(Boolean), message: `Refund for ${order.getmeds_order_id} is with Finance now (${peso(r.requested_amount)}). You will see the status on the order.`, eventType: 'REFUND_QUEUED', orderData: order });

  // Case B: Dispatch is asked to close the Sales Order in Zoho (does not hold the refund up).
  if (r.stage === 'so') {
    await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('dispatch'), message: `Void or cancel ${order.zoho_so_number} in Zoho (${order.getmeds_order_id}): refund approved, its stock is still committed.`, eventType: 'VOID_REQUESTED', orderData: order });
  }
  return shaped(id);
}

// ── Lists ────────────────────────────────────────────────────────────────────────────────────────
const BASE_SELECT = `
  SELECT rr.*, o.getmeds_order_id, o.status AS order_status, o.total_amount, o.zoho_so_id, o.zoho_so_number, o.division,
         c.name AS customer_name, ru.name AS requested_by_name, mu.name AS medrep_name, du.name AS decided_by_name
    FROM refund_requests rr
    JOIN orders o ON o.id = rr.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users ru ON ru.id = rr.requested_by
    LEFT JOIN users mu ON mu.id = o.medrep_id
    LEFT JOIN users du ON du.id = rr.decided_by`;

const SHAPE = (r) => ({
  ...r,
  requested_amount: num(r.requested_amount), amount_paid: num(r.amount_paid), total_amount: num(r.total_amount),
  needs_goods: GOODS_NEED_RETURN.includes(r.goods_status) && !r.goods_returned_at,
  needs_payment_removed: r.payment_applied !== false && !r.payment_removed_at && r.status === 'approved' && r.stage === 'invoiced',
  next: nextStep(r)
});

/** What this request is waiting for, as one short word the screens use. */
function nextStep(r) {
  if (r.status === 'requested') return 'management_decision';
  if (r.status === 'approved' && r.stage === 'invoiced') {
    if (r.payment_applied !== false && !r.payment_removed_at) return 'finance_payment';
    if (GOODS_NEED_RETURN.includes(r.goods_status) && !r.goods_returned_at) return 'dispatch_goods';
    return 'dispatch_void';
  }
  if (r.status === 'voided') return 'management_refund';
  if (r.status === 'queued') return 'finance_refund';
  return null;
}

async function listForManagement(tab) {
  const where = {
    needs_decision: "rr.status = 'requested'",
    waiting: "rr.status = 'approved'",
    ready: "rr.status = 'voided'",
    done: "rr.status IN ('queued', 'done', 'not_due', 'rejected', 'withdrawn')"
  }[tab] || '1 = 1';
  const rows = await db.prepare(`${BASE_SELECT} WHERE ${where} ORDER BY rr.requested_at DESC LIMIT 300`).all();
  const counts = await db.prepare(
    `SELECT COUNT(*) FILTER (WHERE status = 'requested') AS needs_decision, COUNT(*) FILTER (WHERE status = 'approved') AS waiting,
            COUNT(*) FILTER (WHERE status = 'voided') AS ready FROM refund_requests`
  ).get();
  return { requests: rows.map(SHAPE), counts: { needs_decision: Number(counts.needs_decision), waiting: Number(counts.waiting), ready: Number(counts.ready) } };
}

/** Dispatch's card: invoiced requests waiting on the void, and case B Sales Orders still to close. */
async function listVoidRequests() {
  const rows = await db.prepare(
    `${BASE_SELECT}
      WHERE (rr.stage = 'invoiced' AND rr.status = 'approved')
         OR (rr.stage = 'so' AND rr.status = 'queued' AND rr.so_closed_at IS NULL)
      ORDER BY rr.decided_at ASC LIMIT 100`
  ).all();
  return rows.map(SHAPE);
}

/** Heads-up for Dispatch: invoiced or Sales Order requests still waiting for Management. Nothing to do yet. */
async function listUpcoming() {
  const rows = await db.prepare(
    `${BASE_SELECT} WHERE rr.status = 'requested' AND rr.stage IN ('invoiced', 'so') ORDER BY rr.requested_at ASC LIMIT 50`
  ).all();
  return rows.map(SHAPE);
}

async function listPaymentsToRemove() {
  const rows = await db.prepare(
    `${BASE_SELECT} WHERE rr.stage = 'invoiced' AND rr.status = 'approved' AND rr.payment_applied IS NOT FALSE AND rr.payment_removed_at IS NULL
      ORDER BY rr.decided_at ASC LIMIT 100`
  ).all();
  return rows.map(SHAPE);
}

async function latestForOrder(orderId) {
  const r = await db.prepare(`${BASE_SELECT} WHERE rr.order_id = ? ORDER BY rr.id DESC LIMIT 1`).get(orderId);
  return r ? SHAPE(r) : null;
}

module.exports = {
  RefundError, OPEN, GOODS, stageOf, canRequest, zohoInvoiceState,
  create, withdraw, reject, approve, paymentRemoved, goodsReturned, checkVoid, checkSalesOrderClosed, queueRefund,
  listForManagement, listVoidRequests, listUpcoming, listPaymentsToRemove, latestForOrder, loadRequest
};
