const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { logEvent } = require('./auditService');
const { notify, getUserIdsByRole } = require('./notificationService');
const { setOrderStatus, advanceTo } = require('./orderStatusService');
const { evaluateCompletion } = require('./orderCompletionService');

/**
 * Pull an order's current truth out of Zoho and backfill anything this app
 * missed — Sales Order confirmed/cancelled/deleted, invoice drafted/sent/paid,
 * package created, shipment with tracking — then apply the shipped-AND-paid
 * completion rule.
 *
 * Sep 1, 2026 (3): lifted out of orders.controller.js's syncFromZoho, which
 * was the only place this logic lived and could only be reached by a human
 * clicking "Sync from Zoho". That made the audit trail depend on somebody
 * remembering to press a button — every event on TestGM-20260901-0002 reads
 * "backfilled by manual sync" for exactly that reason. Three callers now
 * share this one implementation:
 *
 *   - POST /api/orders/:id/sync-from-zoho   (the button, unchanged)
 *   - GET  /api/orders/:id                  (refresh on open, throttled)
 *   - services/zohoAutoSyncService.js       (background poller)
 *
 * Contract: NEVER throws and never touches req/res. Returns
 * `{ ok, action, zohoStatus, order, events }` on success or
 * `{ ok: false, code, message }` on failure, so a caller can decide whether
 * that matters. A poller iterating twenty orders must not stop because one of
 * them 404s, and opening an order page must not 500 because Zoho is down.
 *
 * `source` is stamped into each audit entry's metadata ('manual_reconcile',
 * 'page_open', 'auto_sync') so the trail says how a backfill was triggered.
 */
