const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');
const stateMachine = require('../workflow/stateMachine');
const { setOrderStatus } = require('../services/orderStatusService');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const { markVerifiedWithOrder } = require('./paymentProof.controller');
const { normalizeOrigin, originSql, importedSql } = require('../services/orderOrigin');


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
    // Sep 11, 2026 (Phase C): narrowed to the viewer's divisions.
    //
    // This queue is open to `management` as well as its own role, so without
    // this a division-scoped manager would see every order in it — the same
    // leak the orders list has, on a page nobody thinks of as an orders list.
    // loadScope returns full scope for Finance and Dispatch users themselves, so their queue is
    // unchanged.
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    const scopeAnd = scopeClause ? ` AND ${scopeClause}` : '';

    /**
     * Sep 12, 2026: imported Zoho orders are separated from orders raised
     * here, and this queue defaults to the latter.
     *
     * The import brought historical Sales Orders in carrying real statuses,
     * four of which this queue selects on — so Finance opened the page to 138
     * imported orders and the 4 they were meant to act on. Nothing was broken;
     * the actionable work was simply buried at a ratio of roughly 35 to 1.
     *
     * They are separated rather than excluded. An imported order can still be
     * the one someone is asking about, and a queue that silently drops rows is
     * worse than one that is crowded. `origin=zoho` returns them, `origin=all`
     * returns both, and the counts below are computed over the WHOLE queue so
     * the page can show what is on the other tab without fetching it.
     */
    const origin = normalizeOrigin(req.query.origin);
    const originClause = originSql(origin, 'o');
    const originAnd = originClause ? ` AND ${originClause}` : '';
    const orders = await db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name, u.email as medrep_email,
             p.status as payment_status, p.payment_reference, p.amount as payment_amount,
             -- Sep 4, 2026: the proof of payment rides along, so a row at
             -- ready_for_finance_verified can show it beside the Verify button
             -- without a second request per row. NULL simply means none was
             -- attached — a proof is optional, and Finance decides either way.
             --
             -- Sep 5, 2026: payment_proofs can now hold more than one row per
             -- order (it went from a single UNIQUE-order_id slot to a typed,
             -- multi-row attachment table — see paymentProof.controller.js).
             -- A plain LEFT JOIN here would duplicate the order row once per
             -- matching payment_proof, which is wrong for a queue that must
             -- list each order exactly once. The subquery below aggregates
             -- 'payment_proof'-type rows per order FIRST, then joins once, so
             -- the columns below carry the SAME NAMES and the SAME MEANING
             -- (the most recently uploaded proof) that FinanceQueuePage.jsx
             -- already reads — that page needed no changes for this.
             pp.pending_count as payment_proof_pending_count,
             pp.latest_status as payment_proof_status,
             pp.latest_uploaded_at as payment_proof_uploaded_at,
             pp.latest_file_name as payment_proof_file_name,
             pp.latest_content_type as payment_proof_content_type,
             pp.latest_uploaded_by_name as payment_proof_uploaded_by_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      LEFT JOIN (
        SELECT
          proofs.order_id,
          COUNT(*) FILTER (WHERE proofs.status = 'pending') AS pending_count,
          (ARRAY_AGG(proofs.status ORDER BY proofs.uploaded_at DESC))[1] AS latest_status,
          (ARRAY_AGG(proofs.uploaded_at ORDER BY proofs.uploaded_at DESC))[1] AS latest_uploaded_at,
          (ARRAY_AGG(proofs.file_name ORDER BY proofs.uploaded_at DESC))[1] AS latest_file_name,
          (ARRAY_AGG(proofs.content_type ORDER BY proofs.uploaded_at DESC))[1] AS latest_content_type,
          (ARRAY_AGG(ppu2.name ORDER BY proofs.uploaded_at DESC))[1] AS latest_uploaded_by_name
        FROM payment_proofs proofs
        LEFT JOIN users ppu2 ON proofs.uploaded_by = ppu2.id
        WHERE proofs.file_type = 'payment_proof'
        GROUP BY proofs.order_id
      ) pp ON pp.order_id = o.id
      WHERE o.status IN ('ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch')${scopeAnd}${originAnd}
      ORDER BY o.submitted_at ASC
    `).all(...scopeParams);

    // Counted over the same status + scope window but WITHOUT the origin
    // filter, so each tab can show the other's size honestly. Two aggregates
    // in one pass rather than a second round trip per tab.
    const counts = await db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE ${importedSql('o')})       AS zoho,
        COUNT(*) FILTER (WHERE NOT (${importedSql('o')})) AS getmeds,
        COUNT(*)                                          AS total
      FROM orders o
      WHERE o.status IN ('ready_for_finance_verified', 'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch')${scopeAnd}
    `).get(...scopeParams);

    res.json({
      success: true,
      data: {
        orders,
        origin,
        counts: {
          getmeds: Number(counts?.getmeds || 0),
          zoho: Number(counts?.zoho || 0),
          total: Number(counts?.total || 0),
        },
      },
    });
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
    // Sep 5, 2026: markVerifiedWithOrder now returns an ARRAY — an order can
    // carry more than one pending proof of payment (unusual, but possible:
    // two slips for a split payment, or a rejected one plus its
    // replacement uploaded again before this decision). Empty array is the
    // normal case, same as the old `null`.
    let verifiedProofs = [];

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
      // Returns [] when nothing was pending, which is the normal case: a
      // proof is optional and most orders will not have one.
      if (approved) {
        verifiedProofs = await markVerifiedWithOrder(order.id, actor.id, now);
      }

      const proofNames = verifiedProofs.map((p) => p.file_name).filter(Boolean);
      const proofNote = verifiedProofs.length
        ? ` Proof of payment${verifiedProofs.length > 1 ? 's' : ''}${proofNames.length ? ` (${proofNames.join(', ')})` : ''} verified with it.`
        : '';

      await logEvent({
        orderId: order.id,
        eventType: approved ? 'FINANCE_VERIFIED' : 'FINANCE_REJECTED',
        oldStatus: order.status,
        newStatus,
        actorId: actor.id,
        actorName: actor.name,
        notes: approved
          ? `Customer account verified in Zoho Books — cleared to invoice.${proofNote}${reason ? ` ${String(reason).trim()}` : ''}`
          : `Rejected by Finance: ${String(reason).trim()}`,
        metadata: {
          approved,
          reason: reason ? String(reason).trim() : null,
          // Recorded so the trail says what evidence was on the order at the
          // moment of the decision — including that there was none, which is
          // the point of a soft gate.
          paymentProofVerified: verifiedProofs.length > 0,
          paymentProofPaths: verifiedProofs.map((p) => p.storage_path)
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
      data: { status: newStatus, approved, paymentProofVerified: verifiedProofs.length > 0 }
    });
  } catch (err) { next(err); }
};
