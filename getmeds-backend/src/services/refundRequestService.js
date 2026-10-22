'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { logEvent, resolveActor } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');
const teamScopeService = require('./teamScopeService');

/**
 * Refund requests for orders already paid for. Oct 22, 2026; reworked Oct 23, 2026 after Finance: "there is no void".
 *
 * The MedRep asks; Management decides. What happens next depends on where the order is and where the goods are:
 *
 *   draft            no Zoho Sales Order            Management cancels it; the refund goes on Finance's list.
 *   payment path     Sales Order or invoice, the    Management approves and the refund goes straight on Finance's list. Finance records the
 *                    goods are NOT coming back      customer's payment in Zoho first (if it is not there yet), refunds it in Zoho, then
 *                    (not shipped / customer keeps) records the refund here.
 *   return path      shipped and coming back        Dispatch checks the returned items (good condition or not) -> Management checks and
 *                                                   presses Refund -> Finance creates the credit note in Zoho; the app reads Zoho to
 *                                                   confirm it exists and is the right size -> Finance refunds and records it here.
 *
 * Nothing here writes to Zoho. The app only READS it (the invoice's payment, the credit note), and Finance's "Record refund" is
 * refused until the Zoho step the path needs is confirmed. The refund itself rides the existing fields on `orders`
 * (draft_cancel_*, refund_*), so Finance's Refunds page and the Record refund dialog keep working.
 *
 * Status: requested -> approved (return path, waiting for Dispatch) -> returned (waiting for Management) -> queued -> done | not_due
 *         requested -> queued (draft, payment path)        requested -> rejected | withdrawn        returned -> rejected
 * ('voided' is a leftover from the first version; it behaves like 'returned'.)
 */

const OPEN = ['requested', 'approved', 'returned', 'voided', 'queued'];
const GOODS = ['not_shipped', 'returning', 'customer_returns', 'customer_keeps'];
const GOODS_NEED_RETURN = ['returning', 'customer_returns'];
const CONDITIONS = ['good', 'damaged'];

class RefundError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new RefundError(status, code, message); };

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Where the order is. */
function stageOf(order) {
  if (order.zoho_invoice_id || order.zoho_invoice_number) return 'invoiced';
  if (order.zoho_so_id) return 'so';
  return 'draft';
}

/** draft, payment (goods not coming back) or return (goods coming back). */
function pathOf(r) {
  if (r.stage === 'draft') return 'draft';
  return GOODS_NEED_RETURN.includes(r.goods_status) ? 'return' : 'payment';
}

