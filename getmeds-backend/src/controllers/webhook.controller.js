const db = require('../db/database');
const { logEvent } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const zoho = require('../integrations/zoho');
const { diffSalesOrderFields, summarizeChanges } = require('../services/zohoEditDiffService');
// Sep 1, 2026: status writes now go through the state machine rather than
// raw UPDATEs, and completion is one shared rule instead of a hop bolted to
// whichever event happened to be last. See both services for the full why.
const { setOrderStatus, advanceTo } = require('../services/orderStatusService');
const { evaluateCompletion } = require('../services/orderCompletionService');
const { syncLineItemsFromZoho } = require('../services/zohoLineSyncService');

/**
 * Validates optional Zoho Webhook secret / token.
 */
function verifyWebhookAuth(req) {
  const secret = process.env.ZOHO_WEBHOOK_SECRET;

  if (!secret) {
    // Sep 2, 2026 (2): an unset secret used to mean "accept anything from
    // anyone". That was survivable while the only way in was a tunnel to a
    // developer's laptop. On a public URL it means whoever finds
    // /api/webhooks/zoho can post fabricated Zoho events and walk real orders
    // through the pipeline — mark them invoiced, shipped, paid, deleted.
    //
    // Development keeps the convenience of not needing one. Production fails
    // closed, and says exactly what to do about it rather than 401-ing
    // silently, because "the webhook stopped working after deploy" is
    // otherwise a genuinely hard thing to diagnose.
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[WEBHOOK] REFUSED: ZOHO_WEBHOOK_SECRET is not set while NODE_ENV=production, so this ' +
          'endpoint cannot tell Zoho apart from anyone else. Run `npm run secrets:init`, then paste ' +
          'the same value into Zoho as the X-Zoho-Webhook-Token header on every Workflow Rule.'
      );
      return false;
    }
    return true;
  }

  const token =
    req.headers['x-zoho-webhook-token'] ||
    req.headers['x-zoho-secret'] ||
    req.headers['x-webhook-token'] ||
    req.query.token ||
    req.query.secret ||
    (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : null);

  return token === secret;
}

/**
 * Extracts and normalizes payload from Zoho Webhook request.
 */
function parseWebhookPayload(req) {
  let body = req.body || {};

  // Zoho's webhook action can wrap the real payload as a JSON *string* under
  // a form field instead of sending raw JSON. Different Zoho automation
  // paths use different key names for this ("JSONString" is the documented
  // one; the legacy Workflow Rule webhook action uses "payload") — check
  // both rather than assuming one.
  const wrappedKey = typeof body.JSONString === 'string' ? 'JSONString'
    : typeof body.payload === 'string' ? 'payload'
    : null;

  if (wrappedKey) {
    try {
      body = JSON.parse(body[wrappedKey]);
    } catch (e) {
      // Keep as-is if parsing fails
    }
  } else if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {}
  }

  // Aug 30, 2026: confirmed live that Zoho's Workflow Rule webhook action
  // appends "Add Parameters" entries to the URL as a query string (e.g.
  // "?event_type=salesorder.edited&..."), not into the JSON body — so
  // req.query.event_type has to be checked here too, not just req.body's
  // equivalent keys and the older req.query.event fallback.
  const rawEvent =
    req.body.event_type ||
    req.body.event ||
    req.body.type ||
    req.headers['x-zoho-event'] ||
    req.query.event_type ||
    req.query.event ||
    '';

  const salesorder = body.salesorder || body.sales_order || (body.data && (body.data.salesorder || body.data.sales_order)) || (body.salesorder_id ? body : null);
  const invoice = body.invoice || (body.data && body.data.invoice) || (body.invoice_id ? body : null);
  const payment = body.payment || body.customer_payment || (body.data && (body.data.payment || body.data.customer_payment)) || (body.payment_id ? body : null);

  // Package and Shipment are two distinct Zoho Inventory events, kept
  // separate (not merged into one "dispatch" blob like before) so picking
  // & packing can be reflected as soon as the Package is created, ahead of
  // — and independently from — the later Shipment/tracking event.
  const zohoPackage = body.package || (body.data && body.data.package) || (body.package_id ? body : null);
  const shipment = body.shipment || (body.data && body.data.shipment) || (body.shipment_id ? body : null);

  return {
    rawEvent: String(rawEvent).toLowerCase(),
    body,
    salesorder,
    invoice,
    payment,
    zohoPackage,
    shipment
  };
}

/**
 * Finds order in database by zoho_so_id or getmeds_order_id.
 *
 * Sep 22, 2026: for a split-invoicing order (see services/orderSplitService.js),
 * the identifier might name the SECOND Sales Order instead of the primary
 * one `orders.zoho_so_id` holds. Checked only after the primary lookup
 * misses — the overwhelming majority of webhooks are for a primary and
 * never touch this. Returns the order with `_splitMatch` set to that split
 * row when this is how it matched, `null` otherwise, so a caller can tell
 * "this event is about the order's SECOND Sales Order" and route
 * write-backs to order_split_sales_orders instead of the orders row.
 */
async function findOrder(identifier) {
  if (!identifier) return null;
  const primary = await db.prepare(`
    SELECT o.*, c.name as customer_name, c.type as customer_type_detail,
           u.id as medrep_user_id, u.name as medrep_name, u.email as medrep_email
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON o.medrep_id = u.id
    WHERE o.zoho_so_id = ? OR o.getmeds_order_id = ? OR o.zoho_so_number = ?
  `).get(String(identifier), String(identifier), String(identifier));
  if (primary) return { ...primary, _splitMatch: null };

  const splitRow = await db.prepare(
    `SELECT * FROM order_split_sales_orders WHERE zoho_so_id = ? OR zoho_so_number = ?`
  ).get(String(identifier), String(identifier));
  if (!splitRow) return null;

  const order = await db.prepare(`
    SELECT o.*, c.name as customer_name, c.type as customer_type_detail,
           u.id as medrep_user_id, u.name as medrep_name, u.email as medrep_email
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON o.medrep_id = u.id
    WHERE o.id = ?
  `).get(splitRow.order_id);
  if (!order) return null;
  return { ...order, _splitMatch: splitRow };
}

/**
 * Sep 22, 2026: the split-invoicing counterpart to the huge branch below —
 * deliberately much smaller. It covers the transitions that matter for a
 * split's own Sales Order/Invoice/Shipment lifecycle (confirmed, invoice
 * drafted/sent, payment reported, shipped/packed) by writing to its
 * order_split_sales_orders row instead of the orders table, and logs each
 * one to the order's trail so it's visible on the Audit Timeline right
 * alongside the primary's own events.
 *
 * Deliberately simpler than the primary path: no claim/echo de-duplication
 * (a split confirming twice just re-writes the same status, which is
 * harmless — every column here is idempotent), and it never touches the
 * order's own `status` column — that stays governed by the primary path
 * plus orderCompletionService's split-aware completion rule, which looks
 * at every split row rather than being driven by any one of them directly.
 */
