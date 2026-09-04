'use strict';

const db = require('../db/database');
const proofStorage = require('../services/paymentProofStorage');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');

/**
 * Proof of payment: attaching it, reading it, and rejecting a bad one.
 *
 * Sep 4, 2026.
 *
 * ── Where this sits in the flow ────────────────────────────────────────────
 *
 *   MedRep submits  ->  app creates a Draft Sales Order in Zoho
 *                          |  (Zoho webhook: SO confirmed)
 *                   ready_for_finance_verified      <- Finance decides HERE
 *                          |  POST /api/finance/orders/:id/verify
 *                   ready_for_draft_invoice         <- Finance raises the invoice
 *
 * The gate already existed. `ready_for_finance_verified` is documented in
 * 2026-09-01-finance-verification.md as the one stage Zoho cannot report,
 * because it is a human judgement rather than a document. A proof of payment
 * is the EVIDENCE for that judgement — so it is shown on that decision and
 * approved by it, rather than getting a decision of its own.
 *
 * That is why there is no `verify` here. Approval lives in
 * finance.controller.js's verifyAccount, which marks a pending proof verified
 * in the same transaction that moves the order. Two verifications for one
 * judgement would give an order two places to get stuck.
 *
 * `reject` DOES live here, because rejecting a proof is not the same as
 * holding an order: "this slip is for a different invoice, send the right
 * one" should not stop the order while a correct one is fetched.
 *
 * ── A proof is a record, not a pipeline stage ──────────────────────────────
 *
 * Nothing here touches `orders.status`, workflow/stateMachine.js or
 * services/orderCompletionService.js. Attaching, replacing or rejecting a
 * proof leaves the order exactly where it is; only Finance's decision on the
 * ORDER moves it, through the endpoint that already did that.
 *
 * ── A verified proof is NOT "paid" ─────────────────────────────────────────
 *
 * `payments` is Zoho's record of a Customer Payment, arriving by webhook, and
 * it is what orderCompletionService.js means by paid (shipped AND paid). This
 * table is the customer's CLAIM to have paid. They are deliberately separate,
 * and a verified proof never completes an order.
 *
 * ── The upload handshake ───────────────────────────────────────────────────
 *
 *   1. POST /orders/:id/payment-proof/upload-url -> { signedUrl, storagePath }
 *   2. browser PUTs the file straight to Supabase against signedUrl
 *   3. POST /orders/:id/payment-proof            -> confirms it
 *
 * Two calls because the file must not pass through this function — Vercel
 * caps request bodies at 4.5 MB and a phone photo is routinely larger. See
 * services/paymentProofStorage.js.
 */

async function loadOrder(id) {
  return await db
    .prepare(
      `SELECT o.id, o.getmeds_order_id, o.status, o.medrep_id,
              c.name AS customer_name,
              u.id   AS medrep_user_id
         FROM orders o
         LEFT JOIN customers c ON o.customer_id = c.id
         LEFT JOIN users     u ON o.medrep_id  = u.id
        WHERE o.id = ?`
    )
    .get(id);
}

/**
 * Who may attach a proof: the MedRep the order belongs to, or an admin.
 *
 * requireRole cannot express this — it is per-row ownership, not a role — so
 * it is checked here, mirroring the check orders.controller.js's getById
 * already applies.
 */
function canAttach(user, order) {
  if (!user) return false;
  if ((user.role || '').toLowerCase() === 'admin') return true;
  return order.medrep_id === user.id;
}

const notFound = (res, message) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message } });

const badRequest = (res, message) =>
  res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });

// ─── 1. Mint a signed upload URL ─────────────────────────────────────────────

exports.getUploadUrl = async (req, res, next) => {
  try {
    const { contentType, fileName, fileSize } = req.body || {};

    const invalid = proofStorage.validateUpload({ contentType, fileSize });
    if (invalid) return badRequest(res, invalid);

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    if (!canAttach(req.user, order)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You can only attach a proof of payment to your own orders.' },
      });
    }

    // A verified proof is what Finance based its decision on. Replacing it
    // silently would let the evidence change after the fact, so it is refused;
    // a genuine correction is a rejection first.
    const existing = await db
      .prepare('SELECT status FROM payment_proofs WHERE order_id = ?')
      .get(order.id);
    if (existing && existing.status === 'verified') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_VERIFIED',
          message: 'This proof of payment has been verified by Finance and cannot be replaced.',
        },
      });
    }

    const storagePath = proofStorage.buildPath(order.id, order.getmeds_order_id, contentType, fileName);
    const { signedUrl } = await proofStorage.createUploadUrl(storagePath);

    res.json({ success: true, data: { signedUrl, storagePath } });
  } catch (err) {
    next(err);
  }
};

