const db = require('../db/database');
const zoho = require('../integrations/zoho');
const stateMachine = require('../workflow/stateMachine');
const { logEvent, resolveActor } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');
const { evaluateCompletion } = require('./orderCompletionService');
const { claimOrder, releaseClaim, describeClaim } = require('./orderClaimService');
const { zohoWriteMode } = require('./zohoWriteGuard');

/**
 * Finance confirms, Dispatch works in Getmeds — the actions behind the new
 * buttons (field guide, chapter 12, "Build plan").
 *
 * Sep 12, 2026. Until now Finance confirmed Sales Orders and Dispatch invoiced,
 * packed and shipped inside Zoho, and this app only heard about it afterwards.
 * Under GETMEDS_WORKFLOW_V2 those steps are pressed here and this app makes the
 * matching change in Zoho.
 *
 * Every action runs the same five steps, in this order, and the order matters:
 *
 *   1. Claim   Move nothing unless the order is still at the step this action
 *              expects AND nobody else is acting on it (orderClaimService).
 *              Two people pressing the same button get one Zoho write, not two.
 *   2. Look    Re-read the Sales Order from Zoho. Stop if it was voided there;
 *              adopt an invoice, package or shipment someone already made there
 *              instead of making a second one.
 *   3. Write   Make the change in Zoho — OUTSIDE any database transaction.
 *              On Vercel each server copy has a single database connection
 *              (db/pg.js), so holding a transaction across a slow Zoho call
 *              would make every other request on that copy wait.
 *   4. Record  One transaction: the new status (only if our claim still holds),
 *              the Zoho IDs, and the history lines.
 *   5. Notify  After the save, never inside it — a slow mail server must not
 *              hold the transaction open either.
 *
 * History lines use the same ZOHO_* event types the webhook and the reconcile
 * already use, with `source: 'getmeds'` in their metadata. That is what lets
 * the reconcile's "already recorded?" checks (zohoReconcileService.js) and the
 * webhook's duplicate checks recognise these as done, so Zoho reporting back
 * the change this app just made is not logged — or emailed — a second time.
 */

class WorkflowError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const VOID_STATUSES = ['void', 'voided', 'cancelled'];
const INVOICE_ISSUED = ['sent', 'overdue', 'partially_paid', 'paid', 'viewed'];

/**
 * Today's date as Zoho's org sees it. The org runs on Manila time, so a UTC
 * date would put anything done before 8 am on the previous day — the same
 * reason zohoOrderImportService reads ZOHO_ORG_UTC_OFFSET.
 */
function zohoToday() {
  const raw = String(process.env.ZOHO_ORG_UTC_OFFSET || '+08:00').trim();
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(raw);
  const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 480;
  return new Date(Date.now() + minutes * 60000).toISOString().slice(0, 10);
}

async function loadOrder(orderId) {
  return db.prepare(`
    SELECT o.*, c.name AS customer_name, c.zoho_contact_id AS customer_zoho_contact_id,
           u.id AS medrep_user_id, u.email AS medrep_email,
           d.id AS dispatch_id, d.status AS dispatch_status, d.courier, d.tracking_number,
           d.zoho_package_id, d.zoho_package_number, d.zoho_shipment_id, d.zoho_shipment_number,
           d.delivered_at
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN dispatch_records d ON d.order_id = o.id
     WHERE o.id = ?
  `).get(orderId);
}

/** Step 2: read the Sales Order back from Zoho, and refuse a voided one. */
async function lookAtSalesOrder(order) {
  let res;
  try {
    res = await zoho.getSalesOrder(order.zoho_so_id);
  } catch (err) {
    throw new WorkflowError(502, 'ZOHO_UNREACHABLE', `Could not read Sales Order ${order.zoho_so_number || order.zoho_so_id} from Zoho: ${err.message}`);
  }
  const so = res && res.salesorder;
  if (!so || (res.code && res.code !== 0)) {
    throw new WorkflowError(409, 'ZOHO_SO_NOT_FOUND', `Sales Order ${order.zoho_so_number || order.zoho_so_id} could not be found in Zoho.`);
  }
  if (VOID_STATUSES.includes(String(so.status || '').toLowerCase())) {
    throw new WorkflowError(409, 'VOIDED_IN_ZOHO', `Sales Order ${so.salesorder_number || order.zoho_so_number} was voided in Zoho. Nothing was changed.`);
  }
  return so;
}

