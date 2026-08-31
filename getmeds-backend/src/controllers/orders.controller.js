const db = require('../db/database');
const stateMachine = require('../workflow/stateMachine');
const { generateOrderId } = require('../services/orderIdService');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const zoho = require('../integrations/zoho');
const zohoRetryService = require('../services/zohoRetryService');
const { isDryRunMode, getTestCustomerZohoId } = require('../services/zohoTestFlags');

// ─── ZOHO TEST-CUSTOMER SAFETY GATE (Aug 27, 2026) ────────────────────────────
//
// While ZOHO_TEST_CUSTOMER_ID is set (a Zoho contact id), this app refuses
// to create a Zoho Sales Order for any customer other than the one local
// row mapped to that contact id — server-side, not just a filtered
// dropdown, so a direct API call can't bypass it either. Leave the env var
// unset to disable the gate entirely (all customers usable, as before).
//
// Bypassed entirely while ZOHO_DRY_RUN is on: dry run mode never calls
// Zoho for ANY customer (see buildDryRunSalesOrder below), so there is
// nothing for this gate to protect against — restricting it would only
// get in the way of testing broadly against real customers pulled in via
// sync-from-zoho.
function checkTestCustomerGate(customer) {
  if (isDryRunMode()) return null; // dry run: no Zoho call happens for anyone, gate is moot
  const testZohoId = getTestCustomerZohoId();
  if (!testZohoId) return null; // gate disabled
  if (customer.zoho_contact_id === testZohoId) return null; // it's the one allowed customer
  return {
    code: 'TEST_CUSTOMER_ONLY',
    message: `Order creation is currently restricted to the designated TEST customer only ` +
      `(safety gate while testing against the real company Zoho). "${customer.name}" is not it.`
  };
}

// ─── ZOHO DRY RUN (Aug 27, 2026) ───────────────────────────────────────────────
//
// While ZOHO_DRY_RUN=true, create/submit below skip the real
// zoho.createSalesOrder() call completely — no HTTP request is made, so it
// is structurally impossible for a dry-run order to write anything to
// Zoho, regardless of customer or ZOHO_MODE. This function fabricates a
// response shaped exactly like a real one (same fields the rest of this
// controller and the frontend already read: salesorder_id,
// salesorder_number, notes, line_items, ...) so the whole local flow —
// state machine, notifications, audit trail — runs precisely as it would
// against a real Zoho response. The fabricated id/number are prefixed
// DRYRUN- so nothing downstream could ever mistake one for a real Zoho
// Sales Order id.
function buildDryRunSalesOrder(payload) {
  const fakeId = `DRYRUN-${payload.getmeds_order_id}`;
  return {
    code: 0,
    message: 'Sales order NOT sent to Zoho — ZOHO_DRY_RUN is enabled',
    salesorder: {
      salesorder_id: fakeId,
      salesorder_number: fakeId,
      status: 'draft',
      customer_id: payload.zoho_customer_id || null,
      customer_name: payload.customer_name,
      total: payload.total_amount,
      reference_number: payload.getmeds_order_id,
      notes: `[DRY RUN — nothing was sent to Zoho] Getmeds Order: ${payload.getmeds_order_id}`,
      date: new Date().toISOString().slice(0, 10),
      line_items: (payload.items || []).map((item) => ({
        item_id: item.zoho_item_id || null,
        name: item.name,
        quantity: item.quantity,
        rate: item.unit_price,
        item_total: item.subtotal
      })),
      created_time: new Date().toISOString(),
      _dry_run: true
    }
  };
}

// ─── META ──────────────────────────────────────────────────────────────────────

// Aug 27, 2026: while ZOHO_TEST_CUSTOMER_ID is set, this app is restricted
// to a single designated TEST customer for creating live Zoho Sales Orders
// (safety gate for testing against the real company Zoho — see
// customers.controller.js and the hard server-side check in create/submit
// below). The order-creation dropdown only ever shows that one customer
// while the gate is on, so a MedRep never picks one that will be rejected.
// Leave ZOHO_TEST_CUSTOMER_ID unset to see/select every local customer, as
// before.
exports.getCustomers = (req, res, next) => {
  try {
    const dryRun = isDryRunMode();
    // Dry run bypasses the gate everywhere (see checkTestCustomerGate), so
    // the dropdown shows every customer too — no point filtering it down
    // to one when no order created here can ever reach Zoho anyway.
    const testZohoId = dryRun ? null : (getTestCustomerZohoId() || null);
    const customers = testZohoId
      ? db.prepare('SELECT * FROM customers WHERE is_active = 1 AND zoho_contact_id = ? ORDER BY name').all(testZohoId)
      : db.prepare('SELECT * FROM customers WHERE is_active = 1 ORDER BY name').all();
    res.json({
      success: true,
      data: { customers, test_customer_gate_enabled: !!testZohoId, zoho_dry_run_enabled: dryRun }
    });
  } catch (err) { next(err); }
};

exports.getProducts = (req, res, next) => {
  try {
    const products = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY name').all();
    res.json({ success: true, data: { products } });
  } catch (err) { next(err); }
};

// ─── LIST / GET ────────────────────────────────────────────────────────────────