// ─── 2. Confirm the upload landed ────────────────────────────────────────────

exports.attach = async (req, res, next) => {
  try {
    const { storagePath, fileName, contentType, fileSize } = req.body || {};
    if (!storagePath) return badRequest(res, 'storagePath is required.');

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    if (!canAttach(req.user, order)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You can only attach a proof of payment to your own orders.' },
      });
    }

    // The signed URL from step 1 is the only thing between these two calls, so
    // the path is re-checked here rather than trusted. Without this, a caller
    // could confirm an arbitrary string and point this order's proof at
    // another order's file.
    if (!String(storagePath).startsWith(proofStorage.pathPrefixFor(order.id))) {
      return badRequest(res, 'storagePath does not belong to this order.');
    }

    const existing = await db
      .prepare('SELECT status, storage_path FROM payment_proofs WHERE order_id = ?')
      .get(order.id);

    if (existing && existing.status === 'verified') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_VERIFIED',
          message: 'This proof of payment has been verified by Finance and cannot be replaced.',
        },
      });
    }

    const actor = await resolveActor(req.user, 'medrep');
    const now = new Date().toISOString();
    const isReplacement = Boolean(existing);

    await db.transaction(async () => {
      // Upsert rather than insert: order_id is UNIQUE (one proof per order,
      // matching payments and dispatch_records), and re-uploading after a
      // rejection must clear the previous decision rather than leave a
      // rejected proof wearing a new file.
      await db
        .prepare(
          `INSERT INTO payment_proofs
             (order_id, status, storage_path, file_name, content_type, file_size, uploaded_by, uploaded_at)
           VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)
           ON CONFLICT (order_id) DO UPDATE SET
             status           = 'pending',
             storage_path     = EXCLUDED.storage_path,
             file_name        = EXCLUDED.file_name,
             content_type     = EXCLUDED.content_type,
             file_size        = EXCLUDED.file_size,
             uploaded_by      = EXCLUDED.uploaded_by,
             uploaded_at      = EXCLUDED.uploaded_at,
             verified_by      = NULL,
             verified_at      = NULL,
             rejection_reason = NULL`
        )
        .run(
          order.id,
          storagePath,
          fileName || null,
          contentType || null,
          fileSize == null ? null : Number(fileSize),
          actor.id,
          now
        );

      await logEvent({
        orderId: order.id,
        eventType: 'PAYMENT_PROOF_UPLOADED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: isReplacement
          ? `Proof of payment re-attached${fileName ? ` (${fileName})` : ''}.`
          : `Proof of payment attached${fileName ? ` (${fileName})` : ''}.`,
        metadata: {
          storagePath,
          fileName: fileName || null,
          contentType: contentType || null,
          fileSize: fileSize == null ? null : Number(fileSize),
          replacement: isReplacement,
        },
      });

      // Only worth telling Finance when the order is actually sitting on their
      // desk. A proof attached at draft, or long after invoicing, is not
      // something anyone needs to act on right now.
      if (order.status === 'ready_for_finance_verified') {
        await notify({
          orderId: order.id,
          recipientIds: await getUserIdsByRole('finance'),
          message: `Order ${order.getmeds_order_id} has a proof of payment awaiting your check.`,
          eventType: 'PAYMENT_PROOF_UPLOADED',
          orderData: order,
        });
      }
    })();

    // Outside the transaction on purpose: a storage call cannot be rolled back,
    // and losing the new row because the old file would not delete is a far
    // worse trade than leaving one orphaned object behind.
    if (existing && existing.storage_path && existing.storage_path !== storagePath) {
      await proofStorage.removeQuietly(existing.storage_path);
    }

    res.json({ success: true, data: { status: 'pending', storagePath } });
  } catch (err) {
    next(err);
  }
};

// ─── 3. Read it back ─────────────────────────────────────────────────────────