async function handleSplitWebhookEvent(order, splitRow, { rawEvent, salesorder, invoice, payment, shipment, zohoPackage }) {
  const now = new Date().toISOString();
  const soStatus = salesorder && typeof salesorder.status === 'string' ? salesorder.status.toLowerCase() : null;
  const invStatus = invoice && typeof invoice.status === 'string' ? invoice.status.toLowerCase() : null;
  const entity = splitRow.invoicing_from;

  const isPaymentEvent = rawEvent.includes('payment') || rawEvent.includes('invoice.paid') || invStatus === 'paid';
  const isInvoiceSent = !isPaymentEvent && (rawEvent.includes('invoice.sent') || rawEvent.includes('invoice.mark_sent') || invStatus === 'sent');
  const isInvoiceDrafted = !isPaymentEvent && !isInvoiceSent && (rawEvent.includes('invoice.created') || rawEvent.includes('invoice.drafted') || (invoice && (invStatus === 'draft' || invStatus === 'open')));
  const isSalesOrderConfirmed = rawEvent.includes('salesorder.confirmed') ||
    ['confirmed', 'open', 'partially_shipped', 'shipped', 'fulfilled', 'partially_fulfilled', 'closed', 'invoiced', 'partially_invoiced'].includes(soStatus);
  const isSalesOrderDeleted = rawEvent.includes('salesorder.deleted');
  const isSalesOrderCancelled = !isSalesOrderDeleted && (rawEvent.includes('salesorder.void') || rawEvent.includes('salesorder.cancelled') || soStatus === 'void' || soStatus === 'cancelled' || soStatus === 'voided');
  const isShipmentEvent = Boolean(shipment) || rawEvent.includes('shipment.created') || rawEvent.includes('shipment_created');
  const isPackageEvent = !isShipmentEvent && (Boolean(zohoPackage) || rawEvent.includes('package.created') || rawEvent.includes('package_created'));

  const logSplitEvent = (eventType, notes) => logEvent({
    orderId: order.id, eventType, actorName: 'Zoho Webhook',
    notes: `[${entity}] ${notes}`,
    metadata: { invoicingFrom: entity, splitId: splitRow.id }
  });

  if (isPaymentEvent) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_paid_status = 'paid', updated_at = ? WHERE id = ?`).run(now, splitRow.id);
    await logSplitEvent('ZOHO_PAYMENT_VERIFIED', 'Payment reported by Zoho for this entity’s Invoice.');
    return { processed: true, action: 'SPLIT_PAYMENT_RECORDED', invoicingFrom: entity };
  }
  if (isInvoiceSent) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_invoiced_status = 'sent', zoho_invoice_id = COALESCE(?, zoho_invoice_id), zoho_invoice_number = COALESCE(?, zoho_invoice_number), updated_at = ? WHERE id = ?`)
      .run(invoice?.invoice_id || null, invoice?.invoice_number || null, now, splitRow.id);
    await logSplitEvent('ZOHO_INVOICE_SENT', `Invoice ${invoice?.invoice_number || ''} marked Sent in Zoho.`.trim());
    return { processed: true, action: 'SPLIT_INVOICE_SENT', invoicingFrom: entity };
  }
  if (isInvoiceDrafted) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_invoiced_status = 'draft', zoho_invoice_id = ?, zoho_invoice_number = ?, updated_at = ? WHERE id = ?`)
      .run(invoice?.invoice_id || null, invoice?.invoice_number || null, now, splitRow.id);
    await logSplitEvent('ZOHO_INVOICE_DRAFTED', `Invoice ${invoice?.invoice_number || ''} drafted in Zoho.`.trim());
    return { processed: true, action: 'SPLIT_INVOICE_DRAFTED', invoicingFrom: entity };
  }
  if (isSalesOrderDeleted) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_so_status = 'deleted', updated_at = ? WHERE id = ?`).run(now, splitRow.id);
    await logSplitEvent('ZOHO_SO_DELETED', 'Sales Order deleted in Zoho.');
    return { processed: true, action: 'SPLIT_SO_DELETED', invoicingFrom: entity };
  }
  if (isSalesOrderCancelled) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_so_status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, splitRow.id);
    await logSplitEvent('ZOHO_SO_CANCELLED', 'Sales Order voided/cancelled in Zoho.');
    return { processed: true, action: 'SPLIT_SO_CANCELLED', invoicingFrom: entity };
  }
  if (isSalesOrderConfirmed) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_so_status = 'confirmed', updated_at = ? WHERE id = ?`).run(now, splitRow.id);
    await logSplitEvent('ZOHO_SO_CONFIRMED', 'Sales Order confirmed in Zoho.');
    return { processed: true, action: 'SPLIT_SO_CONFIRMED', invoicingFrom: entity };
  }
  if (isShipmentEvent) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_shipped_status = 'shipped', zoho_shipment_id = COALESCE(?, zoho_shipment_id), zoho_shipment_number = COALESCE(?, zoho_shipment_number), updated_at = ? WHERE id = ?`)
      .run(shipment?.shipment_id || null, shipment?.shipment_number || null, now, splitRow.id);
    await logSplitEvent('ZOHO_DISPATCHED', 'Shipment recorded in Zoho for this entity’s Sales Order.');
    return { processed: true, action: 'SPLIT_SHIPPED', invoicingFrom: entity };
  }
  if (isPackageEvent) {
    await db.prepare(`UPDATE order_split_sales_orders SET zoho_package_id = COALESCE(?, zoho_package_id), zoho_package_number = COALESCE(?, zoho_package_number), updated_at = ? WHERE id = ?`)
      .run(zohoPackage?.package_id || null, zohoPackage?.package_number || null, now, splitRow.id);
    await logSplitEvent('ZOHO_PACKAGE_CREATED', 'Package created in Zoho for this entity’s Sales Order.');
    return { processed: true, action: 'SPLIT_PACKAGE_CREATED', invoicingFrom: entity };
  }

  return { processed: false, message: 'Webhook received for a split Sales Order but matched no known event.', invoicingFrom: entity };
}

/**
 * Handle incoming Zoho Webhook event
 * POST /api/webhooks/zoho
 */