/**
 * Step 4's status write. Conditional on our claim, so a request that lost its
 * claim (it went stale and someone else took over) cannot overwrite theirs.
 * Clears the claim in the same statement.
 */
async function moveStatus(order, token, toStatus, now, via = []) {
  const hops = [order.status, ...via, toStatus];
  for (let i = 0; i < hops.length - 1; i++) {
    if (hops[i] !== hops[i + 1] && !stateMachine.canTransition(hops[i], hops[i + 1])) {
      throw new WorkflowError(409, 'INVALID_TRANSITION', `Cannot move from ${hops[i]} to ${hops[i + 1]}.`);
    }
  }
  const res = await db
    .prepare('UPDATE orders SET status = ?, updated_at = ?, action_claim = NULL, action_claim_at = NULL WHERE id = ? AND action_claim = ?')
    .run(toStatus, now, order.id, token);
  if (res.changes !== 1) {
    throw new WorkflowError(409, 'CLAIM_LOST', 'Someone else changed this order while you were working on it. Refresh and check it before trying again.');
  }
}

/**
 * Step 3's wrapper. Zoho refusing, or not answering, becomes a message the
 * person can act on. Nothing has been saved here at this point, and the next
 * attempt re-reads the Sales Order first — so if Zoho did make the change
 * before the connection dropped, the retry adopts it instead of repeating it.
 */
async function inZoho(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    throw new WorkflowError(
      502,
      'ZOHO_WRITE_FAILED',
      `Zoho did not ${what}: ${err.message}. Nothing was changed in Getmeds. Try again — if Zoho did make it, the next try records it rather than making a second one.`
    );
  }
}

/** Step 5. A failed notification is logged, never allowed to undo the step. */
async function notifySafely(args) {
  try {
    await notify(args);
  } catch (err) {
    console.error(`[WORKFLOW] notification ${args.eventType} failed for order ${args.orderId}:`, err.message);
  }
}

/**
 * Steps 1 and 2, then hands over to the action. Releases the claim on the way
 * out if the action did not already clear it (an error, or a step that moved
 * nothing).
 */
async function runStep({ orderId, user, actorRole, label, fromStatuses, needsZoho = true }, perform) {
  const order = await loadOrder(orderId);
  if (!order) throw new WorkflowError(404, 'NOT_FOUND', 'Order not found');
  if (!fromStatuses.includes(order.status)) {
    throw new WorkflowError(409, 'NOT_AT_THIS_STEP', `This order is at "${order.status}", so "${label}" is not its next step.`);
  }
  if (needsZoho && !order.zoho_so_id) {
    throw new WorkflowError(409, 'NO_ZOHO_SALES_ORDER', 'This order has no Zoho Sales Order yet, so there is nothing to act on in Zoho.');
  }

  const actor = await resolveActor(user, actorRole);
  const token = await claimOrder(order.id, fromStatuses, `${label} by ${actor.name || 'another user'}`);
  if (!token) {
    const now = await db.prepare('SELECT status, action_claim FROM orders WHERE id = ?').get(order.id);
    const who = describeClaim(now && now.action_claim);
    throw new WorkflowError(
      409,
      'ALREADY_IN_PROGRESS',
      who ? `Someone is already working on this order: ${who}.` : `This order has just moved to "${now && now.status}". Refresh to see it.`
    );
  }

  try {
    let dryRun = false;
    let so = null;
    if (needsZoho) {
      const guard = zohoWriteMode(order.customer_zoho_contact_id);
      if (guard.mode === 'blocked') throw new WorkflowError(409, guard.code, guard.message);
      dryRun = guard.mode === 'dry-run';
      if (!dryRun) so = await lookAtSalesOrder(order);
    }
    return await perform({ order, actor, token, dryRun, so, now: new Date().toISOString() });
  } finally {
    await releaseClaim(order.id, token);
  }
}

// ─── Finance ────────────────────────────────────────────────────────────────

/**
 * Finance's one button: prices and proof of payment checked, so confirm the
 * Sales Order in Zoho. Replaces "confirm in Zoho, then Verify account here".
 */