async function loadOrder(orderId) {
  return db.prepare(
    `SELECT o.*, c.name AS customer_name, c.zoho_contact_id AS customer_zoho_id, u.email AS medrep_email, u.name AS medrep_name
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
 * What Zoho says about the order's invoice, read-only: status, total, balance, and whether a payment is on it.
 * Prefers GET /invoices/{id}; falls back to the invoices listed on the Sales Order. Throws RefundError(502) when unreadable.
 */
async function zohoInvoiceState(order) {
  let inv = null;
  try {
    if (order.zoho_invoice_id && typeof zoho.getInvoice === 'function') {
      const r = await zoho.getInvoice(order.zoho_invoice_id);
      if (r && r.invoice) inv = r.invoice;
    }
  } catch (err) { /* fall through to the Sales Order's own list */ }
  if (!inv && order.zoho_so_id) {
    let r;
    try { r = await zoho.getSalesOrder(order.zoho_so_id); } catch (err) { fail(502, 'ZOHO_UNREADABLE', `Could not read Zoho: ${err.message}`); }
    const so = r && r.salesorder;
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
    status, total, balance,
    paymentApplied: status === 'paid' || status === 'partially_paid' || (total > 0 && balance < total - 0.005)
  };
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

/** Management rejects a new request, or (after Dispatch's check) goods that came back unusable. */
async function reject({ user, id, note }) {
  const text = String(note || '').trim();
  if (!text) fail(400, 'VALIDATION_ERROR', 'Say why: the requester reads it.');
  const r = await loadRequest(id);
  if (!['requested', 'returned', 'voided'].includes(r.status)) fail(409, 'NOT_PENDING', `This request is already ${r.status}.`);
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
  const path = pathOf({ ...r, stage });
  await touch(id, "stage = ?, status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, zoho_invoice_id = ?, zoho_invoice_number = ?",
    [stage, actor.id, now, decidedNote, order.zoho_invoice_id || null, order.zoho_invoice_number || null]);

  if (path === 'return') {
    await logEvent({ orderId: order.id, eventType: 'REFUND_REQUEST_APPROVED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name,
      notes: `Refund request approved by ${actor.name}.${decidedNote ? ` ${decidedNote}` : ''} Waiting for Dispatch to check the returned goods.`, metadata: { requestId: id, stage, path } });
    await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('dispatch'), message: `Refund approved for ${order.getmeds_order_id} (${peso(r.requested_amount)}): when the goods are back, check the items and record their condition.`, eventType: 'RETURN_CHECK_REQUESTED', orderData: order });
    await notify({ orderId: order.id, recipientIds: [r.requested_by, order.medrep_id].filter(Boolean), message: `Your refund request for ${order.getmeds_order_id} was approved by ${actor.name}. Dispatch will check the goods when they are back.`, eventType: 'REFUND_REQUEST_APPROVED', orderData: order });
    return shaped(id);
  }

  // Draft or payment path: straight to Finance's list. If Zoho already shows the customer's payment on the invoice, that
  // Finance step is recorded now (read-only check; a Zoho that cannot be read just leaves the step for Finance).
  if (path === 'payment' && stage === 'invoiced') {
    try {
      const inv = await zohoInvoiceState(order);
      if (inv.paymentApplied) await touch(id, 'payment_recorded_at = ?', [now]);
    } catch (err) { /* Finance checks it later */ }
  }
  await logEvent({ orderId: order.id, eventType: 'REFUND_REQUEST_APPROVED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name,
    notes: `Refund request approved by ${actor.name}.${decidedNote ? ` ${decidedNote}` : ''}`, metadata: { requestId: id, stage, path } });
  return queueRefund({ user, id });
}

// ── 4. Dispatch: the returned goods ──────────────────────────────────────────────────────────────
async function goodsChecked({ user, id, condition, note }) {
  const r = await loadRequest(id);
  if (r.status !== 'approved' || pathOf(r) !== 'return') fail(409, 'NOT_WAITING', 'This request is not waiting for a goods check.');
  const cond = String(condition || '');
  if (!CONDITIONS.includes(cond)) fail(400, 'VALIDATION_ERROR', 'Say whether the items came back in good condition or damaged.');
  const text = String(note || '').trim().slice(0, 500) || null;
  if (cond === 'damaged' && !text) fail(400, 'VALIDATION_ERROR', 'Say what is wrong with the items: Management reads it.');
  const order = await loadOrder(r.order_id);
  const actor = await resolveActor(user, 'dispatch');
  await touch(id, "status = 'returned', goods_condition = ?, goods_returned_by = ?, goods_returned_at = ?, goods_returned_note = ?", [cond, actor.id, new Date().toISOString(), text]);
  await logEvent({ orderId: order.id, eventType: 'GOODS_RETURNED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name,
    notes: `Returned goods checked by ${actor.name}: ${cond === 'good' ? 'good condition' : 'damaged'}.${text ? ` ${text}` : ''}`, metadata: { requestId: id, condition: cond } });
  await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('management', 'admin'), message: `Goods are back for ${order.getmeds_order_id}: ${cond === 'good' ? 'in good condition' : `DAMAGED (${text})`}. Check it and press Refund (${peso(r.requested_amount)}), or reject.`, eventType: 'RETURN_CHECKED', orderData: order });
  return shaped(id);
}

// ── 5. Finance: the Zoho step the path needs ─────────────────────────────────────────────────────
/** Payment path: the customer's payment is recorded in Zoho (checked against the invoice when there is one). */
async function paymentRecorded({ user, id }) {
  const r = await loadRequest(id);
  if (r.status !== 'queued' || pathOf(r) !== 'payment') fail(409, 'NOT_WAITING', 'This request is not waiting for a payment to be recorded.');
  if (r.payment_recorded_at) return shaped(id);
  const order = await loadOrder(r.order_id);
  let seen = 'confirmed by Finance (no invoice to read)';
  if (r.stage === 'invoiced') {
    const inv = await zohoInvoiceState(order);
    if (!inv.paymentApplied) fail(409, 'PAYMENT_NOT_IN_ZOHO', `Zoho shows no payment on ${inv.number} (status ${inv.status}, balance ${peso(inv.balance)} of ${peso(inv.total)}). Record the customer's payment in Zoho first, then check again.`);
    seen = `Zoho shows the payment on ${inv.number}`;
  }
  const actor = await resolveActor(user, 'finance');
  await touch(id, 'payment_recorded_by = ?, payment_recorded_at = ?', [actor.id, new Date().toISOString()]);
  await logEvent({ orderId: order.id, eventType: 'PAYMENT_RECORDED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Customer payment recorded in Zoho: ${seen}. Next: refund it in Zoho, then record the refund here.`, metadata: { requestId: id } });
  return shaped(id);
}

/** Return path: Finance's credit note exists in Zoho, belongs to this customer and is the right size. */
async function creditNoteChecked({ user, id, number }) {
  const r = await loadRequest(id);
  if (r.status !== 'queued' || pathOf(r) !== 'return') fail(409, 'NOT_WAITING', 'This request is not waiting for a credit note.');
  if (r.credit_note_checked_at) return shaped(id);
  const order = await loadOrder(r.order_id);
  const cnNumber = String(number || '').trim();
  const invoiceNumber = r.zoho_invoice_number || order.zoho_invoice_number || null;
  if (!cnNumber && !invoiceNumber) fail(400, 'VALIDATION_ERROR', 'Enter the credit note number from Zoho.');

  let rows;
  try {
    const res = await zoho.findCreditNotes(cnNumber ? { creditnote_number: cnNumber } : { reference_number: invoiceNumber });
    rows = (res && res.creditnotes) || [];
  } catch (err) { fail(502, 'ZOHO_UNREADABLE', `Could not read Zoho: ${err.message}`); }
  const usable = rows.filter((c) => !['void', 'draft'].includes(String(c.status || '').toLowerCase()));
  if (!usable.length) {
    fail(409, 'NO_CREDIT_NOTE', cnNumber
      ? `Zoho has no usable credit note numbered ${cnNumber} (it may be a draft or void).`
      : `Zoho shows no credit note for ${invoiceNumber} yet. Create it in Zoho, then check again (or enter its number).`);
  }
  const mine = order.customer_zoho_id ? usable.filter((c) => !c.customer_id || String(c.customer_id) === String(order.customer_zoho_id)) : usable;
  if (!mine.length) fail(409, 'WRONG_CUSTOMER', `That credit note belongs to another customer in Zoho, not ${order.customer_name}.`);
  const ask = Number(r.requested_amount) || 0;
  const match = mine.find((c) => Math.abs(Number(c.total) - ask) < 0.01);
  if (!match) {
    const t = mine.map((c) => `${c.creditnote_number} ${peso(c.total)}`).join(', ');
    fail(409, 'CREDIT_NOTE_AMOUNT', `The credit note in Zoho (${t}) is not ${peso(ask)}, the amount to refund. Fix the credit note in Zoho, or ask Management to change the amount.`);
  }
  const actor = await resolveActor(user, 'finance');
  await touch(id, 'credit_note_number = ?, credit_note_total = ?, credit_note_checked_by = ?, credit_note_checked_at = ?', [match.creditnote_number, Number(match.total), actor.id, new Date().toISOString()]);
  await logEvent({ orderId: order.id, eventType: 'CREDIT_NOTE_CONFIRMED', oldStatus: order.status, newStatus: order.status, actorId: actor.id, actorName: actor.name, notes: `Credit note ${match.creditnote_number} (${peso(match.total)}) confirmed in Zoho by ${actor.name}. Next: refund it in Zoho, then record the refund here.`, metadata: { requestId: id, creditnote: match.creditnote_number } });
  return shaped(id);
}

/**
 * Finance's "Record refund as done" is refused until the Zoho step is confirmed. Called by refunds.controller before a refund
 * that came from a request is marked done. No request, or a draft: nothing to check.
 */
async function assertReadyToPay(orderId) {
  const r = await db.prepare(`SELECT * FROM refund_requests WHERE order_id = ? AND status = 'queued' ORDER BY id DESC LIMIT 1`).get(orderId);
  if (!r) return;
  const p = pathOf(r);
  if (p === 'payment' && !r.payment_recorded_at) fail(409, 'PAYMENT_NOT_CONFIRMED', "Confirm the customer's payment is recorded in Zoho first (Refunds > Zoho steps), then record the refund.");
  if (p === 'return' && !r.credit_note_checked_at) fail(409, 'CREDIT_NOTE_NOT_CONFIRMED', 'Confirm the credit note in Zoho first (Refunds > Zoho steps), then record the refund.');
}

// ── 6. Put it on Finance's list ──────────────────────────────────────────────────────────────────
async function queueRefund({ user, id }) {
  const r = await loadRequest(id);
  const p = pathOf(r);
  const ready = p === 'return' ? ['returned', 'voided'].includes(r.status) : r.status === 'approved';
  if (!ready) fail(409, 'NOT_READY', p === 'return' ? 'Dispatch has to check the returned goods before the refund can go to Finance.' : `This request is ${r.status}.`);
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
      notes: `Order cancelled and ${peso(r.requested_amount)} put on Finance's refund list by ${actor.name}${p === 'return' ? ' (goods back and checked)' : ''}: ${r.reason}`,
      metadata: { requestId: id, stage: r.stage, path: p, amount: r.requested_amount }
    });
  })();
  const step = p === 'return' ? 'create the credit note in Zoho' : p === 'payment' ? "record the customer's payment in Zoho, then refund it there" : null;
  await notify({ orderId: order.id, recipientIds: await getUserIdsByRole('finance', 'admin'), message: `Refund to arrange: ${order.getmeds_order_id} (${peso(r.requested_amount)}${r.zoho_invoice_number ? `, ${r.zoho_invoice_number}` : ''}). ${step ? `First ${step}. ` : ''}Reason: ${r.reason}`, eventType: 'REFUND_QUEUED', orderData: order });
  await notify({ orderId: order.id, recipientIds: [r.requested_by, order.medrep_id].filter(Boolean), message: `Refund for ${order.getmeds_order_id} is with Finance now (${peso(r.requested_amount)}). You will see the status on the order.`, eventType: 'REFUND_QUEUED', orderData: order });
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