async function reconcileOrder({ orderId, actorId = null, actorName = 'Auto Sync', source = 'auto_sync' }) {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name, u.email as medrep_email, u.id as medrep_user_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(orderId);

    if (!order) return { ok: false, code: 'NOT_FOUND', message: 'Order not found' };
    if (!order.zoho_so_id) {
      return { ok: false, code: 'NO_ZOHO_SO', message: 'This order does not have a Zoho Sales Order yet.' };
    }

    const alreadyLogged = (eventType) =>
      !!db.prepare('SELECT id FROM order_events WHERE order_id = ? AND event_type = ?').get(order.id, eventType);

    let salesorder;
    try {
      const result = await zoho.getSalesOrder(order.zoho_so_id);
      salesorder = result?.salesorder;
    } catch (zohoErr) {
      // Aug 31, 2026: a Sales Order deleted directly in Zoho (not
      // voided/cancelled — actually removed) makes this GET fail with a
      // "does not exist" error, rather than returning a record whose status
      // is void/cancelled. That used to just surface as a raw
      // ZOHO_FETCH_FAILED error with nothing written to the audit trail —
      // exactly the gap hit here: the order was deleted in Zoho first, then
      // "Sync from Zoho" was clicked, and got only an error toast. Handle it
      // the same way the live webhook's delete branch does (see
      // webhook.controller.js's isSalesOrderDeleted) — a distinct
      // ZOHO_SO_DELETED trail entry, not a dead-end error.
      const zohoCode = zohoErr?.zohoResponse?.code;
      const msg = (zohoErr?.message || '').toLowerCase();
      const isNotFound = zohoErr?.httpStatus === 404 || zohoCode === 5 || msg.includes('does not exist');

      if (!isNotFound) {
        return { ok: false, code: 'ZOHO_FETCH_FAILED', message: `Could not reach Zoho: ${zohoErr.message}` };
      }

      const deletedNow = new Date().toISOString();
      let deletedAction = 'NOTHING_NEW';
      let deletedNewStatus = order.status;

      // Aug 31, 2026 (2): log this regardless of the order's current status
      // — including 'completed'. The first version of this fix only logged
      // when the order wasn't already completed/cancelled, mirroring the
      // ordinary void/cancel backfill above — but that meant a Sales Order
      // deleted in Zoho AFTER an order had already reached "completed" here
      // (e.g. SO-66824, deleted well after it shipped and was invoiced)
      // produced nothing at all: "Already up to date with Zoho." Deleting
      // the Zoho record is worth recording on its own regardless of where
      // the order already sits. Only the STATUS change stays conservative —
      // a later Zoho deletion doesn't retroactively un-complete a real order
      // that already shipped and got paid.
      // Sep 1, 2026 (3): the guard used to be a plain
      // `!alreadyLogged('ZOHO_SO_DELETED')`, which turned out to be a one-shot
      // trap. If the first attempt logged the deletion but the STATUS write
      // didn't take (see the refusal case below — it happened for real on
      // TestGM-20260901-0002, where the old build tried tracking_shared ->
      // cancelled and the state machine refused it), the event now existed,
      // so every later "Sync from Zoho" skipped the whole branch and the order
      // was stuck at its old status permanently with no way to correct it
      // from the UI. Re-run whenever the order's status doesn't yet reflect
      // the deletion; once it does, this goes quiet again.
      const deletionLogged = alreadyLogged('ZOHO_SO_DELETED');
      const statusReflectsDeletion = ['deleted', 'completed', 'cancelled'].includes(order.status);
      if (!deletionLogged || !statusReflectsDeletion) {
        // Sep 1, 2026 (2): 'deleted' rather than 'cancelled' — mirrors the
        // live webhook branch. A removed Sales Order and a voided one are
        // different things and now read differently on the order.
        const canChangeStatus = !['completed', 'cancelled', 'deleted'].includes(order.status);
        if (canChangeStatus) deletedNewStatus = 'deleted';
        let refused = false;

        db.transaction(() => {
          if (canChangeStatus) {
            const moved = setOrderStatus(order.id, order.status, deletedNewStatus, deletedNow);
            if (!moved.changed) {
              deletedNewStatus = moved.status;
              refused = moved.refused;
            }
          }

          // Sep 1, 2026 (3): a refused status write says so, out loud, in the
          // trail. Before this it left an entry reading "Sales Order no longer
          // exists in Zoho — backfilled by manual sync" against an unchanged
          // status (X -> X), with the actual reason only in a console warning
          // nobody was watching. That is indistinguishable from a deliberate
          // no-op and is exactly how the stuck order above went unexplained.
          const notes = refused
            ? `Sales Order no longer exists in Zoho (deleted), but the order could NOT be moved from "${order.status}" to "deleted" — the workflow does not allow that transition (see workflow/stateMachine.js). The status has been left unchanged and needs a look.`
            : canChangeStatus
              ? 'Sales Order no longer exists in Zoho (deleted) — backfilled by manual sync.'
              : `Sales Order no longer exists in Zoho (deleted) — backfilled by manual sync. Order status kept as "${order.status}" since it was already there; this just records that the Zoho Sales Order itself is gone.`;

          logEvent({
            orderId: order.id,
            eventType: 'ZOHO_SO_DELETED',
            oldStatus: order.status,
            newStatus: deletedNewStatus,
            actorId,
            actorName,
            notes,
            metadata: { source, refused }
          });

          const adminIds = getUserIdsByRole('admin', 'management');
          notify({
            orderId: order.id,
            recipientIds: Array.from(new Set([order.medrep_user_id, ...adminIds].filter(Boolean))),
            message: refused
              ? `Order ${order.getmeds_order_id} was deleted in Zoho, but its status could not be updated automatically — please check it.`
              : `Order ${order.getmeds_order_id} was deleted in Zoho.`,
            eventType: 'ORDER_DELETED_IN_ZOHO',
            orderData: { ...order, status: deletedNewStatus }
          });
        })();
        deletedAction = refused ? 'SO_DELETED_NOT_APPLIED' : 'SO_DELETED_BACKFILLED';
      }

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      const events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC').all(order.id);
      return { ok: true, action: deletedAction, zohoStatus: 'deleted', order: updatedOrder, events };
    }
    if (!salesorder) {
      return { ok: false, code: 'ZOHO_FETCH_FAILED', message: 'Zoho returned no Sales Order data' };
    }

    const soStatus = typeof salesorder.status === 'string' ? salesorder.status.toLowerCase() : null;

    // Sep 1, 2026 (6): every Zoho status PAST draft counts as confirmed, not
    // just the literal 'confirmed'/'open'.
    //
    // Found while importing real Sales Orders: SO-66890 came back as
    // 'shipped'. It never matched isConfirmed, so the order never left
    // 'so_created' — and every downstream guard (package, shipment) excludes
    // so_created, so the shipment branch logged "DISPATCHED" into the trail
    // while the status sat at so_created. An order reading as barely started
    // and shipped at the same time.
    //
    // A Sales Order can only reach shipped/fulfilled/closed/invoiced by having
    // been confirmed first, so treating those as confirmed is not a guess —
    // it is the only way they could exist. The confirm branch then runs first
    // and the rest of the chain has a valid status to work from.
    const CONFIRMED_OR_BEYOND = [
      'confirmed', 'open', 'partially_shipped', 'shipped',
      'fulfilled', 'partially_fulfilled', 'closed', 'invoiced', 'partially_invoiced'
    ];
    const isConfirmed = CONFIRMED_OR_BEYOND.includes(soStatus);
    const isCancelled = soStatus === 'void' || soStatus === 'cancelled' || soStatus === 'voided';

    const now = new Date().toISOString();
    let action = 'NOTHING_NEW';
    let newStatus = order.status;

    if (isConfirmed && !alreadyLogged('ZOHO_SO_CONFIRMED')) {
      const zohoSoNumber = salesorder.salesorder_number || order.zoho_so_number;

      db.transaction(() => {
        // Sep 1, 2026: 'so_created' added, mirroring the live webhook — a
        // credit order now waits there until Zoho confirms, so this is the
        // hop that releases it when the webhook was missed.
        if (['submitted', 'validating', 'so_pending', 'so_created'].includes(order.status)) {
          // Sep 1, 2026 (8): confirming the Sales Order now hands the order
          // to Finance for account verification, not straight to invoicing.
          const target = 'ready_for_finance_verified';
          const moved = advanceTo(order.id, order.status, target, now);
          if (moved.changed) newStatus = moved.status;
        }

        db.prepare(`
          UPDATE orders SET zoho_so_number = COALESCE(?, zoho_so_number), zoho_so_status = ?, zoho_sync_status = 'synced', updated_at = ?
          WHERE id = ?
        `).run(zohoSoNumber || null, soStatus || 'confirmed', now, order.id);

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_CONFIRMED',
          oldStatus: order.status,
          newStatus,
          actorId,
          actorName,
          notes: `Sales Order confirmed in Zoho (${zohoSoNumber || order.zoho_so_id}) — backfilled by manual sync; the live webhook did not reach this app when it actually happened`,
          metadata: { zohoSoId: order.zoho_so_id, zohoSoNumber, source }
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
    } else if (isCancelled && !alreadyLogged('ZOHO_SO_CANCELLED') && !['completed', 'cancelled', 'deleted'].includes(order.status)) {
      newStatus = 'cancelled';

      db.transaction(() => {
        const moved = setOrderStatus(order.id, order.status, newStatus, now);
        if (!moved.changed) newStatus = moved.status;

        logEvent({
          orderId: order.id,
          eventType: 'ZOHO_SO_CANCELLED',
          oldStatus: order.status,
          newStatus,
          actorId,
          actorName,
          notes: 'Sales Order cancelled or voided in Zoho — backfilled by manual sync',
          metadata: { source }
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

      // Sep 1, 2026 (6): the invoice facts are worked out BEFORE the chain,
      // so its guard can ask "is there anything new to record" rather than
      // just "does Zoho have an invoice". With the old guard, an order whose
      // invoice was already known still MATCHED this branch, did nothing
      // inside it, and — because the chain is else-if — stopped the package
      // and shipment branches from ever being reached. A replayed order got
      // its invoice and then silently refused to go any further.
      const zohoInvoices = Array.isArray(salesorder.invoices) ? salesorder.invoices : [];
      const latestInvoice = zohoInvoices.length ? zohoInvoices[zohoInvoices.length - 1] : null;
      const zohoInvoiceId = latestInvoice?.invoice_id || null;
      const zohoInvoiceNumber = latestInvoice?.invoice_number || null;
      const invoiceStatus = latestInvoice?.status ? String(latestInvoice.status).trim().toLowerCase() : null;
      const invoiceIsPaid = ['paid', 'closed'].includes(invoiceStatus);
      const invoiceIsSent = ['sent', 'overdue', 'partially_paid'].includes(invoiceStatus);
      const invoiceAlreadyKnown =
        order.zoho_invoice_id === zohoInvoiceId &&
        (invoiceIsPaid ? alreadyLogged('ZOHO_PAYMENT_VERIFIED') : true) &&
        (invoiceIsSent ? alreadyLogged('ZOHO_INVOICE_SENT') : true);
      const invoiceNeedsBackfill =
        Boolean(latestInvoice) &&
        !invoiceAlreadyKnown &&
        !['cancelled', 'completed'].includes(order.status);

      // Sep 1, 2026 (6): CHRONOLOGICAL order — invoice, then package, then
      // shipment. It used to run newest-first (shipment, package, invoice),
      // which is correct for a single webhook where the most advanced signal
      // should win, and quietly wrong here.
      //
      // This branch backfills ONE checkpoint per pass, so replaying an order
      // that is already several stages along in Zoho means several passes —
      // and newest-first made those passes walk the pipeline BACKWARDS. An
      // order that was invoiced, packed and shipped came out as
      // confirmed → dispatched → invoiced → packed, each step applying its own
      // status transition, leaving a shipped order sitting at
      // 'picking_packing'. Only visible once orders started being adopted from
      // Zoho rather than raised here, because app-created orders always
      // received their events in order anyway.
      if (invoiceNeedsBackfill) {
        // Aug 31, 2026 (3): Invoice backfill — this endpoint previously had
        // no way to catch up a missed "invoice.created" webhook at all (only
        // SO confirm/cancel and dispatch/package had a fallback here). Reads
        // straight from the Sales Order's own `invoices` array (confirmed
        // live via ZohoInventory_get_sales_order — Zoho nests an array of
        // {invoice_id, invoice_number, status, ...} there once one exists),
        // same pattern as the packages/shipment reads just above.
        //
        // Sep 1, 2026: rewritten. It now reads the invoice's OWN status and
        // backfills whichever of the three finance checkpoints Zoho is
        // actually at — drafted, sent, or paid — rather than only ever
        // recording "drafted". Until the Books Workflow Rules for
        // invoice.sent / invoice.paid / payment.created are built and
        // verified, this button is the only way those last two reach the
        // app at all, which makes it the practical catch-up path for the
        // whole back half of the flow.
        //
        // The old "self-correction" job (walking a 'completed' order back to
        // invoice_drafted) is gone with the bug it existed to clean up:
        // 'completed' is now written in exactly one place, only when the
        // order is genuinely shipped AND paid, so a completed order here is
        // a real one and must not be reopened.
        {
          // Which checkpoint does Zoho's invoice status put us at? A paid
          // invoice implies it was sent, and a sent one implies it was
          // drafted, so this reads as "the furthest point we can prove".
          const target = invoiceIsPaid || invoiceIsSent ? 'ready_for_dispatch' : 'ready_for_invoice_sent';
          const preInvoice = ['so_created', 'ready_for_finance_verified', 'ready_for_draft_invoice', 'tracking_shared', 'ready_for_invoice_sent'];
          const eventType = invoiceIsSent || invoiceIsPaid ? 'ZOHO_INVOICE_SENT' : 'ZOHO_INVOICE_DRAFTED';

          db.transaction(() => {
            if (preInvoice.includes(order.status)) {
              const moved = advanceTo(order.id, order.status, target, now);
              if (moved.changed) newStatus = moved.status;
            }

            db.prepare(`
              UPDATE orders
              SET zoho_invoice_id = COALESCE(?, zoho_invoice_id), zoho_invoice_number = COALESCE(?, zoho_invoice_number),
                  updated_at = ?
              WHERE id = ?
            `).run(zohoInvoiceId || null, zohoInvoiceNumber || null, now, order.id);

            logEvent({
              orderId: order.id,
              eventType,
              oldStatus: order.status,
              newStatus,
              actorId,
              actorName,
              // Sep 1, 2026 (8): if the order was still awaiting finance
              // verification when the invoice appeared, say so rather than
              // letting the stage be skipped silently. Raising the invoice in
              // Zoho IS the approval in practice — but the trail should record
              // that nobody pressed Verify, so an auditor can tell the two
              // apart later.
              notes: `Invoice ${zohoInvoiceNumber || zohoInvoiceId} found in Zoho, status "${invoiceStatus || 'draft'}" — backfilled by manual sync; the live webhook did not reach this app when it actually happened.${
                order.status === 'ready_for_finance_verified'
                  ? ' Note: this order had not been marked Finance Verified in this app — raising the invoice in Zoho is treated as the approval.'
                  : ''
              }`,
              metadata: { zohoInvoiceId, zohoInvoiceNumber, invoiceStatus, source }
            });

            // Zoho says this invoice is paid but no payment has reached us —
            // record it, then let the shared rule decide whether that was
            // the last of the two things the order was waiting on.
            if (invoiceIsPaid) {
              const paidAmount = latestInvoice.total ?? order.total_amount;
              const paidRef = zohoInvoiceNumber || zohoInvoiceId || 'ZOHO-INVOICE-PAID';
              const existingPayment = db.prepare('SELECT id FROM payments WHERE order_id = ?').get(order.id);
              if (existingPayment) {
                db.prepare(`
                  UPDATE payments SET status = 'verified', payment_reference = COALESCE(payment_reference, ?),
                    amount = COALESCE(amount, ?), payment_date = COALESCE(payment_date, ?),
                    notes = 'Verified from Zoho invoice status by manual sync', verified_at = COALESCE(verified_at, ?)
                  WHERE order_id = ?
                `).run(paidRef, paidAmount, now.split('T')[0], now, order.id);
              } else {
                db.prepare(`
                  INSERT INTO payments (order_id, status, payment_reference, amount, payment_date, notes, verified_at, created_at)
                  VALUES (?, 'verified', ?, ?, ?, 'Verified from Zoho invoice status by manual sync', ?, ?)
                `).run(order.id, paidRef, paidAmount, now.split('T')[0], now, now);
              }

              logEvent({
                orderId: order.id,
                eventType: 'ZOHO_PAYMENT_VERIFIED',
                oldStatus: newStatus,
                newStatus,
                actorId,
                actorName,
                notes: `Zoho reports invoice ${paidRef} as "${invoiceStatus}" — payment recorded by manual sync`,
                metadata: { invoiceStatus, source }
              });

              const completion = evaluateCompletion({
                orderId: order.id,
                currentStatus: newStatus,
                actorId,
                actorName,
                trigger: 'payment'
              });
              if (completion.completed) newStatus = 'completed';
            }

            const financeIds = getUserIdsByRole('finance');
            notify({
              orderId: order.id,
              recipientIds: Array.from(new Set([order.medrep_user_id, ...financeIds].filter(Boolean))),
              message: invoiceIsPaid
                ? `Zoho Invoice ${zohoInvoiceNumber || ''} for ${order.getmeds_order_id} is paid.`
                : invoiceIsSent
                  ? `Zoho Invoice ${zohoInvoiceNumber || ''} for ${order.getmeds_order_id} has been sent to the customer.`
                  : `Zoho Invoice ${zohoInvoiceNumber || ''} drafted for ${order.getmeds_order_id}.`,
              eventType: invoiceIsSent || invoiceIsPaid ? 'INVOICE_SENT' : 'INVOICE_DRAFTED',
              orderData: { ...order, status: newStatus }
            });
          })();

          action = invoiceIsPaid ? 'INVOICE_PAID_BACKFILLED' : 'INVOICE_BACKFILLED';
        }
      } else if (packages.length > 0 && !alreadyLogged('ZOHO_PACKAGE_CREATED') && ['ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch'].includes(order.status)) {
        // Aug 31, 2026 (5): 'ready_for_invoice_sent' added here too — same
        // reasoning as the dispatch backfill just above.
        // Sep 1, 2026: and 'ready_for_dispatch' with it, now that Mark-as-Sent is
        // a real status an invoice-first order actually sits at when packing
        // starts.
        newStatus = 'picking_packing';
        db.transaction(() => {
          const existingDispatch = db.prepare('SELECT id FROM dispatch_records WHERE order_id = ?').get(order.id);
          if (existingDispatch) {
            db.prepare(`UPDATE dispatch_records SET status = 'packing' WHERE order_id = ?`).run(order.id);
          } else {
            db.prepare(`INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'packing', ?)`).run(order.id, now);
          }

          const moved = advanceTo(order.id, order.status, newStatus, now);
          if (!moved.changed) newStatus = moved.status;
          logEvent({
            orderId: order.id, eventType: 'ZOHO_PACKAGE_CREATED', oldStatus: order.status, newStatus,
            actorId, actorName,
            notes: `Package ${latestPackage.package_number || latestPackage.package_id || ''} found in Zoho — backfilled by manual sync`,
            metadata: { source }
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
      } else if (trackingNumber && !alreadyLogged('ZOHO_DISPATCHED') && !['completed', 'cancelled'].includes(order.status)) {
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
          // Aug 31, 2026 (5): 'ready_for_invoice_sent' added — mirrors the same fix
          // in the live webhook handler. If Finance invoiced before packing
          // ever started (the confirmed ideal order), the order can reach
          // this sync already sitting at 'ready_for_invoice_sent' instead of
          // a pre-shipment stage, and should still count
          // as a valid pre-shipment state.
          // Sep 1, 2026: 'ready_for_dispatch' added, and the two hops now go
          // through the state machine — same as the live webhook.
          let cascadeStatus = order.status;
          if (['ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing'].includes(order.status)) {
            const moved = advanceTo(order.id, order.status, 'dispatched', now);
            if (moved.changed) cascadeStatus = moved.status;
          }
          logEvent({
            orderId: order.id, eventType: 'ZOHO_DISPATCHED', oldStatus: order.status, newStatus: cascadeStatus,
            actorId, actorName,
            notes: `Shipment found in Zoho — Tracking: ${trackingNumber} (${courier || 'courier TBD'}) — backfilled by manual sync`,
            metadata: { trackingNumber, courier, source }
          });

          const dispatchedStatus = cascadeStatus;
          const tracked = advanceTo(order.id, dispatchedStatus, 'tracking_shared', now);
          if (tracked.changed) {
            cascadeStatus = tracked.status;
            logEvent({ orderId: order.id, eventType: 'TRACKING_ENTERED', oldStatus: dispatchedStatus, newStatus: cascadeStatus, actorId, actorName, notes: `${courier || 'Courier'}: ${trackingNumber}` });
          }

          newStatus = cascadeStatus;

          // Shipped — if payment was already recorded, that's both halves of
          // the rule and the order closes out here.
          const completion = evaluateCompletion({
            orderId: order.id,
            currentStatus: newStatus,
            actorId,
            actorName,
            trigger: 'shipment'
          });
          if (completion.completed) newStatus = 'completed';

          notify({
            orderId: order.id,
            recipientIds: [order.medrep_user_id],
            message: `Order ${order.getmeds_order_id} shipped via Zoho. Courier: ${courier || 'TBD'}, Tracking: ${trackingNumber}.`,
            eventType: 'ORDER_DISPATCHED',
            orderData: { ...order, status: newStatus, tracking_number: trackingNumber, courier }
          });
        })();

        action = 'DISPATCHED_BACKFILLED';
      }
    }

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC').all(order.id);

    return { ok: true, action, zohoStatus: soStatus, order: updatedOrder, events };
  } catch (err) {
    // Never throws. The background poller must not die because one order
    // hit a bad response, and a page load must not 500 because Zoho did.
    console.error(`[ZOHO_RECONCILE] order ${orderId} failed:`, err.message);
    return { ok: false, code: 'RECONCILE_FAILED', message: err.message };
  }
}

/**
 * Reconcile until there is nothing left to catch up on.
 *
 * Sep 1, 2026 (6). reconcileOrder() above backfills ONE checkpoint per call —
 * its body is an `if (confirmed) … else if (cancelled) … else { dispatch /
 * package / invoice }` chain, so a single pass can only ever record one thing.
 * That was invisible while the app created every order itself and the events
 * trickled in one webhook at a time. It stops being invisible the moment you
 * point the app at a Sales Order that already exists in Zoho and is several
 * stages along: one pass logs "confirmed" and stops, and the trail looks
 * half-built with no indication more is waiting.
 *
 * Calling it repeatedly converges, because each pass records a checkpoint and
 * the `alreadyLogged` guards stop it repeating one. This just does that, and
 * stops as soon as a pass reports NOTHING_NEW.
 *
 * `maxPasses` is a backstop against a bug where some branch reports an action
 * without ever recording anything durable — that would otherwise spin here
 * forever, hammering Zoho with one API read per pass. Seven is comfortably
 * more than the six checkpoints a single order can have.
 */
async function reconcileOrderFully({ orderId, actorId = null, actorName = 'Auto Sync', source = 'auto_sync', maxPasses = 7 }) {
  const actions = [];
  let last = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    last = await reconcileOrder({ orderId, actorId, actorName, source });
    if (!last.ok) break;
    if (!last.action || last.action === 'NOTHING_NEW') break;
    actions.push(last.action);
  }

  if (actions.length === maxPasses) {
    console.warn(
      `[ZOHO_RECONCILE] order ${orderId} still reported work after ${maxPasses} passes — stopping. ` +
        'A branch is likely reporting an action without recording anything, which would loop forever.'
    );
  }

  // `last` is the pass that ENDED the loop, which on success is the one that
  // found nothing left to do — so reporting its 'NOTHING_NEW' as this call's
  // action would tell every caller that a reconcile which just rebuilt five
  // checkpoints had done nothing. Report the last one that actually did
  // something instead, and hand back the full list alongside it.
  return {
    ...(last || {}),
    action: actions.length ? actions[actions.length - 1] : 'NOTHING_NEW',
    actions,
    passes: actions.length
  };
}

module.exports = { reconcileOrder, reconcileOrderFully };