exports.handleZohoWebhook = async (req, res, next) => {
  try {
    if (!verifyWebhookAuth(req)) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing webhook token' }
      });
    }

    const { rawEvent, body, salesorder, invoice, payment, zohoPackage, shipment } = parseWebhookPayload(req);

    // Extract identifiers
    const zohoSoId = salesorder?.salesorder_id || invoice?.salesorder_id || payment?.salesorder_id || shipment?.salesorder_id || zohoPackage?.salesorder_id;
    const refNumber = salesorder?.reference_number || salesorder?.salesorder_number || invoice?.reference_number || payment?.reference_number;
    const identifier = zohoSoId || refNumber || body.order_id || body.getmeds_order_id || body.reference_number;

    if (!identifier) {
      return res.status(200).json({
        success: true,
        processed: false,
        message: 'No sales order or reference identifier found in webhook payload',
        received_event: rawEvent
      });
    }

    const order = (await findOrder(identifier)) || (zohoSoId ? await findOrder(zohoSoId) : null) || (refNumber ? await findOrder(refNumber) : null);

    if (!order) {
      console.warn(`[ZOHO_WEBHOOK] No local order found matching identifier: ${identifier}`);
      return res.status(200).json({
        success: true,
        processed: false,
        message: 'Webhook received but order is not present in local database',
        identifier
      });
    }

    // Sep 22, 2026: this event is about a split-invoicing order's SECOND
    // Sales Order (see services/orderSplitService.js), not the primary one
    // — findOrder() only sets _splitMatch when it had to fall through to
    // order_split_sales_orders to resolve the identifier. Handled by a
    // small, separate function rather than threading a slot condition
    // through every branch below: those branches read `order.zoho_so_id`/
    // `order.status`/etc. as scalars, which is exactly right for the
    // primary and exactly wrong for a split. The order's own overall
    // `status` is never written here — see orderCompletionService's
    // split-aware completion rule for how the two combine.
    if (order._splitMatch) {
      const result = await handleSplitWebhookEvent(order, order._splitMatch, { rawEvent, salesorder, invoice, payment, shipment, zohoPackage });
      return res.status(200).json({ success: true, ...result });
    }
    // Sep 22, 2026: everything below this point is the PRIMARY path,
    // unmodified — strip the marker so `order` is byte-identical to what
    // findOrder() has always returned for it (it only ever leaks into
    // notification payloads/etc. otherwise, which is harmless but pointless).
    delete order._splitMatch;

    const now = new Date().toISOString();
    let actionTaken = 'IGNORED';
    let previousStatus = order.status;
    let newStatus = order.status;

    // Detect event category. Status values are compared case-insensitively —
    // Zoho's UI fields typically send display casing ("Confirmed"), not the
    // lowercase API casing ("confirmed"), and different automation paths in
    // the same Zoho account have been observed sending either.
    const soStatus = salesorder && typeof salesorder.status === 'string' ? salesorder.status.toLowerCase() : null;
    const invStatus = invoice && typeof invoice.status === 'string' ? invoice.status.toLowerCase() : null;
    const payStatus = payment && typeof payment.status === 'string' ? payment.status.toLowerCase() : null;

    const isPaymentEvent =
      rawEvent.includes('payment') ||
      rawEvent.includes('invoice.paid') ||
      invStatus === 'paid' ||
      (payment && (payStatus === 'success' || payment.amount > 0));

    // Sep 1, 2026: "Invoice created" and "Invoice marked as Sent" are two
    // different things and are now told apart.
    //
    // They used to collapse into one check — `invStatus === 'sent'` was in
    // the isInvoiceDrafted list below — so marking an invoice as Sent in
    // Zoho produced a SECOND "Invoice drafted in Zoho" audit entry and a
    // duplicate notification, with no status change. Finance had no way to
    // see, in this app, whether an invoice had actually been issued to the
    // customer or was still sitting as a draft.
    //
    // The event_type wins over the status field where both are present: an
    // invoice.created webhook for an invoice that Zoho auto-sent on creation
    // still records as the creation (that's what the event IS), and the
    // later invoice.sent edit is what moves it on.
    const invoiceEventSaysCreated =
      rawEvent.includes('invoice.created') ||
      rawEvent.includes('invoice.drafted') ||
      rawEvent.includes('invoice_created');

    const invoiceEventSaysSent =
      rawEvent.includes('invoice.sent') ||
      rawEvent.includes('ready_for_dispatch') ||
      rawEvent.includes('invoice.mark_sent') ||
      rawEvent.includes('invoice.marked_sent');

    // Finance marked the Invoice as Sent in Zoho — it has been issued to the
    // customer. Checked before isInvoiceDrafted so a "sent" status can never
    // be mistaken for a draft again, and after isPaymentEvent so a paid
    // invoice still resolves to the more advanced state.
    const isInvoiceSent =
      !isPaymentEvent &&
      (invoiceEventSaysSent || (!invoiceEventSaysCreated && invoice && invStatus === 'sent'));

    // Finance converted the (confirmed) Sales Order into an Invoice in
    // Zoho, but hasn't recorded a payment against it yet. Checked *after*
    // isPaymentEvent above, so an already-paid invoice never falls through
    // to here — payment always wins when both could match.
    const isInvoiceDrafted =
      !isPaymentEvent &&
      !isInvoiceSent &&
      (invoiceEventSaysCreated || (invoice && (invStatus === 'draft' || invStatus === 'open')));

    // Sep 1, 2026 (6): same widening as services/zohoReconcileService.js — a
    // Sales Order reported as shipped/fulfilled/closed/invoiced has by
    // definition been confirmed, and matching only the literal 'confirmed'
    // meant such a payload fell through to the generic "event received" log.
    const isSalesOrderConfirmed =
      rawEvent.includes('salesorder.confirmed') ||
      rawEvent.includes('salesorder_confirmed') ||
      ['confirmed', 'open', 'partially_shipped', 'shipped', 'fulfilled',
        'partially_fulfilled', 'closed', 'invoiced', 'partially_invoiced'].includes(soStatus);

    // Aug 31, 2026: "deleted" is kept as its own flag, checked separately
    // from void/cancel below, so the audit trail can say specifically what
    // happened in Zoho. Deleting a Sales Order removes the record entirely
    // (there's no way back short of recreating it); voiding/cancelling
    // leaves the record in place with a changed status. Finance reading the
    // trail later shouldn't have to guess which one actually occurred from
    // a generic "cancelled or voided" note.
    const isSalesOrderDeleted = rawEvent.includes('salesorder.deleted');

    const isSalesOrderCancelled =
      !isSalesOrderDeleted &&
      (rawEvent.includes('salesorder.void') ||
        rawEvent.includes('salesorder.cancelled') ||
        soStatus === 'void' || soStatus === 'cancelled' || soStatus === 'voided');

    // Shipment (courier + tracking assigned) — checked ahead of Package so a
    // payload carrying both (Zoho sometimes reports the package that was
    // shipped inside the shipment payload) resolves to the more advanced
    // state, mirroring how isPaymentEvent outranks isInvoiceDrafted above.
    const isShipmentEvent =
      Boolean(shipment) ||
      rawEvent.includes('shipment.created') ||
      rawEvent.includes('shipment_created') ||
      rawEvent.includes('shipment.dispatched') ||
      rawEvent.includes('shipmentorder') ||
      (rawEvent.includes('shipment') && !rawEvent.includes('package')) ||
      rawEvent.includes('fulfilled') ||
      soStatus === 'fulfilled' || soStatus === 'shipped';

    // Package created (items picked & packed, not yet shipped)
    const isPackageEvent =
      !isShipmentEvent &&
      (Boolean(zohoPackage) ||
        rawEvent.includes('package.created') ||
        rawEvent.includes('package_created') ||
        (rawEvent.includes('package') && !rawEvent.includes('shipment')));

    // Sep 12, 2026: is Zoho telling us something this app already knows?
    //
    // Under GETMEDS_WORKFLOW_V2 this app confirms Sales Orders and creates
    // invoices, packages and shipments in Zoho itself (services/
    // workflowV2Service.js), and Zoho then reports each of those changes back
    // here like any other. Without this check every button press would log its
    // step twice and email everyone twice. It also closed an older gap: nothing
    // here was idempotent, so a webhook Zoho delivered twice did the same.
    //
    // Two ways a change counts as known:
    //   - already recorded: a history line of the same kind carries the same
    //     Zoho document id — from this app's button, or an earlier webhook
    //   - in progress: someone is pressing that button right now (the order
    //     holds a fresh action claim, services/orderClaimService.js), and the
    //     button records the step itself as soon as Zoho answers it
    //
    // Payment is never skipped (this app does not record payments), nor are
    // void, delete and edit — those are Zoho-side decisions this app must hear.
    let echo = null;
    const echoable = !isPaymentEvent && (isInvoiceSent || isInvoiceDrafted || isSalesOrderConfirmed || isShipmentEvent || isPackageEvent);
    if (echoable) {
      const recorded = async (eventTypes, key, value) => {
        if (!value) return false;
        // logEvent stores metadata as JSON.stringify output, so a key/value
        // pair always reads exactly `"key":"value"` — no spaces.
        const row = await db.prepare(
          'SELECT 1 AS hit FROM order_events WHERE order_id = ? AND event_type = ANY(?) AND metadata LIKE ? LIMIT 1'
        ).get(order.id, eventTypes, `%"${key}":${JSON.stringify(String(value))}%`);
        return Boolean(row);
      };
      if (isInvoiceSent) {
        if (await recorded(['ZOHO_INVOICE_SENT'], 'zohoInvoiceId', invoice?.invoice_id)) echo = 'already_recorded';
      } else if (isInvoiceDrafted) {
        if (await recorded(['ZOHO_INVOICE_DRAFTED', 'ZOHO_INVOICE_SENT'], 'zohoInvoiceId', invoice?.invoice_id)) echo = 'already_recorded';
      } else if (isSalesOrderConfirmed) {
        // Two labels for the same id: Dispatch's steps (workflowV2Service.js)
        // write zohoSoId, and Finance's Verify (finance.controller.js) writes
        // zohoSalesOrderId. Either one means this confirmation is known.
        const confirmedSoId = salesorder?.salesorder_id || order.zoho_so_id;
        if (
          (await recorded(['ZOHO_SO_CONFIRMED'], 'zohoSoId', confirmedSoId)) ||
          (await recorded(['ZOHO_SO_CONFIRMED'], 'zohoSalesOrderId', confirmedSoId))
        ) echo = 'already_recorded';
      } else if (isShipmentEvent) {
        // A shipment first reported without a tracking number and then again
        // with one is news the second time, so the tracking number has to
        // match as well.
        if (await recorded(['ZOHO_DISPATCHED'], 'zohoShipmentId', shipment?.shipment_id)) {
          const d = await db.prepare('SELECT tracking_number FROM dispatch_records WHERE order_id = ?').get(order.id);
          const incoming = shipment?.tracking_number || null;
          if (!incoming || (d && d.tracking_number === incoming)) echo = 'already_recorded';
        }
      } else if (isPackageEvent) {
        if (await recorded(['ZOHO_PACKAGE_CREATED'], 'zohoPackageId', zohoPackage?.package_id)) echo = 'already_recorded';
      }
      if (!echo) {
        const { CLAIM_TTL_MS } = require('../services/orderClaimService');
        const claim = await db.prepare('SELECT action_claim, action_claim_at FROM orders WHERE id = ?').get(order.id);
        if (claim && claim.action_claim && new Date(claim.action_claim_at).getTime() > Date.now() - CLAIM_TTL_MS) {
          echo = 'getmeds_action_in_progress';
        }
      }
    }

    if (echo) {
      console.log(`[ZOHO_WEBHOOK] ${rawEvent} for ${order.getmeds_order_id}: ${echo === 'already_recorded' ? 'already recorded' : 'a Getmeds action is recording it'} — skipped.`);
      actionTaken = echo === 'already_recorded' ? 'ALREADY_RECORDED' : 'DEFERRED_TO_GETMEDS_ACTION';
    }

    // Process Payment Event
    else if (isPaymentEvent) {
      const paymentAmount = payment?.amount || invoice?.payment_made || order.total_amount;
      const paymentRef = payment?.payment_number || payment?.reference_number || payment?.payment_id || 'ZOHO-PAYMENT';
      const paymentDate = payment?.date || now.split('T')[0];

      await db.transaction(async () => {
        // Upsert payment record
        const existingPayment = await db.prepare('SELECT id FROM payments WHERE order_id = ?').get(order.id);
        if (existingPayment) {
          await db.prepare(`
            UPDATE payments
            SET status = 'verified', payment_reference = ?, amount = ?, payment_date = ?, notes = 'Verified via Zoho Webhook', verified_at = ?
            WHERE order_id = ?
          `).run(paymentRef, paymentAmount, paymentDate, now, order.id);
        } else {
          await db.prepare(`
            INSERT INTO payments (order_id, status, payment_reference, amount, payment_date, notes, verified_at, created_at)
            VALUES (?, 'verified', ?, ?, ?, 'Verified via Zoho Webhook', ?, ?)
          `).run(order.id, paymentRef, paymentAmount, paymentDate, now, now);
        }

        // Sep 1, 2026: payment is no longer treated as "the event that moves
        // the order to ready_for_dispatch, or else nothing".
        //
        // Getmeds customers are on payment terms, so payment normally lands
        // LAST — after the goods have already shipped. The old guard list
        // here didn't include any post-dispatch status, so a payment
        // arriving against an order at 'tracking_shared' recorded the money
        // and then left the status untouched. Combined with nothing else in
        // the codebase ever assigning 'completed', that meant a fully
        // shipped, fully paid order sat at 'tracking_shared' permanently.
        //
        // Sep 1, 2026 (5): payment now moves NOTHING in the pipeline. It used
        // to push a pre-dispatch order to ready_for_dispatch, which made
        // sense while that status meant "the Sales Order is confirmed, go
        // pack". It no longer does — it means "the invoice has been issued" —
        // and jumping an un-invoiced order there because money arrived would
        // skip both Finance stages and tell the warehouse to pack something
        // that was never invoiced.
        //
        // The pipeline is driven by the Sales Order / invoice / shipment
        // events. Payment's only job is recording the money (above) and
        // deciding completion (below), which is exactly right for customers
        // on payment terms: it can land at any point and the order's stage is
        // unaffected either way.

        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_PAYMENT_VERIFIED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: `Payment of PHP ${paymentAmount} verified via Zoho Webhook (Ref: ${paymentRef})`,
          metadata: { webhook: rawEvent, paymentRef, paymentAmount }
        });

        // Notifications
        const dispatchUserIds = await getUserIdsByRole('dispatch', 'finance');
        const recipients = Array.from(new Set([order.medrep_user_id, ...dispatchUserIds].filter(Boolean)));
        await notify({
          orderId: order.id,
          recipientIds: recipients,
          message: `Payment for ${order.getmeds_order_id} was verified in Zoho. Order status: ${newStatus}.`,
          eventType: 'PAYMENT_VERIFIED',
          orderData: { ...order, status: newStatus }
        });

        // Was payment the last of the two? If the order has already shipped,
        // this closes it out.
        const completion = await evaluateCompletion({
          orderId: order.id,
          currentStatus: newStatus,
          actorName: 'Zoho Webhook',
          trigger: 'payment'
        });
        if (completion.completed) newStatus = 'completed';
      })();

      actionTaken = newStatus === 'completed' ? 'PAYMENT_VERIFIED_ORDER_COMPLETED' : 'PAYMENT_VERIFIED';
    }

    // Process Invoice Marked-as-Sent Event — Finance issued the Invoice to
    // the customer in Zoho (Draft -> Sent). Sep 1, 2026: new branch, and the
    // matching Zoho automation is a Books Workflow Rule on Invoice /
    // Edited / Status is Sent, sending event_type "invoice.sent".
    //
    // Like Invoice Drafted below, this is a visibility checkpoint rather
    // than a payment: an issued invoice is not a paid one, so the order does
    // NOT jump to ready_for_dispatch here. What it does do is give Finance
    // and the warehouse a status they can act on — "this has actually gone
    // to the customer, it's cleared to pack" — which is the point at which
    // Getmeds' flow says picking can start.
    else if (isInvoiceSent) {
      const zohoInvoiceNumber = invoice?.invoice_number || order.zoho_invoice_number;
      const zohoInvoiceId = invoice?.invoice_id || order.zoho_invoice_id;

      await db.transaction(async () => {
        // Only ever moves an order FORWARD into invoice_sent from a state
        // that precedes it. An order that has already been packed or shipped
        // (the dispatch-first ordering, where the invoice is raised after the
        // goods go out) keeps its more advanced status — the state machine
        // would allow the hop, but going from 'dispatched' back to
        // 'ready_for_dispatch' would be a downgrade, so it isn't attempted. The
        // invoice number is still recorded either way.
        const preInvoice = ['so_created', 'ready_for_draft_invoice', 'ready_for_invoice_sent'];
        if (preInvoice.includes(order.status)) {
          const moved = await advanceTo(order.id, order.status, 'ready_for_dispatch', now);
          if (moved.changed) newStatus = moved.status;
        }

        await db.prepare(`
          UPDATE orders
          SET zoho_invoice_id = COALESCE(?, zoho_invoice_id), zoho_invoice_number = COALESCE(?, zoho_invoice_number),
              updated_at = ?
          WHERE id = ?
        `).run(zohoInvoiceId || null, zohoInvoiceNumber || null, now, order.id);

        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_INVOICE_SENT',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: `Invoice ${zohoInvoiceNumber || zohoInvoiceId || ''} marked as Sent in Zoho — issued to the customer.`,
          metadata: { zohoInvoiceId, zohoInvoiceNumber, webhook: rawEvent }
        });

        const recipients = await getUserIdsByRole('finance', 'dispatch');
        await notify({
          orderId: order.id,
          recipientIds: Array.from(new Set([order.medrep_user_id, ...recipients].filter(Boolean))),
          message: `Invoice ${zohoInvoiceNumber || ''} for ${order.getmeds_order_id} has been sent to the customer.`,
          eventType: 'INVOICE_SENT',
          orderData: { ...order, status: newStatus }
        });
      })();

      actionTaken = 'INVOICE_SENT';
    }

    // Process Invoice Drafted Event — Finance converted the confirmed
    // Sales Order to an Invoice in Zoho. This is a visibility checkpoint,
    // not a payment: the order does not advance to ready_for_dispatch here,
    // it just records that an invoice now exists so Finance/MedRep can see
    // it, until the real payment webhook (above) moves it forward.
    else if (isInvoiceDrafted) {
      const zohoInvoiceNumber = invoice?.invoice_number || order.zoho_invoice_number;
      const zohoInvoiceId = invoice?.invoice_id || order.zoho_invoice_id;

      await db.transaction(async () => {
        // Aug 31, 2026 (3): 'tracking_shared' added — in Getmeds' actual
        // fulfillment order (dispatch happens BEFORE invoicing, confirmed
        // live), an order sits at 'tracking_shared' once shipped (see the
        // isShipmentEvent branch below, which no longer auto-completes it),
        // and this is the very next real step from there. Kept alongside
        // the original 'so_created'/'ready_for_draft_invoice' pair rather than
        // replacing them, since those cover a different (invoice-before-
        // dispatch/prepaid) ordering this app also supports.
        //
        // Aug 31, 2026 (4): 'completed' added too, as a self-correction —
        // mirrors the same fix in orders.controller.js's syncFromZoho. An
        // order can be sitting at 'completed' only because it hit the
        // now-fixed dispatch-cascade bug, which used to close orders out
        // before they were ever invoiced. isInvoiceDrafted is only reached
        // when isPaymentEvent (checked above) did NOT match, so by
        // construction this invoice isn't marked paid — meaning a
        // 'completed' order reaching this branch hasn't actually finished,
        // and belongs back at invoice_drafted pending real payment.
        //
        // Sep 1, 2026: 'completed' is no longer in this list. It was only
        // ever here to walk back orders that the old dispatch-cascade bug
        // had closed out before they were invoiced — a self-correction for
        // damage that build could do. Now that 'completed' means "shipped
        // AND paid" and is set in exactly one place
        // (services/orderCompletionService.js), a completed order is a
        // genuinely finished one, and an invoice webhook must not reopen it.
        // The state machine would refuse the hop anyway; leaving it out of
        // the list keeps the intent explicit rather than relying on that.
        const preInvoice = ['so_created', 'ready_for_finance_verified', 'ready_for_draft_invoice', 'tracking_shared'];
        if (preInvoice.includes(order.status)) {
          const moved = await advanceTo(order.id, order.status, 'ready_for_invoice_sent', now);
          if (moved.changed) newStatus = moved.status;
        }

        await db.prepare(`
          UPDATE orders
          SET zoho_invoice_id = COALESCE(?, zoho_invoice_id), zoho_invoice_number = COALESCE(?, zoho_invoice_number),
              updated_at = ?
          WHERE id = ?
        `).run(zohoInvoiceId || null, zohoInvoiceNumber || null, now, order.id);

        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_INVOICE_DRAFTED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          // Sep 1, 2026 (8): if the order was still awaiting the finance
          // account check when this invoice appeared, say so. Raising the
          // invoice in Zoho IS the approval in practice — this app cannot
          // stop anyone doing it, and refusing the hop would only strand the
          // order — but a control step that gets skipped silently is a
          // control step that isn't there. The same note is written on the
          // manual-sync path (services/zohoReconcileService.js); this is the
          // one that fires in live use, so it is the one that matters.
          notes: `Invoice drafted in Zoho (${zohoInvoiceNumber || zohoInvoiceId || 'no number yet'})${
            previousStatus === 'ready_for_finance_verified'
              ? ' — Note: this order had not been marked Finance Verified in this app; raising the invoice in Zoho is treated as the approval.'
              : ''
          }`,
          metadata: { zohoInvoiceId, zohoInvoiceNumber, financeVerificationSkipped: previousStatus === 'ready_for_finance_verified' }
        });

        const financeIds = await getUserIdsByRole('finance');
        await notify({
          orderId: order.id,
          recipientIds: Array.from(new Set([order.medrep_user_id, ...financeIds].filter(Boolean))),
          message: `Zoho Invoice ${zohoInvoiceNumber || ''} drafted for ${order.getmeds_order_id}. Awaiting payment confirmation in Zoho.`,
          eventType: 'INVOICE_DRAFTED',
          orderData: { ...order, status: newStatus }
        });
      })();

      actionTaken = 'INVOICE_DRAFTED';
    }

    // Process Sales Order Confirmed Event
    else if (isSalesOrderConfirmed) {
      const zohoSoNumber = salesorder?.salesorder_number || order.zoho_so_number;
      const soId = salesorder?.salesorder_id || order.zoho_so_id;

      await db.transaction(async () => {
        // Sep 1, 2026: 'so_created' added to this list, and it matters more
        // than it looks. Submit used to run an order straight through to
        // waiting_for_payment (direct) or ready_for_dispatch (credit), so by
        // the time this webhook arrived the order was ALREADY past every
        // status named here — meaning confirming a Sales Order in Zoho
        // logged an audit entry and changed nothing at all. Credit orders
        // now wait at 'so_created' until Zoho confirms (see
        // orders.controller.js submit), and this is the hop that releases
        // them.
        if (['submitted', 'validating', 'so_pending', 'so_created'].includes(order.status)) {
          // Sep 1, 2026 (5): one destination for both customer types. Direct
          // orders used to stop at waiting_for_payment; payment no longer
          // gates the pipeline (it is on terms and only decides completion),
          // so credit and direct follow the identical chain from here.
          // Sep 1, 2026 (8): confirming the Sales Order now hands the order
          // to Finance for account verification, not straight to invoicing.
          const target = 'ready_for_finance_verified';
          const moved = await advanceTo(order.id, order.status, target, now);
          if (moved.changed) newStatus = moved.status;
        }

        await db.prepare(`
          UPDATE orders
          SET zoho_so_id = COALESCE(?, zoho_so_id), zoho_so_number = COALESCE(?, zoho_so_number),
              zoho_so_status = 'confirmed', zoho_sync_status = 'synced', updated_at = ?
          WHERE id = ?
        `).run(soId || null, zohoSoNumber || null, now, order.id);

        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_CONFIRMED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: `Sales Order confirmed in Zoho (${zohoSoNumber || soId})`,
          metadata: { zohoSoId: soId, zohoSoNumber }
        });

        await notify({
          orderId: order.id,
          recipientIds: [order.medrep_user_id],
          message: `Zoho Sales Order ${zohoSoNumber || ''} confirmed for ${order.getmeds_order_id}.`,
          eventType: 'ORDER_CONFIRMED',
          orderData: { ...order, status: newStatus }
        });
      })();

      actionTaken = 'SO_CONFIRMED';
    }

    // Process Shipment Event — Zoho Inventory recorded a Shipment (courier +
    // tracking) against the Sales Order. This is the dispatch-flow mirror of
    // the Finance change above: picking/packing/dispatch/tracking now come
    // FROM Zoho, never from a local button. When Zoho already has tracking
    // details at shipment-creation time (the normal case — "Create Shipment"
    // asks for carrier + tracking number in one step), the order is
    // auto-advanced all the way to completed, exactly like the old local
    // "Enter Tracking" action used to do in one step.
    else if (isShipmentEvent) {
      const trackingNumber = shipment?.tracking_number || shipment?.shipment_number || null;
      const courier = shipment?.carrier || shipment?.delivery_method || shipment?.service_provider || null;

      await db.transaction(async () => {
        const existingDispatch = await db.prepare('SELECT id FROM dispatch_records WHERE order_id = ?').get(order.id);
        if (existingDispatch) {
          await db.prepare(`
            UPDATE dispatch_records
            SET status = 'dispatched', courier = COALESCE(?, courier), tracking_number = COALESCE(?, tracking_number), dispatched_at = COALESCE(dispatched_at, ?)
            WHERE order_id = ?
          `).run(courier, trackingNumber, now, order.id);
        } else {
          await db.prepare(`
            INSERT INTO dispatch_records (order_id, status, tracking_number, courier, dispatched_at, created_at)
            VALUES (?, 'dispatched', ?, ?, ?, ?)
          `).run(order.id, trackingNumber, courier, now, now);
        }

        // Aug 31, 2026 (5): 'ready_for_invoice_sent' added — same reasoning as the
        // Package Created branch above: if Finance invoiced before packing
        // ever started (the confirmed ideal order), the order can reach
        // this webhook already sitting at 'ready_for_invoice_sent' rather than
        // a pre-shipment stage, and it should still be
        // recognized as a valid pre-shipment state.
        //
        // Sep 1, 2026: 'ready_for_dispatch' added alongside it, for exactly the
        // same reason — with the Mark-as-Sent step now modelled, an order
        // that was invoiced AND issued before the warehouse touched it
        // arrives here sitting at 'ready_for_dispatch', and would otherwise be
        // unrecognised as a valid pre-shipment state.
        if (['ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing'].includes(order.status)) {
          const moved = await advanceTo(order.id, order.status, 'dispatched', now);
          if (moved.changed) newStatus = moved.status;
        }

        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_DISPATCHED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: trackingNumber
            ? `Shipment created in Zoho — Tracking: ${trackingNumber} (${courier || 'courier TBD'})`
            : 'Shipment created in Zoho — tracking details pending',
          // Sep 12, 2026: the shipment id, for the duplicate check above.
          metadata: { trackingNumber, courier, zohoShipmentId: shipment?.shipment_id || null }
        });

        // Aug 31, 2026 (3): stop at tracking_shared — do NOT auto-advance to
        // completed. Per Getmeds' actual fulfillment process, dispatch is
        // not the end of the order: Finance still has to convert the Sales
        // Order into an Invoice in Zoho (see isInvoiceDrafted, above) before
        // the order is genuinely finished. The old "tracking_shared ->
        // completed" auto-jump this replaced was inherited from a
        // now-removed local "Enter Tracking" button that used to do both
        // steps in one click — fine for that old flow, wrong here, since it
        // was silently skipping the entire invoice/payment stage and
        // closing orders out early. Advance dispatched -> tracking_shared
        // once tracking details are present, and leave it there.
        if (trackingNumber && newStatus === 'dispatched') {
          const dispatchedStatus = newStatus;
          const moved = await advanceTo(order.id, dispatchedStatus, 'tracking_shared', now);
          if (moved.changed) {
            newStatus = moved.status;
            await logEvent({ orderId: order.id, eventType: 'TRACKING_ENTERED', oldStatus: dispatchedStatus, newStatus, actorId: null, actorName: 'Zoho Webhook', notes: `${courier || 'Courier'}: ${trackingNumber}` });
          }
        }

        // Sep 1, 2026: the other half of the shipped-AND-paid rule. If
        // Finance already recorded the payment (a prepaid order, or simply
        // one where the money came in before the warehouse got to it),
        // shipping is the last of the two and closes the order out here.
        // Same shared function the payment branch calls, so the two arrival
        // orders can't diverge.
        const completion = await evaluateCompletion({
          orderId: order.id,
          currentStatus: newStatus,
          actorName: 'Zoho Webhook',
          trigger: 'shipment'
        });
        if (completion.completed) newStatus = 'completed';

        await notify({
          orderId: order.id,
          recipientIds: [order.medrep_user_id],
          message: trackingNumber
            ? `Order ${order.getmeds_order_id} shipped via Zoho. Courier: ${courier || 'TBD'}, Tracking: ${trackingNumber}.`
            : `Order ${order.getmeds_order_id} has been dispatched in Zoho. Tracking details pending.`,
          eventType: 'ORDER_DISPATCHED',
          orderData: { ...order, status: newStatus, tracking_number: trackingNumber, courier }
        });
      })();

      actionTaken = newStatus === 'completed'
        ? 'DISPATCHED_ORDER_COMPLETED'
        : trackingNumber ? 'DISPATCHED_WITH_TRACKING' : 'DISPATCHED';
    }

    // Process Package Event — Zoho Inventory recorded a Package against the
    // Sales Order (items picked & packed, not yet shipped). Visibility
    // checkpoint only, same pattern as Invoice Drafted for Finance.
    else if (isPackageEvent) {
      await db.transaction(async () => {
        const packageId = zohoPackage?.package_id || null;
        const packageNumber = zohoPackage?.package_number || null;
        const existingDispatch = await db.prepare('SELECT id FROM dispatch_records WHERE order_id = ?').get(order.id);
        if (existingDispatch) {
          // Sep 12, 2026: never backwards. Zoho does not promise to deliver
          // webhooks in order, and a package report arriving after the
          // shipment's used to put a dispatched record back to 'packing'.
          await db.prepare(`UPDATE dispatch_records SET status = 'packing' WHERE order_id = ? AND status IN ('queued', 'picking', 'packing')`).run(order.id);
          await db.prepare('UPDATE dispatch_records SET zoho_package_id = COALESCE(zoho_package_id, ?), zoho_package_number = COALESCE(zoho_package_number, ?) WHERE order_id = ?')
            .run(packageId, packageNumber, order.id);
        } else {
          await db.prepare(`INSERT INTO dispatch_records (order_id, status, zoho_package_id, zoho_package_number, created_at) VALUES (?, 'packing', ?, ?, ?)`)
            .run(order.id, packageId, packageNumber, now);
        }

        // Aug 31, 2026 (5): 'ready_for_invoice_sent' added — per the confirmed
        // ideal workflow, Finance can invoice right after SO confirmation,
        // BEFORE the warehouse packs anything. Without this, an order that
        // got invoiced early would sit at 'ready_for_invoice_sent' and this branch
        // would silently fail to recognize it as a valid pre-packing state,
        // stalling the pipeline the moment Zoho reports packing has started.
        //
        // Sep 1, 2026: 'ready_for_dispatch' added — with Mark-as-Sent now
        // modelled, that is where an invoice-first order actually sits when
        // the warehouse starts packing it, and it would otherwise stall here
        // exactly as the note above describes.
        if (['ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch'].includes(order.status)) {
          const moved = await advanceTo(order.id, order.status, 'picking_packing', now);
          if (moved.changed) newStatus = moved.status;
        }

        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_PACKAGE_CREATED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: 'Package created in Zoho — items picked & packed, awaiting shipment',
          // Sep 12, 2026: the package id, so a second report of the same
          // package is recognised (the duplicate check above).
          metadata: { rawEvent, zohoPackageId: packageId, zohoPackageNumber: packageNumber }
        });

        await notify({
          orderId: order.id,
          recipientIds: [order.medrep_user_id],
          message: `Order ${order.getmeds_order_id} is being picked & packed (Package created in Zoho).`,
          eventType: 'DISPATCH_STATUS_UPDATE',
          orderData: { ...order, status: newStatus }
        });
      })();

      actionTaken = 'PACKAGE_CREATED';
    }

    // Process Cancellation / Deletion Event
    else if (isSalesOrderCancelled || isSalesOrderDeleted) {
      // Sep 1, 2026 (2): a deletion now lands on its own 'deleted' status
      // rather than sharing 'cancelled' with a void. Zoho fires a workflow
      // for each; they are different events and the badge should say so.
      // Until now the distinction lived only in the audit trail, so on the
      // Orders list a removed Sales Order and a voided one looked identical.
      //
      // 'completed' is deliberately NOT overwritten: deleting the Zoho
      // record after an order has already shipped and been paid does not
      // un-finish that order. The deletion is still recorded on the
      // timeline, with wording that says the status was intentionally left
      // alone. Same for an order already 'cancelled' — it is closed out
      // either way, and the trail carries the detail.
      const isFinished = ['completed', 'cancelled', 'deleted'].includes(order.status);
      {
        if (!isFinished) newStatus = isSalesOrderDeleted ? 'deleted' : 'cancelled';
        // Aug 31, 2026: distinct wording/event type for an actual delete —
        // see the isSalesOrderDeleted comment above for why this matters to
        // Finance reading the trail.
        const eventType = isSalesOrderDeleted ? 'ZOHO_SO_DELETED' : 'ZOHO_SO_CANCELLED';
        const baseNote = isSalesOrderDeleted
          ? 'Sales Order deleted in Zoho — the record no longer exists there.'
          : 'Sales Order cancelled or voided in Zoho';
        // Sep 1, 2026 (2): when the order is already finished this used to
        // log nothing at all — the whole branch was skipped — so a Sales
        // Order deleted after an order shipped left no trace anywhere.
        // Recording it is the entire point of the Zoho-side workflow, so the
        // entry is always written now; only the STATUS change is conditional.
        const notifyVerb = isSalesOrderDeleted ? 'deleted' : 'cancelled';
        let refused = false;

        await db.transaction(async () => {
          // Cancellation can arrive from almost anywhere in the pipeline, so
          // it goes through setOrderStatus rather than advanceTo — if the
          // state machine refuses it, that's a gap in the map worth seeing in
          // the log, not something to silently skip.
          const moved = await setOrderStatus(order.id, order.status, newStatus, now);
          if (!moved.changed) {
            newStatus = moved.status;
            refused = moved.refused;
          }

          // Sep 1, 2026 (3): the note is built AFTER the write is attempted,
          // so a refusal can say so. It used to be computed beforehand, which
          // meant a refused transition produced an entry claiming the event
          // had been applied while the status sat unchanged (X -> X) — the
          // reason existed only as a console warning. Seen for real on
          // TestGM-20260901-0002.
          const notes = refused
            ? `${baseNote} The order could NOT be moved from "${order.status}" to "${isSalesOrderDeleted ? 'deleted' : 'cancelled'}" — the workflow does not allow that transition (see workflow/stateMachine.js). Status left unchanged; this needs a look.`
            : isFinished
              ? `${baseNote} Order status kept as "${order.status}" — it had already finished, and removing the Zoho record does not undo that.`
              : baseNote;

          await logEvent({
            orderId: order.id,
            eventType,
            oldStatus: previousStatus,
            newStatus: newStatus,
            actorId: null,
            actorName: 'Zoho Webhook',
            notes,
            metadata: { rawEvent, refused }
          });

          const adminUserIds = await getUserIdsByRole('admin', 'management');
          const recipients = Array.from(new Set([order.medrep_user_id, ...adminUserIds].filter(Boolean)));
          await notify({
            orderId: order.id,
            recipientIds: recipients,
            message: refused
              ? `Order ${order.getmeds_order_id} was ${notifyVerb} in Zoho, but its status could not be updated automatically — please check it.`
              : isFinished
                ? `The Zoho Sales Order for ${order.getmeds_order_id} was ${notifyVerb}. The order itself had already finished, so its status is unchanged.`
                : `Order ${order.getmeds_order_id} was ${notifyVerb} in Zoho.`,
            eventType: isSalesOrderDeleted ? 'ORDER_DELETED_IN_ZOHO' : 'ORDER_CANCELLED',
            orderData: { ...order, status: newStatus }
          });
        })();
        const suffix = refused ? '_NOT_APPLIED' : isFinished ? '_LOGGED_ONLY' : '';
        actionTaken = (isSalesOrderDeleted ? 'SO_DELETED' : 'SO_CANCELLED') + suffix;
      }
    }
    // Aug 30, 2026: "Sales Order edited directly in Zoho" — set up in Zoho
    // as its own Workflow Rule (trigger: Sales Order > Edit, NOT
    // Create-or-Edit, so this never fires from the app's own creation call)
    // sending a static event_type of exactly "salesorder.edited" plus the
    // record's Sales Order ID — see ZOHO_SALES_ORDER_FIELD_MAPPING.md for
    // the exact setup steps. Deliberately matched on that literal
    // event_type string rather than a loose "contains 'edit'" check, so a
    // future/unrelated Zoho event type is never mistaken for this one.
    //
    // Whatever fields the Workflow Rule's webhook body does or doesn't
    // include, this always re-fetches the authoritative current record via
    // the API (zoho.getSalesOrder) rather than trusting the webhook
    // payload's shape — Zoho's own webhook body templates are easy to
    // misconfigure/under-populate, and a stale/partial payload would
    // otherwise show a false or incomplete diff.
    //
    // Aug 31, 2026: use the LOCAL order's own zoho_so_id (set back when this
    // order was first created in Zoho) for the re-fetch, not whatever
    // identifier the webhook body carried. findOrder() above already
    // resolved `order` successfully via zoho_so_number/reference/id — so by
    // this point we HAVE the order, and order.zoho_so_id is guaranteed to be
    // Zoho's real internal record ID, unlike a webhook body param that might
    // hold the human-readable Sales Order Number (e.g. "SO-66824") depending
    // on which merge field got picked when the Workflow Rule was set up.
    // Calling the API with a Sales Order Number instead of the real ID would
    // fail outright, so this sidesteps that misconfiguration entirely.
    //
    // Sep 22, 2026: split-invoicing orders — `zohoSoId` (the webhook's own
    // reported id) is only a safe stand-in for order.zoho_so_id when
    // order.zoho_so_id is genuinely just not written yet. It stopped being
    // safe the moment an order could have a SECOND Sales Order: on
    // TestGM-20260922-0001, this fell back to zohoSoId while the primary's
    // own zoho_so_id was still null (its sync had failed and not yet been
    // retried), and zohoSoId turned out to belong to the order's SPLIT
    // instead — order._splitMatch had not resolved yet either (a race right
    // after createSplitSalesOrder's own INSERT). The result: the split's
    // Sales Order got fetched and treated as if it were THIS order's own —
    // corrupting both its header fields (diffSalesOrderFields below) and,
    // via syncLineItemsFromZoho, wiping every item that wasn't on that one
    // Sales Order. Checked here, once, before ever trusting the fallback.
    else if (rawEvent === 'salesorder.edited' && (order.zoho_so_id || zohoSoId)) {
      // Sep 22, 2026: `zohoSoId` (the webhook's own reported id) is only a
      // safe stand-in for order.zoho_so_id when order.zoho_so_id is
      // genuinely just not written yet. It stopped being safe the moment an
      // order could have a SECOND Sales Order: on TestGM-20260922-0001, this
      // fell back to zohoSoId while the primary's own zoho_so_id was still
      // null (its sync had failed and not yet been retried), and zohoSoId
      // turned out to belong to the order's SPLIT instead —
      // order._splitMatch had not resolved yet either (a race right after
      // createSplitSalesOrder's own INSERT). The result: the split's Sales
      // Order got fetched and treated as if it were THIS order's own —
      // corrupting both its header fields (diffSalesOrderFields below) and,
      // via syncLineItemsFromZoho, wiping every item that wasn't on that
      // one Sales Order. Checked here, once, before ever trusting it.
      const belongsToOwnSplit = Boolean(
        zohoSoId && zohoSoId !== order.zoho_so_id &&
        await db.prepare('SELECT 1 FROM order_split_sales_orders WHERE order_id = ? AND zoho_so_id = ?').get(order.id, zohoSoId)
      );
      if (belongsToOwnSplit) {
        // This event is genuinely about a split's own Sales Order, not the
        // primary — it will route to the split path correctly on its next
        // event (findOrder()'s zoho_so_id match no longer races once this
        // row exists). Log that plainly rather than silently doing nothing.
        console.warn(`[ZOHO_WEBHOOK] salesorder.edited for ${zohoSoId} belongs to a split of order ${order.id} but was not routed there yet — declining to touch the primary's data.`);
        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_EVENT_RECEIVED',
          oldStatus: previousStatus,
          newStatus: previousStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: `Sales Order ${zohoSoId} was edited in Zoho — it belongs to one of this order's split entities, and will be picked up once its own event routes there.`,
          metadata: { rawEvent, zohoSoId }
        });
        actionTaken = 'SPLIT_EDIT_DEFERRED';
        return res.status(200).json({
          success: true,
          processed: true,
          action: actionTaken,
          order_id: order.getmeds_order_id,
          previous_status: previousStatus,
          new_status: previousStatus
        });
      }

      const idToFetch = order.zoho_so_id || zohoSoId;
      let liveSalesOrder = null;
      try {
        const result = await zoho.getSalesOrder(idToFetch);
        liveSalesOrder = result?.salesorder;
      } catch (fetchErr) {
        console.warn(`[ZOHO_WEBHOOK] Could not re-fetch Sales Order ${idToFetch} for edit diff: ${fetchErr.message}`);
      }

      if (!liveSalesOrder) {
        await logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_EDITED',
          oldStatus: previousStatus,
          newStatus: previousStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: 'Sales Order was edited in Zoho, but this app could not re-fetch it to show what changed — check Zoho directly.',
          metadata: { rawEvent, zohoSoId: idToFetch }
        });
        actionTaken = 'EDIT_LOGGED_NO_DIFF';
      } else {
        // Sep 11, 2026: `baseline` entries are Zoho's value filling a column
        // this app never stored (an older order's Salesperson). Written below,
        // but not reported as an edit somebody made.
        const allChanges = diffSalesOrderFields(liveSalesOrder, order);
        const changes = allChanges.filter((c) => !c.baseline);

        // Aug 31, 2026 (2): also catch a Zoho-side Sales Order STATUS change
        // (e.g. clicking "Confirm" in Zoho's own UI moves status
        // "draft" -> "confirmed") — this rides the exact same Workflow Rule
        // as every other edit (it's "any field is updated", and status is a
        // field), so no separate Zoho automation is needed for this.
        // Zoho's `status` isn't one of zohoEditDiffService's 6 tracked
        // fields (those all have a matching MedRep-facing local column;
        // this app's own `orders.status` is a completely different thing —
        // its own dispatch pipeline stage, not Zoho's SO lifecycle) so it's
        // compared against its own dedicated `zoho_so_status` column here.
        // A null previous value (first time this runs after the column was
        // added, or for an order created before this feature existed) is
        // treated as "just learning the baseline" rather than a real
        // transition, so it doesn't produce a false "status changed" note.
        const liveZohoStatus = liveSalesOrder.status ? String(liveSalesOrder.status).trim().toLowerCase() : null;
        const previousZohoStatus = order.zoho_so_status ? String(order.zoho_so_status).trim().toLowerCase() : null;
        const zohoStatusChanged = Boolean(previousZohoStatus) && Boolean(liveZohoStatus) && liveZohoStatus !== previousZohoStatus;
        const statusNote = zohoStatusChanged
          ? `Sales Order ${liveZohoStatus === 'confirmed' ? 'confirmed' : 'status changed'} in Zoho (${previousZohoStatus} → ${liveZohoStatus})`
          : null;

        await db.transaction(async () => {
          if (allChanges.length) {
            const setClause = allChanges.map((c) => `${c.localColumn} = ?`).join(', ');
            const values = allChanges.map((c) => c.newValue);
            await db.prepare(`UPDATE orders SET ${setClause}, updated_at = ? WHERE id = ?`).run(...values, now, order.id);
          }
          if (liveZohoStatus && liveZohoStatus !== previousZohoStatus) {
            await db.prepare('UPDATE orders SET zoho_so_status = ?, updated_at = ? WHERE id = ?').run(liveZohoStatus, now, order.id);
          }

          const fieldNote = changes.length ? `Sales Order edited in Zoho — ${summarizeChanges(changes)}` : null;
          const notes = [statusNote, fieldNote].filter(Boolean).join('; ') ||
            'Sales Order edited in Zoho (no change detected in the fields this app tracks — e.g. an item, address, or tax edit; check Zoho for details)';

          await logEvent({
            orderId: order.id,
            eventType: zohoStatusChanged ? 'ZOHO_SO_STATUS_CHANGED' : 'ZOHO_SO_EDITED',
            oldStatus: previousStatus,
            newStatus: previousStatus,
            actorId: null,
            actorName: 'Zoho Webhook',
            notes,
            metadata: { rawEvent, zohoSoId, changes, zohoStatus: { from: previousZohoStatus, to: liveZohoStatus } }
          });
        })();

        // Sep 14, 2026: the line items and the total. The diff above covers
        // seven header fields only, so an item swapped or re-priced in Zoho
        // was logged as "edited" while the order kept its old lines. Uses the
        // Sales Order already re-fetched above. See zohoLineSyncService.js.
        try {
          await syncLineItemsFromZoho({ order, salesorder: liveSalesOrder, actorName: 'Zoho Webhook' });
        } catch (syncErr) {
          console.error('[ZOHO_WEBHOOK] line-item sync failed:', syncErr.message);
        }

        if (changes.length || zohoStatusChanged) {
          const financeIds = await getUserIdsByRole('finance');
          const message = [statusNote, changes.length ? summarizeChanges(changes) : null].filter(Boolean).join(' — ');
          await notify({
            orderId: order.id,
            recipientIds: Array.from(new Set([order.medrep_user_id, ...financeIds].filter(Boolean))),
            message: `Order ${order.getmeds_order_id} — ${message}`,
            eventType: zohoStatusChanged ? 'ZOHO_SO_STATUS_CHANGED' : 'ZOHO_SO_EDITED',
            orderData: { ...order }
          });
        }

        actionTaken = zohoStatusChanged
          ? 'STATUS_CHANGE_LOGGED'
          : changes.length ? 'EDIT_LOGGED' : 'EDIT_LOGGED_NO_TRACKED_CHANGE';
      }
    } else {
      // General Zoho event / sync update
      await logEvent({
        orderId: order.id,
        eventType: 'ZOHO_EVENT_RECEIVED',
        oldStatus: previousStatus,
        newStatus: previousStatus,
        actorId: null,
        actorName: 'Zoho Webhook',
        notes: `Zoho event received: ${rawEvent || 'unspecified'}`,
        metadata: { rawEvent, body }
      });
      actionTaken = 'LOGGED_ONLY';
    }

    return res.status(200).json({
      success: true,
      processed: true,
      action: actionTaken,
      order_id: order.getmeds_order_id,
      previous_status: previousStatus,
      new_status: newStatus
    });
  } catch (err) {
    next(err);
  }
};