exports.getAll = (req, res, next) => {
  try {
    const { status, customer_type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    let params = [];

    // MedReps only see their own orders
    if (req.user.role === 'medrep') {
      where.push('o.medrep_id = ?');
      params.push(req.user.id);
    }
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customer_type) { where.push('o.customer_type = ?'); params.push(customer_type); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = db.prepare(`
      SELECT o.*, c.name as customer_name, c.type as customer_type_detail,
             u.name as medrep_name,
             p.status as payment_status,
             d.status as dispatch_status, d.tracking_number, d.courier
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      LEFT JOIN dispatch_records d ON o.id = d.order_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const totalRow = db.prepare(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`
    ).get(...params);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          total: totalRow.total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(totalRow.total / parseInt(limit))
        }
      }
    });
  } catch (err) { next(err); }
};

exports.getById = (req, res, next) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_person, c.contact_number,
             u.name as medrep_name, u.email as medrep_email
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });

    // MedRep can only see their own orders
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    const items = db.prepare(`
      SELECT oi.*, p.name as product_name, p.sku, p.unit
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(order.id);

    const payment = db.prepare(`
      SELECT p.*, u.name as verified_by_name
      FROM payments p
      LEFT JOIN users u ON p.verified_by = u.id
      WHERE p.order_id = ?
    `).get(order.id);

    const dispatch = db.prepare(`
      SELECT d.*, u.name as dispatched_by_name
      FROM dispatch_records d
      LEFT JOIN users u ON d.dispatched_by = u.id
      WHERE d.order_id = ?
    `).get(order.id);

    const events = db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC'
    ).all(order.id);

    res.json({ success: true, data: { order, items, payment, dispatch, events } });
  } catch (err) { next(err); }
};

// ─── ZOHO RECONCILE (manual fallback for a missed webhook) ────────────────────
//
// The webhook in webhook.controller.js is the primary way this app hears
// "the Sales Order was confirmed in Zoho" — but it only arrives if the
// backend + ngrok tunnel were actually running and reachable at the exact
// moment Finance clicked Confirm. If they weren't (dev server restarted,
// ngrok's free-tier URL rotated, whatever), Zoho does not retry, and the
// confirmation silently never reaches this app — the order's audit trail
// just stops at "ORDER SUBMITTED" even though Zoho itself shows Confirmed.
//
// This endpoint is the fallback: it asks Zoho directly for this order's
// Sales Order right now and, if Zoho reports it Confirmed/Open (or
// Void/Cancelled) but that hasn't been logged yet, backfills the exact same
// audit trail entry + notification the webhook would have written — same
// event type, same status transition, just stamped with the current time
// (Zoho's API doesn't expose *when* the SO was confirmed, only its current
// state, so "the moment this was noticed" is the closest available
// timestamp). Idempotent — safe to call repeatedly.
exports.syncFromZoho = async (req, res, next) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name, u.email as medrep_email, u.id as medrep_user_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    if (!order.zoho_so_id) {
      return res.status(400).json({ success: false, error: { code: 'NO_ZOHO_SO', message: 'This order does not have a Zoho Sales Order yet.' } });
    }

    let salesorder;
    try {
      const result = await zoho.getSalesOrder(order.zoho_so_id);
      salesorder = result?.salesorder;
    } catch (zohoErr) {
      return res.status(502).json({ success: false, error: { code: 'ZOHO_FETCH_FAILED', message: `Could not reach Zoho: ${zohoErr.message}` } });
    }
    if (!salesorder) {
      return res.status(502).json({ success: false, error: { code: 'ZOHO_FETCH_FAILED', message: 'Zoho returned no Sales Order data' } });
    }

    const soStatus = typeof salesorder.status === 'string' ? salesorder.status.toLowerCase() : null;
    const isConfirmed = soStatus === 'confirmed' || soStatus === 'open';
    const isCancelled = soStatus === 'void' || soStatus === 'cancelled' || soStatus === 'voided';

    const alreadyLogged = (eventType) =>
      !!db.prepare('SELECT id FROM order_events WHERE order_id = ? AND event_type = ?').get(order.id, eventType);

    const now = new Date().toISOString();
    let action = 'NOTHING_NEW';
    let newStatus = order.status;

    if (isConfirmed && !alreadyLogged('ZOHO_SO_CONFIRMED')) {
      const zohoSoNumber = salesorder.salesorder_number || order.zoho_so_number;
      if (['submitted', 'validating', 'so_pending'].includes(order.status)) {
        newStatus = order.customer_type === 'direct' ? 'waiting_for_payment' : 'ready_for_dispatch';
      }

      db.transaction(() => {
        db.prepare(`
          UPDATE orders SET status = ?, zoho_so_number = COALESCE(?, zoho_so_number), zoho_sync_status = 'synced', updated_at = ?
          WHERE id = ?
        `).run(newStatus, zohoSoNumber || null, now, order.id);

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_CONFIRMED',
          oldStatus: order.status,
          newStatus,
          actorId: req.user?.id || null,
          actorName: `${req.user?.name || 'User'} (manual Zoho sync)`,
          notes: `Sales Order confirmed in Zoho (${zohoSoNumber || order.zoho_so_id}) — backfilled by manual sync; the live webhook did not reach this app when it actually happened`,
          metadata: { zohoSoId: order.zoho_so_id, zohoSoNumber, source: 'manual_reconcile' }
        });

        notify({
          orderId: order.id,
          recipientIds: [order.medrep_user_id],
          message: `Zoho Sales Order ${zohoSoNumber || ''} confirmed for ${order.getmeds_order_id}.`,
          eventType: 'ORDER_CONFIRMED',
          orderData: { ...order, status: newStatus }
        });
      })();

      action = 'SO_CONFIRMED_BACKFILLED';
    } else if (isCancelled && !alreadyLogged('ZOHO_SO_CANCELLED') && !['completed', 'cancelled'].includes(order.status)) {
      newStatus = 'cancelled';

      db.transaction(() => {
        db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_CANCELLED',
          oldStatus: order.status,
          newStatus,
          actorId: req.user?.id || null,
          actorName: `${req.user?.name || 'User'} (manual Zoho sync)`,
          notes: 'Sales Order cancelled or voided in Zoho — backfilled by manual sync',
          metadata: { source: 'manual_reconcile' }
        });

        const adminIds = getUserIdsByRole('admin', 'management');
        notify({
          orderId: order.id,
          recipientIds: Array.from(new Set([order.medrep_user_id, ...adminIds].filter(Boolean))),
          message: `Order ${order.getmeds_order_id} was cancelled in Zoho.`,
          eventType: 'ORDER_CANCELLED',
          orderData: { ...order, status: newStatus }
        });
      })();

      action = 'SO_CANCELLED_BACKFILLED';
    } else {
      // SO confirm/cancel are already up to date (or don't apply this call)
      // — check Zoho Inventory's packages/shipment data for a dispatch-side
      // checkpoint that was missed. Same idempotent backfill pattern as
      // above, mirroring the Package Created / Shipment Created webhook
      // branches in webhook.controller.js.
      const packages = Array.isArray(salesorder.packages) ? salesorder.packages : [];
      const latestPackage = packages[packages.length - 1];
      const shipmentInfo = latestPackage?.shipment_order;
      const trackingNumber = shipmentInfo?.tracking_number || latestPackage?.tracking_number || null;
      const courier = shipmentInfo?.carrier || latestPackage?.carrier || latestPackage?.delivery_method || null;

      if (trackingNumber && !alreadyLogged('ZOHO_DISPATCHED') && !['completed', 'cancelled'].includes(order.status)) {
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

          // Aug 31, 2026 (3): stop at tracking_shared — same fix as the live
          // webhook handler (webhook.controller.js). Dispatch is not the end
          // of the order; Finance still has to invoice it (see the
          // ZOHO_INVOICE_DRAFTED backfill branch below), so this no longer
          // auto-jumps all the way to completed.
          let cascadeStatus = order.status;
          if (['ready_for_dispatch', 'picking_packing'].includes(order.status)) {
            cascadeStatus = 'dispatched';
            db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(cascadeStatus, now, order.id);
          }
          logEvent({
            orderId: order.id, eventType: 'ZOHO_DISPATCHED', oldStatus: order.status, newStatus: cascadeStatus,
            actorId: req.user?.id || null, actorName: `${req.user?.name || 'User'} (manual Zoho sync)`,
            notes: `Shipment found in Zoho — Tracking: ${trackingNumber} (${courier || 'courier TBD'}) — backfilled by manual sync`,
            metadata: { trackingNumber, courier, source: 'manual_reconcile' }
          });

          const dispatchedStatus = cascadeStatus;
          cascadeStatus = 'tracking_shared';
          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(cascadeStatus, now, order.id);
          logEvent({ orderId: order.id, eventType: 'TRACKING_ENTERED', oldStatus: dispatchedStatus, newStatus: cascadeStatus, actorId: req.user?.id || null, actorName: `${req.user?.name || 'User'} (manual Zoho sync)`, notes: `${courier || 'Courier'}: ${trackingNumber}` });

          newStatus = cascadeStatus;

          notify({
            orderId: order.id,
            recipientIds: [order.medrep_user_id],
            message: `Order ${order.getmeds_order_id} shipped via Zoho. Courier: ${courier || 'TBD'}, Tracking: ${trackingNumber}.`,
            eventType: 'ORDER_DISPATCHED',
            orderData: { ...order, status: newStatus, tracking_number: trackingNumber, courier }
          });
        })();

        action = 'DISPATCHED_BACKFILLED';
      } else if (packages.length > 0 && !alreadyLogged('ZOHO_PACKAGE_CREATED') && order.status === 'ready_for_dispatch') {
        newStatus = 'picking_packing';
        db.transaction(() => {
          const existingDispatch = db.prepare('SELECT id FROM dispatch_records WHERE order_id = ?').get(order.id);
          if (existingDispatch) {
            db.prepare(`UPDATE dispatch_records SET status = 'packing' WHERE order_id = ?`).run(order.id);
          } else {
            db.prepare(`INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'packing', ?)`).run(order.id, now);
          }

          db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, order.id);
          logEvent({
            orderId: order.id, eventType: 'ZOHO_PACKAGE_CREATED', oldStatus: order.status, newStatus,
            actorId: req.user?.id || null, actorName: `${req.user?.name || 'User'} (manual Zoho sync)`,
            notes: `Package ${latestPackage.package_number || latestPackage.package_id || ''} found in Zoho — backfilled by manual sync`,
            metadata: { source: 'manual_reconcile' }
          });
          notify({
            orderId: order.id,
            recipientIds: [order.medrep_user_id],
            message: `Order ${order.getmeds_order_id} is being picked & packed (Package found in Zoho).`,
            eventType: 'DISPATCH_STATUS_UPDATE',
            orderData: { ...order, status: newStatus }
          });
        })();

        action = 'PACKAGE_BACKFILLED';
      } else if (Array.isArray(salesorder.invoices) && salesorder.invoices.length && !alreadyLogged('ZOHO_INVOICE_DRAFTED') && order.status !== 'cancelled') {
        // Aug 31, 2026 (3): Invoice backfill — this endpoint previously had
        // no way to catch up a missed "invoice.created" webhook at all (only
        // SO confirm/cancel and dispatch/package had a fallback here). Reads
        // straight from the Sales Order's own `invoices` array (confirmed
        // live via ZohoInventory_get_sales_order — Zoho nests an array of
        // {invoice_id, invoice_number, ...} there once one exists), same
        // pattern as the packages/shipment reads just above. Deliberately NOT
        // excluded for order.status === 'completed' (only 'cancelled') —
        // unlike the dispatch backfill above, an order can legitimately reach
        // this branch already sitting at 'completed' from before the
        // premature-auto-complete bug was fixed, and it should still be
        // possible to backfill the real invoice record onto it.
        const latestInvoice = salesorder.invoices[salesorder.invoices.length - 1];
        const zohoInvoiceId = latestInvoice.invoice_id;
        const zohoInvoiceNumber = latestInvoice.invoice_number;

        newStatus = order.status;
        if (['so_created', 'waiting_for_payment', 'tracking_shared'].includes(order.status)) {
          newStatus = 'invoice_drafted';
        }

        db.transaction(() => {
          db.prepare(`
            UPDATE orders
            SET status = ?, zoho_invoice_id = COALESCE(?, zoho_invoice_id), zoho_invoice_number = COALESCE(?, zoho_invoice_number),
                updated_at = ?
            WHERE id = ?
          `).run(newStatus, zohoInvoiceId || null, zohoInvoiceNumber || null, now, order.id);

          logEvent({
            orderId: order.id,
            eventType: 'ZOHO_INVOICE_DRAFTED',
            oldStatus: order.status,
            newStatus,
            actorId: req.user?.id || null,
            actorName: `${req.user?.name || 'User'} (manual Zoho sync)`,
            notes: `Invoice found in Zoho (${zohoInvoiceNumber || zohoInvoiceId}) — backfilled by manual sync; the live webhook did not reach this app when it actually happened`,
            metadata: { zohoInvoiceId, zohoInvoiceNumber, source: 'manual_reconcile' }
          });

          const financeIds = getUserIdsByRole('finance');
          notify({
            orderId: order.id,
            recipientIds: Array.from(new Set([order.medrep_user_id, ...financeIds].filter(Boolean))),
            message: `Zoho Invoice ${zohoInvoiceNumber || ''} drafted for ${order.getmeds_order_id}.`,
            eventType: 'INVOICE_DRAFTED',
            orderData: { ...order, status: newStatus }
          });
        })();

        action = 'INVOICE_BACKFILLED';
      }
    }

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC').all(order.id);

    res.json({
      success: true,
      data: {
        action,
        zoho_status: soStatus,
        order: updatedOrder,
        events
      }
    });
  } catch (err) { next(err); }
};

// Manual, on-demand PUSH of a failed Zoho Sales Order sync — the opposite
// direction from syncFromZoho above (which pulls). Added Aug 30, 2026 when
// the automatic 30s background retry loop (zohoRetryService.start(), see
// server.js) was switched off by default: a failed sync used to keep
// retrying itself forever, filling the audit timeline with repeats while a
// real problem was being diagnosed. This is the replacement — a single
// explicit retry per click, with no backoff window to wait out (unlike the
// background loop, it ignores zoho_sync_queue.next_attempt_at and
// zoho_sync_queue.status entirely, so it works even on a row already
// marked 'failed_permanent' after exhausting its automatic attempts).
exports.retryZohoSync = async (req, res, next) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name, u.email as medrep_email, u.id as medrep_user_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    if (order.zoho_sync_status !== 'failed') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOTHING_TO_RETRY',
          message: `This order's Zoho sync status is '${order.zoho_sync_status}', not 'failed' — there is nothing queued to retry.`
        }
      });
    }

    // Most recent queue row for this order, regardless of its own status —
    // deliberately not filtered to status='pending' so a row that already
    // hit 'failed_permanent' (5 automatic attempts exhausted) can still be
    // retried manually here.
    const row = db.prepare(`
      SELECT * FROM zoho_sync_queue WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(order.id);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_QUEUED', message: 'No Zoho sync record was found queued for this order.' }
      });
    }

    const result = await zohoRetryService.processOne(row);
    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

    res.json({ success: true, data: { order: updatedOrder, result } });
  } catch (err) { next(err); }
};

exports.getEvents = (req, res, next) => {
  try {
    const events = db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC'
    ).all(req.params.id);
    res.json({ success: true, data: { events } });
  } catch (err) { next(err); }
};

// ─── CREATE (DRAFT) ───────────────────────────────────────────────────────────

exports.create = async (req, res, next) => {
  try {
    const {
      customer_id, items, delivery_address, delivery_notes, customer_type, status: requestedStatus,
      // Aug 27, 2026: optional order-intake fields matching the MedRep's
      // paper/spreadsheet order form (see schema.sql's `orders` table
      // comment). Purely informational — never required, and never part of
      // the Zoho payload built below (zohoPayload only ever carries
      // customer/items/address/total). courier/hospital_name/patient_name/
      // mode_of_payment/pls_give_note are kept accepted here for backward
      // compatibility (tests/orderIntakeFields.test.js, and any older
      // client) even though the Aug 30, 2026 order form redesign no longer
      // collects them.
      courier, doctor_name, hospital_name, patient_name, mode_of_payment,
      receiver_name, receiver_contact_no, order_source, pls_give_note,
      // Aug 30, 2026: "Create New Order" form redesign — see schema.sql's
      // `orders`/`order_items` comments and ZOHO_SALES_ORDER_FIELD_MAPPING.md.
      // All optional server-side (so older clients / the tests above keep
      // working unchanged) even though the new form marks Source and
      // Invoicing From as required — that's a client-side UX guarantee, not
      // a data-integrity one this endpoint should enforce by rejecting
      // requests from anything else that talks to this API.
      delivery_method, terms, invoicing_from,
      // Aug 30, 2026 (2): Payment Terms — mirrors the same-named field on
      // Zoho's own Sales Order screen (Net 15 / 30 days / 45 Day /
      // BPO WALLET / 60 Day / DSWD/PCSO, or a custom typed value). Same
      // "optional, free text, not wired into the Zoho payload yet" pattern
      // as delivery_method/terms above.
      payment_terms
    } = req.body;
    const clean = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    const effectiveActor = resolveActor(req.user, 'medrep');

    const ALLOWED_INVOICING_FROM = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

    // Validation
    if (!customer_id) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'customer_id is required' } });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'At least one order item is required' } });
    if (!delivery_address) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'delivery_address is required' } });
    if (invoicing_from != null && clean(invoicing_from) && !ALLOWED_INVOICING_FROM.includes(clean(invoicing_from))) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `invoicing_from must be one of: ${ALLOWED_INVOICING_FROM.join(', ')}`
        }
      });
    }

    // Verify customer exists
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_active = 1').get(customer_id);
    if (!customer) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });

    const gateError = checkTestCustomerGate(customer);
    if (gateError) return res.status(403).json({ success: false, error: gateError });

    const resolvedCustomerType = customer.type || customer_type || 'direct';

    // Calculate totals and validate products
    let total_amount = 0;
    const resolvedItems = [];
    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Each item needs product_id and quantity > 0' } });
      }
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(item.product_id);
      if (!product) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Product ${item.product_id} not found` } });

      // Aug 30, 2026: Rate is now an editable line-item field on the order
      // form (matching a Zoho Sales Order line item, which always allows
      // overriding the catalog rate) — falls back to the product's catalog
      // price when not sent, so every existing caller that never sent a
      // rate (older frontend, the tests above) behaves exactly as before.
      const rate = (item.rate !== undefined && item.rate !== null && item.rate !== '')
        ? Math.max(0, Number(item.rate))
        : product.unit_price;
      const subtotal = rate * item.quantity;

      // Per-line Discount (flat currency amount) and Tax (simple flat-rate
      // preset, e.g. "VAT 12%") — both default to zero/none, so an item
      // that doesn't send them produces line_total === subtotal, unchanged
      // from before this field existed.
      const discountAmount = Math.min(subtotal, Math.max(0, Number(item.discount) || 0));
      const taxPercent = Math.max(0, Number(item.tax_percent) || 0);
      const taxableBase = subtotal - discountAmount;
      const taxAmount = taxableBase * (taxPercent / 100);
      const lineTotal = taxableBase + taxAmount;

      total_amount += lineTotal;
      resolvedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: rate,
        subtotal,
        discount_amount: discountAmount,
        tax_percent: taxPercent,
        tax_label: clean(item.tax_label),
        line_total: lineTotal,
        sku: product.sku,
        name: product.name,
        zoho_item_id: product.zoho_item_id,
        unit: product.unit
      });
    }

    // 1. Generate unique Getmeds Order ID (GM-YYYYMMDD-XXXX)
    const getmedsOrderId = generateOrderId();
    const isDraft = requestedStatus === 'draft';
    const isCredit = resolvedCustomerType === 'credit';
    const finalStatus = isDraft ? 'draft' : (isCredit ? 'ready_for_dispatch' : 'waiting_for_payment');
    const now = new Date().toISOString();
    // "Sales Order Date (Automatic Today)" on the form — always set here,
    // server-side, to today's date. There is no client override; a
    // sales_order_date sent in the request body (there isn't one — the
    // frontend never sends it) would be ignored regardless.
    const salesOrderDate = now.slice(0, 10);

    // 2. Create Zoho SO *before* opening the DB transaction below.
    let zohoResult = null;
    let zohoSyncStatus = 'pending';
    let zohoError = null;
    const zohoPayload = {
      getmeds_order_id: getmedsOrderId,
      customer_name: customer.name,
      customer_type: resolvedCustomerType,
      customer_master_type: customer.type,
      zoho_customer_id: customer.zoho_contact_id || null,
      total_amount,
      delivery_address,
      items: resolvedItems,
      // Aug 30, 2026 (3): wired to Zoho's "Doctor Name" / "Source" custom
      // fields on the Sales Order (see LiveZohoAdapter.createSalesOrder —
      // confirmed live via ZohoInventory_get_sales_order that this org
      // already has both configured, with matching customfield_ids).
      doctor_name: clean(doctor_name),
      order_source: clean(order_source),
      // Aug 30, 2026 (4): wired to Zoho's "Invoicing From" custom field —
      // same discovery as Doctor Name/Source: this org already has
      // cf_invoicing_from configured (not a separate Zoho organization, as
      // ZOHO_SALES_ORDER_FIELD_MAPPING.md previously assumed before this
      // was checked live).
      invoicing_from: clean(invoicing_from)
    };
    // Aug 30, 2026: delivery_method, terms, and each line's discount/tax are
    // all captured and stored below (in the orders/order_items tables) but
    // are still NOT added to this payload — wiring each into an actual Zoho
    // call is a deliberately separate, later piece of work (Doctor
    // Name/Source/Invoicing From are the first fields off that list to
    // actually get wired — see above). See
    // ZOHO_SALES_ORDER_FIELD_MAPPING.md for exactly which Zoho Sales Order
    // field each remaining one is meant to land on.
    //
    // Only ever creates the Zoho Sales Order (as a plain Draft — nothing
    // here confirms it). Confirming, invoicing, and recording payment all
    // happen directly in Zoho by Finance now, never through this app.
    if (!isDraft) {
      if (isDryRunMode()) {
        // ZOHO_DRY_RUN=true — no HTTP call to Zoho is made at all.
        zohoResult = buildDryRunSalesOrder(zohoPayload);
        zohoSyncStatus = 'skipped';
      } else {
        try {
          zohoResult = await zoho.createSalesOrder(zohoPayload);
          zohoSyncStatus = 'synced';
        } catch (err) {
          zohoSyncStatus = 'failed';
          zohoError = err.message;
          console.error(`[ZOHO] createSalesOrder failed for ${getmedsOrderId} — order will still be created and queued for automatic retry:`, err.message);
        }
      }
    }

    const createOrderTxn = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO orders (
          getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
          delivery_address, delivery_notes,
          intake_courier, intake_doctor, intake_hospital, intake_patient, intake_mop,
          intake_receiver, intake_contact_no, intake_source, intake_pls_give,
          sales_order_date, intake_delivery_method, intake_terms, intake_payment_terms, invoicing_from,
          zoho_so_id, zoho_so_number, zoho_sync_status,
          created_at, submitted_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        getmedsOrderId,
        customer_id,
        effectiveActor.id,
        finalStatus,
        resolvedCustomerType,
        total_amount,
        delivery_address,
        delivery_notes || null,
        clean(courier),
        clean(doctor_name),
        clean(hospital_name),
        clean(patient_name),
        clean(mode_of_payment),
        clean(receiver_name),
        clean(receiver_contact_no),
        clean(order_source),
        clean(pls_give_note),
        salesOrderDate,
        clean(delivery_method),
        clean(terms),
        clean(payment_terms),
        clean(invoicing_from),
        zohoResult ? zohoResult.salesorder.salesorder_id : null,
        zohoResult ? zohoResult.salesorder.salesorder_number : null,
        zohoSyncStatus,
        now,
        isDraft ? null : now,
        now
      );

      const orderId = result.lastInsertRowid;

      // Insert line items
      const insItem = db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, quantity, unit_price, subtotal,
          discount_amount, tax_percent, tax_label, line_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ri of resolvedItems) {
        insItem.run(
          orderId, ri.product_id, ri.quantity, ri.unit_price, ri.subtotal,
          ri.discount_amount, ri.tax_percent, ri.tax_label, ri.line_total
        );
      }

      // 2. Evaluate Workflow Gate & Create Child Records
      if (!isDraft) {
        if (isCredit) {
          db.prepare("INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'queued', datetime('now'))").run(orderId);
        } else {
          db.prepare("INSERT INTO payments (order_id, status, created_at) VALUES (?, 'pending', datetime('now'))").run(orderId);
        }

        // 3. Trigger Audit Trail (ORDER_SUBMITTED in the same transaction)
        logEvent({
          orderId,
          eventType: 'ORDER_SUBMITTED',
          oldStatus: 'draft',
          newStatus: finalStatus,
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          notes: `Order submitted for ${customer.name} (${isCredit ? 'Credit Fast-Track' : 'Direct Patient Payment Queue'})`
        });

        if (zohoSyncStatus === 'failed') {
          zohoRetryService.enqueue({ orderId, payload: zohoPayload, error: zohoError });
          logEvent({
            orderId,
            eventType: 'ZOHO_SYNC_FAILED',
            oldStatus: finalStatus,
            newStatus: finalStatus,
            actorName: 'System',
            notes: `Zoho sync failed, order proceeds normally and sync is queued for automatic retry: ${zohoError}`
          });
        }
      } else {
        logEvent({
          orderId,
          eventType: 'ORDER_CREATED',
          newStatus: 'draft',
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          notes: 'Draft order created'
        });
      }

      return { orderId, getmedsOrderId, finalStatus, isCredit, zohoResult };
    });

    const { orderId } = createOrderTxn();

    // Trigger Notifications outside transaction
    if (!isDraft) {
      const orderDataForNotif = {
        getmeds_order_id: getmedsOrderId,
        customer_name: customer.name,
        status: finalStatus,
        medrep_email: req.user.email
      };

      notify({
        orderId,
        recipientIds: [req.user.id],
        message: `Your order ${getmedsOrderId} for ${customer.name} has been submitted (${isCredit ? 'Ready for Dispatch' : 'Waiting for Finance Payment Verification'}).`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      if (!isCredit) {
        const financeIds = getUserIdsByRole('finance');
        notify({ orderId, recipientIds: financeIds, message: `New direct patient order ${getmedsOrderId} requires payment verification.`, eventType: 'PAYMENT_VERIFICATION_REQUIRED', orderData: orderDataForNotif });
      } else {
        const dispatchIds = getUserIdsByRole('dispatch');
        notify({ orderId, recipientIds: dispatchIds, message: `New credit order ${getmedsOrderId} is ready for dispatch.`, eventType: 'ORDER_READY_FOR_DISPATCH', orderData: orderDataForNotif });
      }
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    res.status(201).json({ success: true, data: { order } });
  } catch (err) { next(err); }
};

// ─── SUBMIT ───────────────────────────────────────────────────────────────────

exports.submit = async (req, res, next) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, c.type as customer_master_type, c.contact_number, c.zoho_contact_id as customer_zoho_contact_id, u.name as medrep_name, u.email as medrep_email
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your order' } });
    }
    if (order.status !== 'draft') {
      return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: `Order is already ${order.status}, cannot submit` } });
    }
    const gateError = checkTestCustomerGate({ name: order.customer_name, zoho_contact_id: order.customer_zoho_contact_id });
    if (gateError) return res.status(403).json({ success: false, error: gateError });

    const items = db.prepare(`
      SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id);

    // Step 1: submitted → validating → so_pending → so_created
    const getmedsOrderId = generateOrderId();
    const now = new Date().toISOString();

    // Step 2: Create Zoho SO. Done *before* opening the DB transaction
    // below for the same reason as in `create` above — better-sqlite3
    // transactions can't contain an `await`, and this call is async
    // (mock, http-mock, or live depending on ZOHO_MODE).
    //
    // Fail-safe, not fail-closed: a Zoho rejection here does not abort the
    // submission or leave the order stuck in `draft` — it still advances
    // through the state machine with zoho_sync_status='failed' and gets
    // queued for automatic background retry (see zohoRetryService).
    const zohoPayload = {
      getmeds_order_id: getmedsOrderId,
      customer_name: order.customer_name,
      customer_type: order.customer_type,
      customer_master_type: order.customer_master_type,
      zoho_customer_id: order.customer_zoho_contact_id || null,
      total_amount: order.total_amount,
      delivery_address: order.delivery_address,
      items,
      // Same wiring as `create` above — pulled from the draft row this
      // order was created from rather than req.body, since submit() acts
      // on an already-stored draft.
      doctor_name: order.intake_doctor,
      order_source: order.intake_source,
      invoicing_from: order.invoicing_from
    };
    let zohoResult = null;
    let zohoSyncStatus = 'pending';
    let zohoError = null;
    // Only ever creates the Zoho Sales Order (as a plain Draft — nothing
    // here confirms it). Confirming, invoicing, and recording payment all
    // happen directly in Zoho by Finance now, never through this app.
    if (isDryRunMode()) {
      // ZOHO_DRY_RUN=true — no HTTP call to Zoho is made at all.
      zohoResult = buildDryRunSalesOrder(zohoPayload);
      zohoSyncStatus = 'skipped';
    } else {
      try {
        zohoResult = await zoho.createSalesOrder(zohoPayload);
        zohoSyncStatus = 'synced';
      } catch (err) {
        zohoSyncStatus = 'failed';
        zohoError = err.message;
        console.error(`[ZOHO] createSalesOrder failed for ${getmedsOrderId} — order will still be submitted and queued for automatic retry:`, err.message);
      }
    }

    const submitTxn = db.transaction(() => {
      // Step 3: Determine next status based on customer type
      // credit → ready_for_dispatch (bypasses finance payment check)
      // direct → waiting_for_payment (routes to finance queue)
      const isCredit = (order.customer_type === 'credit' || order.customer_master_type === 'credit');
      const finalStatus = isCredit ? 'ready_for_dispatch' : 'waiting_for_payment';

      db.prepare(`
        UPDATE orders SET
          getmeds_order_id = ?, customer_type = ?, status = ?, submitted_at = ?, updated_at = ?,
          zoho_so_id = ?, zoho_so_number = ?, zoho_sync_status = ?
        WHERE id = ?
      `).run(getmedsOrderId, isCredit ? 'credit' : 'direct', finalStatus, now, now,
        zohoResult ? zohoResult.salesorder.salesorder_id : null,
        zohoResult ? zohoResult.salesorder.salesorder_number : null,
        zohoSyncStatus,
        order.id);

      if (zohoSyncStatus === 'failed') {
        zohoRetryService.enqueue({ orderId: order.id, payload: zohoPayload, error: zohoError });
      }

      // Step 4: If direct patient, create payment record for Finance queue
      if (!isCredit) {
        db.prepare(`
          INSERT INTO payments (order_id, status, created_at)
          VALUES (?, 'pending', datetime('now'))
        `).run(order.id);
      }

      // Step 5: If credit customer, create dispatch record immediately
      if (isCredit) {
        db.prepare(`
          INSERT INTO dispatch_records (order_id, status, created_at)
          VALUES (?, 'queued', datetime('now'))
        `).run(order.id);
      }

      // Audit trail — log all status hops
      const statusPath = isCredit
        ? ['submitted', 'validating', 'so_pending', 'so_created', 'ready_for_dispatch']
        : ['submitted', 'validating', 'so_pending', 'so_created', 'waiting_for_payment'];

      const effectiveActor = resolveActor(req.user, 'medrep');

      let prev = 'draft';
      for (const s of statusPath) {
        logEvent({ orderId: order.id, eventType: 'STATUS_CHANGE', oldStatus: prev, newStatus: s, actorId: effectiveActor.id, actorName: effectiveActor.name,
          notes: s === 'so_created'
            ? (zohoResult ? `Zoho SO created: ${zohoResult.salesorder.salesorder_number}` : `Zoho sync failed, queued for automatic retry: ${zohoError}`)
            : undefined });
        prev = s;
      }

      // Step 6: Notify
      const orderDataForNotif = { getmeds_order_id: getmedsOrderId, customer_name: order.customer_name, status: finalStatus, medrep_email: order.medrep_email };

      // 6a. Notify submitting MedRep
      notify({
        orderId: order.id,
        recipientIds: [effectiveActor.id],
        message: `Your order ${getmedsOrderId} for ${order.customer_name} has been submitted (${order.customer_type === 'credit' ? 'Ready for Dispatch' : 'Waiting for Finance Payment Verification'}).`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      // 6b. Route notification based on customer type
      if (order.customer_type === 'direct') {
        const financeIds = getUserIdsByRole('finance');
        notify({ orderId: order.id, recipientIds: financeIds, message: `New direct patient order ${getmedsOrderId} requires payment verification.`, eventType: 'PAYMENT_VERIFICATION_REQUIRED', orderData: orderDataForNotif });
      } else {
        const dispatchIds = getUserIdsByRole('dispatch');
        notify({ orderId: order.id, recipientIds: dispatchIds, message: `New credit order ${getmedsOrderId} is ready for dispatch.`, eventType: 'ORDER_READY_FOR_DISPATCH', orderData: orderDataForNotif });
      }

      return { getmedsOrderId, finalStatus, zohoResult, zohoSyncStatus };
    });

    const result = submitTxn();
    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    res.json({
      success: true,
      data: {
        order: updatedOrder,
        zoho: result.zohoResult ? result.zohoResult.salesorder : null,
        zoho_sync_status: result.zohoSyncStatus
      }
    });
  } catch (err) { next(err); }
};

// ─── EXCEPTION / ON HOLD ──────────────────────────────────────────────────────

exports.setException = (req, res, next) => {
  try {
    const { reason, status } = req.body;
    const targetStatus = status === 'on_hold' ? 'on_hold' : 'exception';
    const effectiveActor = resolveActor(req.user, 'management');

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (!stateMachine.canTransition(order.status, targetStatus)) {
      return res.status(409).json({ success: false, error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${order.status} to ${targetStatus}` } });
    }

    const txn = db.transaction(() => {
      db.prepare('UPDATE orders SET status = ?, exception_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(targetStatus, reason || null, order.id);

      logEvent({ orderId: order.id, eventType: 'EXCEPTION_SET', oldStatus: order.status, newStatus: targetStatus, actorId: effectiveActor.id, actorName: effectiveActor.name, notes: reason });
    });
    txn();

    const medrepIds = [order.medrep_id];
    const mgmtIds = getUserIdsByRole('management');
    notify({ orderId: order.id, recipientIds: [...medrepIds, ...mgmtIds], message: `Order ${order.getmeds_order_id} is now ${targetStatus}. Reason: ${reason || 'None provided'}`, eventType: 'ORDER_EXCEPTION', orderData: order });

    res.json({ success: true, data: { status: targetStatus } });
  } catch (err) { next(err); }
};
