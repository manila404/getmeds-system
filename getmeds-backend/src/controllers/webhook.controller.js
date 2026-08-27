const db = require('../db/database');
const { logEvent } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');

/**
 * Validates optional Zoho Webhook secret / token.
 */
function verifyWebhookAuth(req) {
  const secret = process.env.ZOHO_WEBHOOK_SECRET;
  if (!secret) return true; // If secret is not configured, allow request (development mode)

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

  const rawEvent =
    req.body.event_type ||
    req.body.event ||
    req.body.type ||
    req.headers['x-zoho-event'] ||
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
 */
function findOrder(identifier) {
  if (!identifier) return null;
  return db.prepare(`
    SELECT o.*, c.name as customer_name, c.type as customer_type_detail,
           u.id as medrep_user_id, u.name as medrep_name, u.email as medrep_email
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON o.medrep_id = u.id
    WHERE o.zoho_so_id = ? OR o.getmeds_order_id = ? OR o.zoho_so_number = ?
  `).get(String(identifier), String(identifier), String(identifier));
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

    const order = findOrder(identifier) || (zohoSoId ? findOrder(zohoSoId) : null) || (refNumber ? findOrder(refNumber) : null);

    if (!order) {
      console.warn(`[ZOHO_WEBHOOK] No local order found matching identifier: ${identifier}`);
      return res.status(200).json({
        success: true,
        processed: false,
        message: 'Webhook received but order is not present in local database',
        identifier
      });
    }

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

    // Finance converted the (confirmed) Sales Order into an Invoice in
    // Zoho, but hasn't recorded a payment against it yet. Checked *after*
    // isPaymentEvent above, so an already-paid invoice never falls through
    // to here — payment always wins when both could match.
    const isInvoiceDrafted =
      !isPaymentEvent &&
      (rawEvent.includes('invoice.created') ||
        rawEvent.includes('invoice.drafted') ||
        rawEvent.includes('invoice_created') ||
        (invoice && (invStatus === 'draft' || invStatus === 'sent' || invStatus === 'open')));

    const isSalesOrderConfirmed =
      rawEvent.includes('salesorder.confirmed') ||
      rawEvent.includes('salesorder_confirmed') ||
      soStatus === 'confirmed' || soStatus === 'open';

    const isSalesOrderCancelled =
      rawEvent.includes('salesorder.void') ||
      rawEvent.includes('salesorder.cancelled') ||
      rawEvent.includes('salesorder.deleted') ||
      soStatus === 'void' || soStatus === 'cancelled' || soStatus === 'voided';

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

    // Process Payment Event
    if (isPaymentEvent) {
      const paymentAmount = payment?.amount || invoice?.payment_made || order.total_amount;
      const paymentRef = payment?.payment_number || payment?.reference_number || payment?.payment_id || 'ZOHO-PAYMENT';
      const paymentDate = payment?.date || now.split('T')[0];

      db.transaction(() => {
        // Upsert payment record
        const existingPayment = db.prepare('SELECT id FROM payments WHERE order_id = ?').get(order.id);
        if (existingPayment) {
          db.prepare(`
            UPDATE payments
            SET status = 'verified', payment_reference = ?, amount = ?, payment_date = ?, notes = 'Verified via Zoho Webhook', verified_at = ?
            WHERE order_id = ?
          `).run(paymentRef, paymentAmount, paymentDate, now, order.id);
        } else {
          db.prepare(`
            INSERT INTO payments (order_id, status, payment_reference, amount, payment_date, notes, verified_at, created_at)
            VALUES (?, 'verified', ?, ?, ?, 'Verified via Zoho Webhook', ?, ?)
          `).run(order.id, paymentRef, paymentAmount, paymentDate, now, now);
        }

        // If order was waiting for payment, invoiced-but-unpaid, or on_hold, advance to ready_for_dispatch
        if (['waiting_for_payment', 'invoice_drafted', 'on_hold', 'so_created'].includes(order.status)) {
          newStatus = 'ready_for_dispatch';
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);
        }

        logEvent({
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
        const dispatchUserIds = getUserIdsByRole('dispatch', 'finance');
        const recipients = Array.from(new Set([order.medrep_user_id, ...dispatchUserIds].filter(Boolean)));
        notify({
          orderId: order.id,
          recipientIds: recipients,
          message: `Payment for ${order.getmeds_order_id} was verified in Zoho. Order status: ${newStatus}.`,
          eventType: 'PAYMENT_VERIFIED',
          orderData: { ...order, status: newStatus }
        });
      })();

      actionTaken = 'PAYMENT_VERIFIED';
    }

    // Process Invoice Drafted Event — Finance converted the confirmed
    // Sales Order to an Invoice in Zoho. This is a visibility checkpoint,
    // not a payment: the order does not advance to ready_for_dispatch here,
    // it just records that an invoice now exists so Finance/MedRep can see
    // it, until the real payment webhook (above) moves it forward.
    else if (isInvoiceDrafted) {
      const zohoInvoiceNumber = invoice?.invoice_number || order.zoho_invoice_number;
      const zohoInvoiceId = invoice?.invoice_id || order.zoho_invoice_id;

      db.transaction(() => {
        if (['so_created', 'waiting_for_payment'].includes(order.status)) {
          newStatus = 'invoice_drafted';
        }

        db.prepare(`
          UPDATE orders
          SET status = ?, zoho_invoice_id = COALESCE(?, zoho_invoice_id), zoho_invoice_number = COALESCE(?, zoho_invoice_number),
              updated_at = ?
          WHERE id = ?
        `).run(newStatus, zohoInvoiceId || null, zohoInvoiceNumber || null, now, order.id);

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_INVOICE_DRAFTED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: `Invoice drafted in Zoho (${zohoInvoiceNumber || zohoInvoiceId || 'no number yet'})`,
          metadata: { zohoInvoiceId, zohoInvoiceNumber }
        });

        const financeIds = getUserIdsByRole('finance');
        notify({
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

      db.transaction(() => {
        // Decide next status if still in preliminary stages
        if (['submitted', 'validating', 'so_pending'].includes(order.status)) {
          if (order.customer_type === 'direct') {
            newStatus = 'waiting_for_payment';
          } else {
            newStatus = 'ready_for_dispatch';
          }
        }

        db.prepare(`
          UPDATE orders
          SET status = ?, zoho_so_id = COALESCE(?, zoho_so_id), zoho_so_number = COALESCE(?, zoho_so_number),
              zoho_sync_status = 'synced', updated_at = ?
          WHERE id = ?
        `).run(newStatus, soId || null, zohoSoNumber || null, now, order.id);

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_CONFIRMED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: `Sales Order confirmed in Zoho (${zohoSoNumber || soId})`,
          metadata: { zohoSoId: soId, zohoSoNumber }
        });

        notify({
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

      db.transaction(() => {
        const existingDispatch = db.prepare('SELECT id FROM dispatch_records WHERE order_id = ?').get(order.id);
        if (existingDispatch) {
          db.prepare(`
            UPDATE dispatch_records
            SET status = 'dispatched', courier = COALESCE(?, courier), tracking_number = COALESCE(?, tracking_number), dispatched_at = COALESCE(dispatched_at, ?)
            WHERE order_id = ?
          `).run(courier, trackingNumber, now, order.id);
        } else {
          db.prepare(`
            INSERT INTO dispatch_records (order_id, status, tracking_number, courier, dispatched_at, created_at)
            VALUES (?, 'dispatched', ?, ?, ?, ?)
          `).run(order.id, trackingNumber, courier, now, now);
        }

        if (['ready_for_dispatch', 'picking_packing'].includes(order.status)) {
          newStatus = 'dispatched';
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);
        }

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_DISPATCHED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: trackingNumber
            ? `Shipment created in Zoho — Tracking: ${trackingNumber} (${courier || 'courier TBD'})`
            : 'Shipment created in Zoho — tracking details pending',
          metadata: { trackingNumber, courier }
        });

        // Auto-advance dispatched -> tracking_shared -> completed once
        // tracking details are present, mirroring the old local cascade.
        if (trackingNumber && newStatus === 'dispatched') {
          const dispatchedStatus = newStatus;
          newStatus = 'tracking_shared';
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);
          logEvent({ orderId: order.id, eventType: 'TRACKING_ENTERED', oldStatus: dispatchedStatus, newStatus, actorId: null, actorName: 'Zoho Webhook', notes: `${courier || 'Courier'}: ${trackingNumber}` });

          const trackingSharedStatus = newStatus;
          newStatus = 'completed';
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);
          logEvent({ orderId: order.id, eventType: 'ORDER_COMPLETED', oldStatus: trackingSharedStatus, newStatus, actorId: null, actorName: 'Zoho Webhook' });
        }

        notify({
          orderId: order.id,
          recipientIds: [order.medrep_user_id],
          message: trackingNumber
            ? `Order ${order.getmeds_order_id} shipped via Zoho. Courier: ${courier || 'TBD'}, Tracking: ${trackingNumber}.`
            : `Order ${order.getmeds_order_id} has been dispatched in Zoho. Tracking details pending.`,
          eventType: trackingNumber ? 'ORDER_COMPLETED' : 'ORDER_DISPATCHED',
          orderData: { ...order, status: newStatus, tracking_number: trackingNumber, courier }
        });
      })();

      actionTaken = trackingNumber ? 'DISPATCHED_WITH_TRACKING' : 'DISPATCHED';
    }

    // Process Package Event — Zoho Inventory recorded a Package against the
    // Sales Order (items picked & packed, not yet shipped). Visibility
    // checkpoint only, same pattern as Invoice Drafted for Finance.
    else if (isPackageEvent) {
      db.transaction(() => {
        const existingDispatch = db.prepare('SELECT id FROM dispatch_records WHERE order_id = ?').get(order.id);
        if (existingDispatch) {
          db.prepare(`UPDATE dispatch_records SET status = 'packing' WHERE order_id = ?`).run(order.id);
        } else {
          db.prepare(`INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'packing', ?)`).run(order.id, now);
        }

        if (order.status === 'ready_for_dispatch') {
          newStatus = 'picking_packing';
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);
        }

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_PACKAGE_CREATED',
          oldStatus: previousStatus,
          newStatus: newStatus,
          actorId: null,
          actorName: 'Zoho Webhook',
          notes: 'Package created in Zoho — items picked & packed, awaiting shipment',
          metadata: { rawEvent }
        });

        notify({
          orderId: order.id,
          recipientIds: [order.medrep_user_id],
          message: `Order ${order.getmeds_order_id} is being picked & packed (Package created in Zoho).`,
          eventType: 'DISPATCH_STATUS_UPDATE',
          orderData: { ...order, status: newStatus }
        });
      })();

      actionTaken = 'PACKAGE_CREATED';
    }

    // Process Cancellation Event
    else if (isSalesOrderCancelled) {
      if (!['completed', 'cancelled'].includes(order.status)) {
        newStatus = 'cancelled';
        db.transaction(() => {
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);

          logEvent({
            orderId: order.id,
            eventType: 'ZOHO_SO_CANCELLED',
            oldStatus: previousStatus,
            newStatus: newStatus,
            actorId: null,
            actorName: 'Zoho Webhook',
            notes: 'Sales Order cancelled or voided in Zoho',
            metadata: { rawEvent }
          });

          const adminUserIds = getUserIdsByRole('admin', 'management');
          const recipients = Array.from(new Set([order.medrep_user_id, ...adminUserIds].filter(Boolean)));
          notify({
            orderId: order.id,
            recipientIds: recipients,
            message: `Order ${order.getmeds_order_id} was cancelled in Zoho.`,
            eventType: 'ORDER_CANCELLED',
            orderData: { ...order, status: newStatus }
          });
        })();
        actionTaken = 'SO_CANCELLED';
      }
    } else {
      // General Zoho event / sync update
      logEvent({
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