exports.get = async (req, res, next) => {
  try {
    const proof = await db
      .prepare(
        `SELECT p.*,
                up.name AS uploaded_by_name,
                vp.name AS verified_by_name
           FROM payment_proofs p
           LEFT JOIN users up ON p.uploaded_by = up.id
           LEFT JOIN users vp ON p.verified_by = vp.id
          WHERE p.order_id = ?`
      )
      .get(req.params.id);

    if (!proof) return notFound(res, 'No proof of payment attached to this order.');

    // Minted per request, short-lived, never stored. The database holds an
    // object key, not a URL, so a leaked row is not a leaked file.
    const viewUrl = await proofStorage.createViewUrl(proof.storage_path);

    res.json({ success: true, data: { proof: { ...proof, viewUrl } } });
  } catch (err) {
    next(err);
  }
};

// ─── 4. Finance rejects a bad proof ──────────────────────────────────────────
//
// Note what this does NOT do: it does not move the order, and there is no
// matching approve. Approval happens when Finance verifies the ORDER (see
// finance.controller.js's verifyAccount), which is the decision this evidence
// feeds. This exists for the narrower case — the slip is wrong, unreadable, or
// for a different invoice — where the right outcome is "send me a better one"
// rather than putting the order on hold.

exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!String(reason || '').trim()) {
      return badRequest(res, 'A reason is required — it is what the MedRep acts on.');
    }

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    const proof = await db.prepare('SELECT * FROM payment_proofs WHERE order_id = ?').get(order.id);
    if (!proof) return notFound(res, 'No proof of payment attached to this order.');

    if (proof.status !== 'pending') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_AWAITING_REVIEW',
          message: `This proof of payment is already "${proof.status}".`,
        },
      });
    }

    const actor = await resolveActor(req.user, 'finance');
    const now = new Date().toISOString();
    const cleanReason = String(reason).trim();

    await db.transaction(async () => {
      // Guarded on status = 'pending' so two Finance users acting at once
      // produce one write and one 0-row update rather than two events on the
      // same proof. The 409 above is the common path; this closes the race.
      const upd = await db
        .prepare(
          `UPDATE payment_proofs
              SET status = 'rejected', verified_by = ?, verified_at = ?, rejection_reason = ?
            WHERE order_id = ? AND status = 'pending'`
        )
        .run(actor.id, now, cleanReason, order.id);

      if (!upd.changes) {
        const conflict = new Error('This proof of payment was already reviewed by someone else.');
        conflict.statusCode = 409;
        conflict.code = 'NOT_AWAITING_REVIEW';
        throw conflict;
      }

      await logEvent({
        orderId: order.id,
        eventType: 'PAYMENT_PROOF_REJECTED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `Proof of payment rejected by Finance: ${cleanReason}`,
        metadata: { reason: cleanReason, storagePath: proof.storage_path },
      });

      await notify({
        orderId: order.id,
        recipientIds: [order.medrep_user_id].filter(Boolean),
        message: `Proof of payment for order ${order.getmeds_order_id} was rejected: ${cleanReason} — please upload a replacement.`,
        eventType: 'PAYMENT_PROOF_REJECTED',
        orderData: order,
      });
    })();

    res.json({ success: true, data: { status: 'rejected' } });
  } catch (err) {
    if (err && err.statusCode === 409) {
      return res.status(409).json({
        success: false,
        error: { code: err.code || 'CONFLICT', message: err.message },
      });
    }
    next(err);
  }
};

/**
 * Mark a pending proof verified, inside an existing transaction.
 *
 * Called by finance.controller.js's verifyAccount when Finance approves the
 * ORDER, so the proof and the decision it fed are recorded together and
 * cannot disagree. Exported rather than inlined so the "what happens to the
 * proof" rule lives beside the rest of the proof's behaviour.
 *
 * Returns the proof row it updated, or null when there was nothing pending —
 * which is the normal case, since a proof is optional.
 */
async function markVerifiedWithOrder(orderId, actorId, now) {
  const proof = await db
    .prepare("SELECT * FROM payment_proofs WHERE order_id = ? AND status = 'pending'")
    .get(orderId);
  if (!proof) return null;

  await db
    .prepare(
      `UPDATE payment_proofs
          SET status = 'verified', verified_by = ?, verified_at = ?, rejection_reason = NULL
        WHERE order_id = ? AND status = 'pending'`
    )
    .run(actorId, now, orderId);

  return proof;
}

exports.markVerifiedWithOrder = markVerifiedWithOrder;