async function confirmOrder({ orderId, user, pricesChecked, proofChecked }) {
  if (pricesChecked !== true || proofChecked !== true) {
    throw new WorkflowError(400, 'CHECKS_REQUIRED', 'Tick both checks before confirming — the prices, and the proof of payment.');
  }
  return runStep({ orderId, user, actorRole: 'finance', label: 'Confirm order', fromStatuses: ['so_created'] }, async ({ order, actor, token, dryRun, so, now }) => {
    let adopted = false;
    if (!dryRun) {
      if (String(so.status || '').toLowerCase() === 'draft') {
        await inZoho('confirm the Sales Order', () => zoho.markSalesOrderConfirmed(order.zoho_so_id));
      } else {
        adopted = true; // already confirmed in Zoho by someone — record it, don't re-confirm
      }
    }

    const { markVerifiedWithOrder } = require('../controllers/paymentProof.controller');
    let verifiedProofs = [];
    await db.transaction(async () => {
      await moveStatus(order, token, 'ready_for_draft_invoice', now);
      await db.prepare(`UPDATE orders SET zoho_so_status = 'confirmed', zoho_sync_status = 'synced' WHERE id = ?`).run(order.id);
      verifiedProofs = await markVerifiedWithOrder(order.id, actor.id, now);
      await logEvent({
        orderId: order.id, eventType: 'ZOHO_SO_CONFIRMED', oldStatus: order.status, newStatus: 'ready_for_draft_invoice',
        actorId: actor.id, actorName: actor.name,
        notes: `Sales Order ${order.zoho_so_number || ''} confirmed from Getmeds${adopted ? ' (it was already confirmed in Zoho)' : ''}${dryRun ? ' — dry run, Zoho not contacted' : ''}.`,
        metadata: { zohoSoId: order.zoho_so_id, zohoSoNumber: order.zoho_so_number, source: 'getmeds', adopted, dryRun }
      });
      await logEvent({
        orderId: order.id, eventType: 'FINANCE_VERIFIED', oldStatus: order.status, newStatus: 'ready_for_draft_invoice',
        actorId: actor.id, actorName: actor.name,
        notes: `Prices and proof of payment checked; order confirmed.${verifiedProofs.length ? ` Proof of payment verified with it.` : ''}`,
        metadata: { pricesChecked: true, proofChecked: true, via: 'confirm_order', paymentProofVerified: verifiedProofs.length > 0 }
      });
    })();

    const watchers = await getUserIdsByRole('management', 'dispatch');
    await notifySafely({
      orderId: order.id,
      recipientIds: Array.from(new Set([order.medrep_user_id, ...watchers].filter(Boolean))),
      message: `Order ${order.getmeds_order_id} was confirmed by Finance and is ready for invoicing.`,
      eventType: 'FINANCE_VERIFIED',
      orderData: { ...order, status: 'ready_for_draft_invoice' }
    });
    return { status: 'ready_for_draft_invoice', adopted, dryRun };
  });
}