/** What this request is waiting for, as one short word the screens use. */
function nextStep(r) {
  const p = pathOf(r);
  if (r.status === 'requested') return 'management_decision';
  if (r.status === 'approved' && p === 'return') return 'dispatch_goods';
  if (['returned', 'voided'].includes(r.status)) return 'management_refund';
  if (r.status === 'queued') {
    if (p === 'payment' && !r.payment_recorded_at) return 'finance_payment';
    if (p === 'return' && !r.credit_note_checked_at) return 'finance_credit_note';
    return 'finance_refund';
  }
  return null;
}

const SHAPE = (r) => ({ ...r, requested_amount: num(r.requested_amount), amount_paid: num(r.amount_paid), total_amount: num(r.total_amount), path: pathOf(r), next: nextStep(r) });

async function listForManagement(tab) {
  const where = {
    needs_decision: "rr.status = 'requested'",
    waiting: "rr.status = 'approved'",
    ready: "rr.status IN ('returned', 'voided')",
    done: "rr.status IN ('queued', 'done', 'not_due', 'rejected', 'withdrawn')"
  }[tab] || '1 = 1';
  const rows = await db.prepare(`${BASE_SELECT} WHERE ${where} ORDER BY rr.requested_at DESC LIMIT 300`).all();
  const counts = await db.prepare(
    `SELECT COUNT(*) FILTER (WHERE status = 'requested') AS needs_decision, COUNT(*) FILTER (WHERE status = 'approved') AS waiting,
            COUNT(*) FILTER (WHERE status IN ('returned', 'voided')) AS ready FROM refund_requests`
  ).get();
  return { requests: rows.map(SHAPE), counts: { needs_decision: Number(counts.needs_decision), waiting: Number(counts.waiting), ready: Number(counts.ready) } };
}

