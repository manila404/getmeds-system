const db = require('../db/database');
const stateMachine = require('../workflow/stateMachine');
const { setOrderStatus } = require('../services/orderStatusService');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const { markVerifiedWithOrder } = require('./paymentProof.controller');


// ─── Finance visibility (read-only) ────────────────────────────────────────
//
// Finance verification happens IN ZOHO, not in this app. The real workflow
// is: MedRep submits an order here -> it syncs to Zoho as a Sales Order ->
// Finance confirms the Sales Order in Zoho -> Finance converts it to an
// Invoice in Zoho -> Finance records the Customer Payment in Zoho. Every one
// of those Zoho-side actions calls back to POST /api/webhooks/zoho (see
// webhook.controller.js), which is what actually advances the order's
// status here. This controller no longer writes order/payment status — it
// only reads what the webhooks already wrote, so Finance staff can see
// where each order stands without leaving this app. (The previous
// verify-payment / sync-payment actions that pushed status from this app
// TO Zoho have been retired — Zoho is the system of record for this part
// of the flow now.)

// Orders currently waiting on a Zoho-side finance action: Sales Order
// confirmed but not yet invoiced ('ready_for_draft_invoice'), invoiced in Zoho
// but not yet issued to the customer ('ready_for_invoice_sent'), or issued and
// awaiting payment ('ready_for_dispatch').
//
// Sep 1, 2026: 'ready_for_dispatch' added with the new status. An order stays in
// this queue until the payment is recorded, which is the point Finance's
// involvement actually ends — issuing the invoice is a step along the way,
// not the finish line.
exports.getQueue = async (req, res, next) => {
  try {
    const orders = await db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name, u.email as medrep_email,
             p.status as payment_status, p.payment_reference, p.amount as payment_amount,
             -- Sep 4, 2026: the proof of payment rides along, so a row at
             -- ready_for_finance_verified can show it beside the Verify button
             -- without a second request per row. NULL simply means none was
             -- attached — a proof is optional, and Finance decides either way.
             pp.status as payment_proof_status,
             pp.uploaded_at as payment_proof_uploaded_at,
             pp.file_name as payment_proof_file_name,
             pp.content_type as payment_proof_content_type,
             ppu.name as payment_proof_uploaded_by_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      LEFT JOIN payment_proofs pp ON o.id = pp.order_id
      LEFT JOIN users ppu ON pp.uploaded_by = ppu.id
      WHERE o.status IN ('ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch')
      ORDER BY o.submitted_at ASC
    `).all();
    res.json({ success: true, data: { orders } });
  } catch (err) { next(err); }
};

// Payment details for a specific order — populated by the Zoho webhook once
// Finance records the Customer Payment in Zoho, not by any action in here.
exports.getPayment = async (req, res, next) => {
  try {
    const payment = await db.prepare(`
      SELECT p.*, u.name as verified_by_name, o.getmeds_order_id, o.total_amount, o.customer_type,
             o.zoho_so_number, o.zoho_invoice_number
      FROM payments p
      LEFT JOIN users u ON p.verified_by = u.id
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.order_id = ?
    `).get(req.params.id);
    if (!payment) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No payment record found for this order' } });
    res.json({ success: true, data: { payment } });
  } catch (err) { next(err); }
};

// ─── FINANCE ACCOUNT VERIFICATION (Sep 1, 2026) ───────────────────────────────
//
// The one stage in the whole flow that Zoho cannot report, because nothing in
// Zoho represents it. Before an invoice is raised, Finance checks the
// customer's account — overdue balance, account problems — in Zoho Books, and
// decides. That is a human judgement, so it is recorded by this action rather
// than by a webhook, and the trail names the person who made it.
//
// Deliberately NOT a hard gate. This app cannot stop anyone raising an invoice
// directly in Zoho, so if an invoice appears while an order is still awaiting
// verification, the reconcile moves it along anyway and says so (see
// services/zohoReconcileService.js). Blocking here would only produce orders
// stuck in this app while Zoho carried on without them.
exports.verifyAccount = async (req, res, next) => {
  try {
    const { approved, reason } = req.body || {};
    if (typeof approved !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'approved must be true (verify) or false (reject).' }
      });
    }
    // A rejection without a reason is useless to whoever picks the order up
    // next — that reason is the entire output of this step.
    if (!approved && !String(reason || '').trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'A reason is required when rejecting — it is what the next person acts on.' }
      });
    }

    const order = await db.prepare(`
      SELECT o.*, c.name as customer_name, u.id as medrep_user_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }

    if (order.status !== 'ready_for_finance_verified') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_AWAITING_VERIFICATION',
          message: `This order is at "${order.status}", not awaiting finance verification.`
        }
      });
    }

    const target = approved ? 'ready_for_draft_invoice' : 'on_hold';
    if (!stateMachine.canTransition(order.status, target)) {
      return res.status(409).json({
        success: false,
        error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${order.status} to ${target}` }
      });
    }

    const actor = await resolveActor(req.user, 'finance');
    const now = new Date().toISOString();
    let newStatus = order.status;
    let verifiedProof = null;

    await db.transaction(async () => {
      const moved = await setOrderStatus(order.id, order.status, target, now);
      newStatus = moved.status;

      if (!approved) {
        await db.prepare('UPDATE orders SET exception_reason = ?, updated_at = ? WHERE id = ?')
          .run(String(reason).trim(), now, order.id);
      }

      // Sep 4, 2026: the proof of payment is approved BY this decision, in
      // this transaction — not by a second click somewhere else. Finance looks
      // at the slip and the customer's Zoho Books account together and answers
      // once, so the proof's status and the order's can never disagree.
      //
      // Only on approval. Holding an order does NOT reject its proof: the hold
      // may be an account problem entirely unrelated to the slip, and marking
      // a perfectly good receipt rejected would send the MedRep chasing the
      // wrong thing. Rejecting a proof is its own action — see
      // paymentProof.controller.js's reject.
      //
      // Returns null when nothing was pending, which is the normal case: a
      // proof is optional and most orders will not have one.
      if (approved) {
        verifiedProof = await markVerifiedWithOrder(order.id, actor.id, now);
      }

      await logEvent({
        orderId: order.id,
        eventType: approved ? 'FINANCE_VERIFIED' : 'FINANCE_REJECTED',
        oldStatus: order.status,
        newStatus,
        actorId: actor.id,
        actorName: actor.name,
        notes: approved
          ? `Customer account verified in Zoho Books — cleared to invoice.` +
            `${verifiedProof ? ` Proof of payment${verifiedProof.file_name ? ` (${verifiedProof.file_name})` : ''} verified with it.` : ''}` +
            `${reason ? ` ${String(reason).trim()}` : ''}`
          : `Rejected by Finance: ${String(reason).trim()}`,
        metadata: {
          approved,
          reason: reason ? String(reason).trim() : null,
          // Recorded so the trail says what evidence was on the order at the
          // moment of the decision — including that there was none, which is
          // the point of a soft gate.
          paymentProofVerified: Boolean(verifiedProof),
          paymentProofPath: verifiedProof ? verifiedProof.storage_path : null
        }
      });

      const watchers = await getUserIdsByRole('management');
      await notify({
        orderId: order.id,
        recipientIds: Array.from(new Set([order.medrep_user_id, ...watchers].filter(Boolean))),
        message: approved
          ? `Order ${order.getmeds_order_id} passed finance verification — ready to invoice.`
          : `Order ${order.getmeds_order_id} was put on hold by Finance: ${String(reason).trim()}`,
        eventType: approved ? 'FINANCE_VERIFIED' : 'FINANCE_REJECTED',
        orderData: { ...order, status: newStatus }
      });
    })();

    res.json({
      success: true,
      data: { status: newStatus, approved, paymentProofVerified: Boolean(verifiedProof) }
    });
  } catch (err) { next(err); }
};