/** Finance's other outcome: put the order on hold, with the reason. No Zoho write. */
async function holdOrder({ orderId, user, reason }) {
  const why = String(reason || '').trim();
  if (!why) throw new WorkflowError(400, 'VALIDATION_ERROR', 'A reason is required — it is what the next person acts on.');
  return runStep({ orderId, user, actorRole: 'finance', label: 'Hold', fromStatuses: ['so_created'], needsZoho: false }, async ({ order, actor, token, now }) => {
    await db.transaction(async () => {
      await moveStatus(order, token, 'on_hold', now);
      await db.prepare('UPDATE orders SET exception_reason = ? WHERE id = ?').run(why, order.id);
      await logEvent({
        orderId: order.id, eventType: 'FINANCE_REJECTED', oldStatus: order.status, newStatus: 'on_hold',
        actorId: actor.id, actorName: actor.name, notes: `Put on hold by Finance: ${why}`,
        metadata: { approved: false, reason: why, via: 'confirm_order' }
      });
    })();
    const watchers = await getUserIdsByRole('management');
    await notifySafely({
      orderId: order.id,
      recipientIds: Array.from(new Set([order.medrep_user_id, ...watchers].filter(Boolean))),
      message: `Order ${order.getmeds_order_id} was put on hold by Finance: ${why}`,
      eventType: 'FINANCE_REJECTED',
      orderData: { ...order, status: 'on_hold' }
    });
    return { status: 'on_hold' };
  });
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Create the invoice from the Sales Order and mark it sent. From
 * `ready_for_invoice_sent` (an earlier attempt created it but could not send
 * it) the same button only sends.
 */
async function createInvoice({ orderId, user }) {
  return runStep({ orderId, user, actorRole: 'dispatch', label: 'Create invoice', fromStatuses: ['ready_for_draft_invoice', 'ready_for_invoice_sent'] }, async ({ order, actor, token, dryRun, so, now }) => {
    let invoice;
    let adopted = false;
    let sendError = null;

    if (dryRun) {
      invoice = { invoice_id: `DRYRUN-INV-${order.getmeds_order_id}`, invoice_number: `DRYRUN-INV-${order.getmeds_order_id}`, status: 'sent' };
    } else {
      const existing = (so.invoices || []).find((i) => !VOID_STATUSES.includes(String(i.status || '').toLowerCase()));
      if (existing) {
        invoice = existing;
        adopted = true;
      } else {
        if (String(so.status || '').toLowerCase() === 'draft') {
          throw new WorkflowError(409, 'NOT_CONFIRMED_IN_ZOHO', 'The Sales Order is still a draft in Zoho. Finance needs to confirm the order first.');
        }
        const created = await inZoho('create the invoice', () => zoho.createInvoiceFromSalesOrder(so, { date: zohoToday() }));
        invoice = created.invoice;
      }
      if (!INVOICE_ISSUED.includes(String(invoice.status || '').toLowerCase())) {
        try {
          await zoho.markInvoiceSent(invoice.invoice_id);
          invoice = { ...invoice, status: 'sent' };
        } catch (err) {
          sendError = err.message;
        }
      }
    }

    const issued = INVOICE_ISSUED.includes(String(invoice.status || '').toLowerCase());
    const target = issued ? 'ready_for_dispatch' : 'ready_for_invoice_sent';
    await db.transaction(async () => {
      await moveStatus(order, token, target, now);
      await db.prepare('UPDATE orders SET zoho_invoice_id = ?, zoho_invoice_number = ? WHERE id = ?')
        .run(invoice.invoice_id, invoice.invoice_number || null, order.id);
      await logEvent({
        orderId: order.id,
        eventType: issued ? 'ZOHO_INVOICE_SENT' : 'ZOHO_INVOICE_DRAFTED',
        oldStatus: order.status, newStatus: target, actorId: actor.id, actorName: actor.name,
        notes: issued
          ? `Invoice ${invoice.invoice_number || ''} ${adopted ? 'found in Zoho and recorded' : 'created and sent'} from Getmeds${dryRun ? ' — dry run, Zoho not contacted' : ''}.`
          : `Invoice ${invoice.invoice_number || ''} created in Zoho, but marking it sent failed: ${sendError}. Press Create invoice again to send it.`,
        metadata: { zohoInvoiceId: invoice.invoice_id, zohoInvoiceNumber: invoice.invoice_number, source: 'getmeds', adopted, dryRun, sendError }
      });
    })();

    if (issued) {
      const recipients = await getUserIdsByRole('finance', 'dispatch');
      await notifySafely({
        orderId: order.id,
        recipientIds: Array.from(new Set([order.medrep_user_id, ...recipients].filter(Boolean))),
        message: `Invoice ${invoice.invoice_number || ''} for ${order.getmeds_order_id} has been sent to the customer.`,
        eventType: 'INVOICE_SENT',
        orderData: { ...order, status: target }
      });
    }
    return { status: target, invoiceNumber: invoice.invoice_number || null, adopted, dryRun, sendError };
  });
}

/** Pick and pack done: create the package for every line, full quantities. */
async function markPacked({ orderId, user }) {
  return runStep({ orderId, user, actorRole: 'dispatch', label: 'Mark packed', fromStatuses: ['ready_for_dispatch'] }, async ({ order, actor, token, dryRun, so, now }) => {
    let pkg;
    let adopted = false;
    if (dryRun) {
      pkg = { package_id: `DRYRUN-PKG-${order.getmeds_order_id}`, package_number: `DRYRUN-PKG-${order.getmeds_order_id}` };
    } else {
      const existing = (so.packages || [])[0];
      if (existing) {
        pkg = existing;
        adopted = true;
      } else {
        const created = await inZoho('create the package', () => zoho.createPackageForSalesOrder(so, { date: zohoToday() }));
        pkg = created.package;
      }
    }

    await db.transaction(async () => {
      await moveStatus(order, token, 'picking_packing', now);
      if (order.dispatch_id) {
        await db.prepare(`UPDATE dispatch_records SET status = 'packing', zoho_package_id = ?, zoho_package_number = ? WHERE order_id = ?`)
          .run(pkg.package_id, pkg.package_number || null, order.id);
      } else {
        await db.prepare(`INSERT INTO dispatch_records (order_id, status, zoho_package_id, zoho_package_number, created_at) VALUES (?, 'packing', ?, ?, ?)`)
          .run(order.id, pkg.package_id, pkg.package_number || null, now);
      }
      await logEvent({
        orderId: order.id, eventType: 'ZOHO_PACKAGE_CREATED', oldStatus: order.status, newStatus: 'picking_packing',
        actorId: actor.id, actorName: actor.name,
        notes: `Package ${pkg.package_number || ''} ${adopted ? 'found in Zoho and recorded' : 'created'} from Getmeds${dryRun ? ' — dry run, Zoho not contacted' : ''}.`,
        metadata: { zohoPackageId: pkg.package_id, zohoPackageNumber: pkg.package_number, source: 'getmeds', adopted, dryRun }
      });
    })();

    await notifySafely({
      orderId: order.id,
      recipientIds: [order.medrep_user_id].filter(Boolean),
      message: `Order ${order.getmeds_order_id} has been picked and packed.`,
      eventType: 'DISPATCH_STATUS_UPDATE',
      orderData: { ...order, status: 'picking_packing' }
    });
    return { status: 'picking_packing', packageNumber: pkg.package_number || null, adopted, dryRun };
  });
}

/** Ship the package: courier and tracking number are required. */
async function ship({ orderId, user, courier, trackingNumber }) {
  const carrier = String(courier || '').trim();
  const tracking = String(trackingNumber || '').trim();
  if (!carrier || !tracking) {
    throw new WorkflowError(400, 'VALIDATION_ERROR', 'Enter the courier and the tracking number — Zoho requires both, and the rep needs the tracking number to follow the parcel.');
  }
  return runStep({ orderId, user, actorRole: 'dispatch', label: 'Ship', fromStatuses: ['picking_packing'] }, async ({ order, actor, token, dryRun, so, now }) => {
    const shipmentNumber = `SH-${order.getmeds_order_id}`;
    let shipment;
    let adopted = false;
    if (dryRun) {
      shipment = { shipment_id: `DRYRUN-SHP-${order.getmeds_order_id}`, shipment_number: shipmentNumber };
    } else {
      const shipped = (so.packages || []).find((p) => p.shipment_id);
      if (shipped) {
        shipment = { shipment_id: shipped.shipment_id, shipment_number: shipped.shipment_number };
        adopted = true;
      } else {
        const packageId = order.zoho_package_id || ((so.packages || [])[0] || {}).package_id;
        if (!packageId) {
          throw new WorkflowError(409, 'NO_PACKAGE', 'There is no package in Zoho for this order yet. Press Mark packed first.');
        }
        const created = await inZoho('create the shipment', () => zoho.createShipmentForPackage({
          salesorderId: order.zoho_so_id, packageId, shipmentNumber, date: zohoToday(), deliveryMethod: carrier, trackingNumber: tracking
        }));
        shipment = created.shipmentorder;
      }
    }

    await db.transaction(async () => {
      await moveStatus(order, token, 'tracking_shared', now, ['dispatched']);
      if (order.dispatch_id) {
        await db.prepare(`
          UPDATE dispatch_records
             SET status = 'dispatched', courier = ?, tracking_number = ?, zoho_shipment_id = ?, zoho_shipment_number = ?,
                 dispatched_by = ?, dispatched_at = COALESCE(dispatched_at, ?)
           WHERE order_id = ?`)
          .run(carrier, tracking, shipment.shipment_id, shipment.shipment_number || null, actor.id, now, order.id);
      } else {
        await db.prepare(`
          INSERT INTO dispatch_records (order_id, status, courier, tracking_number, zoho_shipment_id, zoho_shipment_number, dispatched_by, dispatched_at, created_at)
          VALUES (?, 'dispatched', ?, ?, ?, ?, ?, ?, ?)`)
          .run(order.id, carrier, tracking, shipment.shipment_id, shipment.shipment_number || null, actor.id, now, now);
      }
      await logEvent({
        orderId: order.id, eventType: 'ZOHO_DISPATCHED', oldStatus: order.status, newStatus: 'dispatched',
        actorId: actor.id, actorName: actor.name,
        notes: `Shipped from Getmeds — ${carrier}, tracking ${tracking}${dryRun ? ' — dry run, Zoho not contacted' : ''}.`,
        metadata: { trackingNumber: tracking, courier: carrier, zohoShipmentId: shipment.shipment_id, source: 'getmeds', adopted, dryRun }
      });
      await logEvent({
        orderId: order.id, eventType: 'TRACKING_ENTERED', oldStatus: 'dispatched', newStatus: 'tracking_shared',
        actorId: actor.id, actorName: actor.name, notes: `${carrier}: ${tracking}`
      });
    })();

    // Shipped is half of "done"; if Finance already recorded the payment in
    // Zoho, this closes the order — the same shared rule the webhook uses.
    let status = 'tracking_shared';
    try {
      const completion = await evaluateCompletion({ orderId: order.id, currentStatus: status, actorId: actor.id, actorName: actor.name, trigger: 'shipment' });
      if (completion.completed) status = 'completed';
    } catch (err) {
      console.error(`[WORKFLOW] completion check failed for order ${order.id}:`, err.message);
    }

    await notifySafely({
      orderId: order.id,
      recipientIds: [order.medrep_user_id].filter(Boolean),
      message: `Order ${order.getmeds_order_id} has shipped. Courier: ${carrier}, Tracking: ${tracking}.`,
      eventType: 'ORDER_DISPATCHED',
      orderData: { ...order, status, tracking_number: tracking, courier: carrier }
    });
    return { status, shipmentNumber: shipment.shipment_number || null, adopted, dryRun };
  });
}

/** The parcel arrived. Recorded on the dispatch record and the timeline; the status does not change. */
async function markDelivered({ orderId, user }) {
  return runStep({ orderId, user, actorRole: 'dispatch', label: 'Mark delivered', fromStatuses: ['tracking_shared', 'dispatched', 'completed'] }, async ({ order, actor, token, dryRun, so, now }) => {
    if (order.delivered_at) {
      throw new WorkflowError(409, 'ALREADY_DELIVERED', `This order was already marked delivered on ${String(order.delivered_at).slice(0, 10)}.`);
    }
    let adopted = false;
    let shipmentId = order.zoho_shipment_id;
    if (!dryRun) {
      const shipped = (so.packages || []).find((p) => p.shipment_id);
      shipmentId = shipmentId || (shipped && shipped.shipment_id);
      if (!shipmentId) throw new WorkflowError(409, 'NO_SHIPMENT', 'There is no shipment in Zoho for this order yet.');
      if (shipped && String(shipped.shipment_status || shipped.status || '').toLowerCase() === 'delivered') {
        adopted = true;
      } else {
        await inZoho('mark the shipment delivered', () => zoho.markShipmentDelivered(shipmentId));
      }
    }

    await db.transaction(async () => {
      const res = await db.prepare('UPDATE orders SET action_claim = NULL, action_claim_at = NULL, updated_at = ? WHERE id = ? AND action_claim = ?')
        .run(now, order.id, token);
      if (res.changes !== 1) throw new WorkflowError(409, 'CLAIM_LOST', 'Someone else changed this order while you were working on it.');
      if (order.dispatch_id) {
        await db.prepare('UPDATE dispatch_records SET delivered_at = ?, delivered_by = ? WHERE order_id = ?').run(now, actor.id, order.id);
      } else {
        await db.prepare(`INSERT INTO dispatch_records (order_id, status, delivered_at, delivered_by, created_at) VALUES (?, 'dispatched', ?, ?, ?)`)
          .run(order.id, now, actor.id, now);
      }
      await logEvent({
        orderId: order.id, eventType: 'ZOHO_DELIVERED', oldStatus: order.status, newStatus: order.status,
        actorId: actor.id, actorName: actor.name,
        notes: `Marked delivered from Getmeds${adopted ? ' (Zoho already showed it delivered)' : ''}${dryRun ? ' — dry run, Zoho not contacted' : ''}.`,
        metadata: { zohoShipmentId: shipmentId || null, source: 'getmeds', adopted, dryRun }
      });
    })();

    await notifySafely({
      orderId: order.id,
      recipientIds: [order.medrep_user_id].filter(Boolean),
      message: `Order ${order.getmeds_order_id} was delivered.`,
      eventType: 'DISPATCH_STATUS_UPDATE',
      orderData: order
    });
    return { status: order.status, delivered: true, adopted, dryRun };
  });
}

module.exports = {
  WorkflowError,
  confirmOrder,
  holdOrder,
  createInvoice,
  markPacked,
  ship,
  markDelivered,
  zohoToday
};