/** Dispatch: approved refunds whose goods are coming back and have to be checked when they arrive. */
async function listReturnChecks() {
  const rows = await db.prepare(
    `${BASE_SELECT} WHERE rr.status = 'approved' AND rr.stage <> 'draft' AND rr.goods_status IN ('returning', 'customer_returns') ORDER BY rr.decided_at ASC LIMIT 100`
  ).all();
  return rows.map(SHAPE);
}

/** Heads-up for Dispatch: a return still waiting for Management's decision. Nothing to do yet. */
async function listUpcoming() {
  const rows = await db.prepare(
    `${BASE_SELECT} WHERE rr.status = 'requested' AND rr.stage <> 'draft' AND rr.goods_status IN ('returning', 'customer_returns') ORDER BY rr.requested_at ASC LIMIT 50`
  ).all();
  return rows.map(SHAPE);
}

/** Finance: refunds on its list that still need a Zoho step (record the payment, or the credit note). */
async function listFinanceSteps() {
  const rows = await db.prepare(
    `${BASE_SELECT} WHERE rr.status = 'queued' AND rr.stage <> 'draft'
        AND ((rr.goods_status NOT IN ('returning', 'customer_returns') AND rr.payment_recorded_at IS NULL)
          OR (rr.goods_status IN ('returning', 'customer_returns') AND rr.credit_note_checked_at IS NULL))
      ORDER BY rr.queued_at ASC LIMIT 100`
  ).all();
  return rows.map(SHAPE);
}

async function latestForOrder(orderId) {
  const r = await db.prepare(`${BASE_SELECT} WHERE rr.order_id = ? ORDER BY rr.id DESC LIMIT 1`).get(orderId);
  return r ? SHAPE(r) : null;
}

module.exports = {
  RefundError, OPEN, GOODS, stageOf, pathOf, canRequest, zohoInvoiceState,
  create, withdraw, reject, approve, goodsChecked, paymentRecorded, creditNoteChecked, assertReadyToPay, queueRefund,
  listForManagement, listReturnChecks, listUpcoming, listFinanceSteps, latestForOrder, loadRequest
};
