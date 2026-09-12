'use strict';

const db = require('../db/database');
const proofStorage = require('../services/paymentProofStorage');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const { returnToFinanceIfHeld } = require('../services/financeHoldService');
const zoho = require('../integrations/zoho');

/**
 * Order attachments: proof of payment, and everything else.
 *
 * Sep 4, 2026, generalized Sep 5, 2026.
 *
 * ── What changed on Sep 5 ───────────────────────────────────────────────────
 *
 * This started as a single "proof of payment" slot — one row per order
 * (payment_proofs.order_id was UNIQUE). It is now a typed, multi-row
 * attachment table, matching Zoho's own "Attach File(s) to Sales Order" on
 * the Sales Order screen, but with each file tagged so this app still knows
 * which ones are evidence for Finance:
 *
 *   'payment_proof' — a deposit slip, transfer screenshot or receipt. Same
 *                     verify/reject behaviour as before, just no longer
 *                     capped at one per order.
 *   'other'         — anything else worth attaching (a PO, an authorization
 *                     letter, a signed contract). Purely informational —
 *                     nothing here verifies, rejects, or notifies Finance
 *                     about an 'other' row. `status` stays 'pending' and the
 *                     UI simply never surfaces it for these.
 *
 * Two endpoints kept their OLD single-object shape for backward
 * compatibility with callers that predate this change (FinanceQueuePage's
 * inline preview, and the finance reject action) — `get` and `reject` both
 * now operate on "the most recent 'payment_proof'-type row", which is
 * exactly the old behaviour whenever an order has zero or one proof (the
 * overwhelming common case) and degrades sensibly otherwise. `list` is the
 * new endpoint everything else should use.
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
 * finance.controller.js's verifyAccount, which marks every pending
 * 'payment_proof' row verified in the same transaction that moves the order.
 * Two verifications for one judgement would give an order two places to get
 * stuck.
 *
 * `reject` DOES live here, because rejecting a proof is not the same as
 * holding an order: "this slip is for a different invoice, send the right
 * one" should not stop the order while a correct one is fetched.
 *
 * ── An attachment is a record, not a pipeline stage ─────────────────────────
 *
 * Nothing here touches `orders.status`, workflow/stateMachine.js or
 * services/orderCompletionService.js. Attaching or rejecting one leaves the
 * order exactly where it is; only Finance's decision on the ORDER moves it,
 * through the endpoint that already did that.
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
 *   1. POST /orders/:id/attachments/upload-url -> { signedUrl, storagePath }
 *   2. browser PUTs the file straight to Supabase against signedUrl
 *   3. POST /orders/:id/attachments            -> confirms it, row is written
 *
 * Two calls because the file must not pass through this function — Vercel
 * caps request bodies at 4.5 MB and a phone photo is routinely larger. See
 * services/paymentProofStorage.js. (The old /payment-proof paths are kept as
 * aliases onto the same handlers — see orders.routes.js.)
 */

async function loadOrder(id) {
  return await db
    .prepare(
      `SELECT o.id, o.getmeds_order_id, o.status, o.medrep_id, o.zoho_so_id,
              o.raised_by_id,
              c.name AS customer_name,
              u.id   AS medrep_user_id
         FROM orders o
         LEFT JOIN customers c ON o.customer_id = c.id
         LEFT JOIN users     u ON o.medrep_id  = u.id
        WHERE o.id = ?`
    )
    .get(id);
}

// Sep 9, 2026: 'gl' (Guarantee Letter), 'prescription' and 'id' added for the
// hospital PAP/DSWD intake, which requires all four of GL, Prescription, Proof
// of Payment and a photo ID. Must stay in step with REQUIRED_FILE_TYPES in
// db/migrate.pg.js and the CHECK in schema.pg.sql — a value accepted here that
// the constraint rejects fails at INSERT with a database error rather than a
// useful message.
const FILE_TYPES = ['payment_proof', 'other', 'purchase_order', 'gl', 'prescription', 'id'];

/** Body may omit file_type entirely — every caller that predates this change
 * did, and they all meant a proof of payment. */
function normalizeFileType(value) {
  const v = String(value || 'payment_proof').trim().toLowerCase();
  return FILE_TYPES.includes(v) ? v : null;
}

/**
 * Who may attach a file: the MedRep the order belongs to, an admin, or
 * management.
 *
 * requireRole cannot express this — it is per-row ownership, not a role — so
 * it is checked here, mirroring the check orders.controller.js's getById
 * already applies.
 *
 * Sep 5, 2026: management added. They can create and submit an order on a
 * MedRep's behalf (see orders.controller.js's resolveOrderMedrep) — the
 * attachment upload that follows order creation is part of that same flow,
 * so management needs the same access here or their own "create for a
 * MedRep" pilot would be unable to attach anything.
 *
 * Sep 11, 2026: the raiser added, which is the same gap reopening. MedReps
 * can now raise an order for a colleague too, and `medrep_id` is then the
 * COLLEAGUE's — so the rep who filled the form in failed this check the
 * instant the form tried to upload the file they had just attached. The order
 * saved, the file did not, and the only sign was a red toast (GM-20260911-0003).
 *
 * Deliberately narrow: it admits the one person orders.raised_by_id names as
 * having raised THIS order, not "any MedRep who can see it".
 *
 * Kept separate from orders.controller.js's canActOnOrder rather than merged:
 * that one answers for MedReps and waves every other role through, because its
 * callers had already filtered by role. This is the ONLY check its callers
 * make, so it has to name admin and management itself. The MedRep half is the
 * same rule and has to stay that way.
 */
function canAttach(user, order) {
  if (!user) return false;
  const role = (user.role || '').toLowerCase();
  if (role === 'admin' || role === 'management') return true;
  if (order.medrep_id === user.id) return true;
  return Boolean(order.raised_by_id) && order.raised_by_id === user.id;
}

const notFound = (res, message) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message } });

const badRequest = (res, message) =>
  res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });

// ─── 1. Mint a signed upload URL ─────────────────────────────────────────────

exports.getUploadUrl = async (req, res, next) => {
  try {
    const { contentType, fileName, fileSize, file_type } = req.body || {};

    const fileType = normalizeFileType(file_type);
    if (!fileType) return badRequest(res, `file_type must be one of: ${FILE_TYPES.join(', ')}`);

    const invalid = proofStorage.validateUpload({ contentType, fileSize });
    if (invalid) return badRequest(res, invalid);

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    if (!canAttach(req.user, order)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You can only attach a file to your own orders.' },
      });
    }

    const storagePath = proofStorage.buildPath(order.id, order.getmeds_order_id, contentType, fileName, fileType);
    const { signedUrl } = await proofStorage.createUploadUrl(storagePath);

    res.json({ success: true, data: { signedUrl, storagePath } });
  } catch (err) {
    next(err);
  }
};

// ─── 2. Confirm the upload landed ────────────────────────────────────────────

exports.attach = async (req, res, next) => {
  try {
    const { storagePath, fileName, contentType, fileSize, file_type } = req.body || {};
    if (!storagePath) return badRequest(res, 'storagePath is required.');

    const fileType = normalizeFileType(file_type);
    if (!fileType) return badRequest(res, `file_type must be one of: ${FILE_TYPES.join(', ')}`);

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    if (!canAttach(req.user, order)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You can only attach a file to your own orders.' },
      });
    }

    // The signed URL from step 1 is the only thing between these two calls, so
    // the path is re-checked here rather than trusted. Without this, a caller
    // could confirm an arbitrary string and point this order's attachment at
    // another order's file.
    if (!String(storagePath).startsWith(proofStorage.pathPrefixFor(order.id))) {
      return badRequest(res, 'storagePath does not belong to this order.');
    }

    const actor = await resolveActor(req.user, 'medrep');
    const now = new Date().toISOString();

    // Sep 5, 2026: always a new row. The old single-slot version upserted on
    // order_id (UNIQUE) because a second upload meant "replace the proof". Now
    // that an order can carry any number of attachments, a second upload just
    // adds another one — the earlier rows (including a rejected proof) stay
    // in the trail rather than being silently overwritten.
    const inserted = await db
      .prepare(
        `INSERT INTO payment_proofs
           (order_id, file_type, status, storage_path, file_name, content_type, file_size, uploaded_by, uploaded_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        order.id,
        fileType,
        storagePath,
        fileName || null,
        contentType || null,
        fileSize == null ? null : Number(fileSize),
        actor.id,
        now
      );

    await logEvent({
      orderId: order.id,
      eventType: fileType === 'payment_proof' ? 'PAYMENT_PROOF_UPLOADED' : 'ATTACHMENT_UPLOADED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: fileType === 'payment_proof'
        ? `Proof of payment attached${fileName ? ` (${fileName})` : ''}.`
        : `File attached${fileName ? ` (${fileName})` : ''}.`,
      metadata: {
        storagePath,
        fileName: fileName || null,
        contentType: contentType || null,
        fileSize: fileSize == null ? null : Number(fileSize),
        fileType,
      },
    });

    /**
     * Sep 12, 2026: ANY attachment reopens a Finance hold, not just a proof.
     *
     * Finance holds an order and asks for something; whatever the MedRep sends
     * back is the answer to that question. Restricting this to 'payment_proof'
     * would leave an order held for a missing Guarantee Letter sitting exactly
     * as stuck as before — and Finance's hold reason is free text, so the file
     * type cannot be matched against it anyway.
     *
     * See services/financeHoldService.js for why this only fires on holds that
     * Finance itself applied.
     */
    const returnedToFinance = await returnToFinanceIfHeld(order, actor, {
      reason: fileType === 'payment_proof' ? 'Proof of payment attached' : 'File attached',
    });

    // Tell Finance when the order is on their desk — either because it was
    // already there, or because the upload above just put it back. (The
    // return path sends its own, differently worded, notification.)
    if (fileType === 'payment_proof' && order.status === 'ready_for_finance_verified') {
      await notify({
        orderId: order.id,
        recipientIds: await getUserIdsByRole('finance'),
        message: `Order ${order.getmeds_order_id} has a proof of payment awaiting your check.`,
        eventType: 'PAYMENT_PROOF_UPLOADED',
        orderData: order,
      });
    }

    // Sep 8, 2026: best-effort push of this same file onto the matching
    // Zoho Sales Order's own "Attach File(s)" section (zoho.
    // addSalesOrderAttachment — a deliberate, narrow exception to this
    // app's create-only Zoho policy, see ZohoAdapter.js). Soft-gated, same
    // shape as updateCustomerTin in customers.controller.js: the local
    // attachment above has already succeeded and is never undone by this
    // failing. Only attempted once the order actually has a Zoho Sales
    // Order (zoho_so_id) — nothing to attach to before that exists, and a
    // draft order's attachments simply stay local-only until it syncs.
    // Applies to every attachment type (payment_proof/other/purchase_order)
    // — Zoho's own "Attach File(s)" section doesn't distinguish types
    // either, and this only ever pushes NEW uploads, never backfills
    // whatever was attached before this existed.
    let zohoPushed = false;
    let zohoError = null;
    if (order.zoho_so_id) {
      try {
        const buffer = await proofStorage.downloadFile(storagePath);
        await zoho.addSalesOrderAttachment(order.zoho_so_id, {
          buffer,
          filename: fileName || 'attachment',
          contentType: contentType || 'application/octet-stream',
        });
        zohoPushed = true;
      } catch (zohoErr) {
        zohoError = zohoErr.message;
        console.warn(
          `[PAYMENT_PROOF] addSalesOrderAttachment failed for SO ${order.zoho_so_id}:`,
          zohoErr.message
        );
      }
    }

    res.json({
      success: true,
      data: {
        id: inserted.lastInsertRowid,
        status: 'pending',
        fileType,
        storagePath,
        zoho_pushed: zohoPushed,
        zoho_error: zohoError,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── 3a. List every attachment on an order (new) ────────────────────────────

exports.list = async (req, res, next) => {
  try {
    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    const rows = await db
      .prepare(
        `SELECT p.*,
                up.name AS uploaded_by_name,
                vp.name AS verified_by_name
           FROM payment_proofs p
           LEFT JOIN users up ON p.uploaded_by = up.id
           LEFT JOIN users vp ON p.verified_by = vp.id
          WHERE p.order_id = ?
          ORDER BY p.uploaded_at DESC`
      )
      .all(order.id);

    // Minted per request, short-lived, never stored — same as the old single
    // `get`. A view URL per row is one Supabase call each; fine at the scale
    // an order's attachment list actually reaches (a handful of files).
    const attachments = await Promise.all(
      rows.map(async (row) => ({ ...row, viewUrl: await proofStorage.createViewUrl(row.storage_path) }))
    );

    res.json({ success: true, data: { attachments } });
  } catch (err) {
    next(err);
  }
};

// ─── 3b. Read the single most-recent proof of payment (legacy shape) ────────
//
// Sep 5, 2026: kept for FinanceQueuePage's inline preview (GET
// /api/orders/:id/payment-proof), which expects exactly one `proof` object.
// Returns the most recently uploaded 'payment_proof'-type row — identical to
// the old behaviour when there is zero or one (the normal case), and the most
// useful single answer when there is more than one (e.g. a rejected proof
// followed by its replacement: this returns the replacement).

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
          WHERE p.order_id = ? AND p.file_type = 'payment_proof'
          ORDER BY p.uploaded_at DESC
          LIMIT 1`
      )
      .get(req.params.id);

    if (!proof) return notFound(res, 'No proof of payment attached to this order.');

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
//
// Sep 5, 2026: targets the most recent PENDING 'payment_proof' row rather
// than assuming exactly one exists. Identical behaviour to before whenever
// there is only one (the normal case). Never touches an 'other' attachment —
// those are informational only and have no reject action.

exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!String(reason || '').trim()) {
      return badRequest(res, 'A reason is required — it is what the MedRep acts on.');
    }

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    const proof = await db
      .prepare(
        `SELECT * FROM payment_proofs
          WHERE order_id = ? AND file_type = 'payment_proof' AND status = 'pending'
          ORDER BY uploaded_at DESC
          LIMIT 1`
      )
      .get(order.id);
    if (!proof) return notFound(res, 'No proof of payment awaiting review on this order.');

    const actor = await resolveActor(req.user, 'finance');
    const now = new Date().toISOString();
    const cleanReason = String(reason).trim();

    await db.transaction(async () => {
      // Guarded on this row's id AND status = 'pending' so two Finance users
      // acting at once produce one write and one 0-row update rather than two
      // events on the same proof.
      const upd = await db
        .prepare(
          `UPDATE payment_proofs
              SET status = 'rejected', verified_by = ?, verified_at = ?, rejection_reason = ?
            WHERE id = ? AND status = 'pending'`
        )
        .run(actor.id, now, cleanReason, proof.id);

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
 * Mark every pending proof of payment verified, inside an existing
 * transaction.
 *
 * Called by finance.controller.js's verifyAccount when Finance approves the
 * ORDER, so the proof(s) and the decision they fed are recorded together and
 * cannot disagree. Exported rather than inlined so the "what happens to a
 * proof" rule lives beside the rest of the proof's behaviour.
 *
 * Sep 5, 2026: an order can now carry more than one pending 'payment_proof'
 * row (unusual, but possible — e.g. two slips for a split payment), so this
 * verifies ALL of them rather than assuming one. Returns the array of rows it
 * updated (possibly empty, which is the normal case — a proof is optional).
 */
async function markVerifiedWithOrder(orderId, actorId, now) {
  const pending = await db
    .prepare(
      `SELECT * FROM payment_proofs WHERE order_id = ? AND file_type = 'payment_proof' AND status = 'pending'`
    )
    .all(orderId);
  if (!pending.length) return [];

  await db
    .prepare(
      `UPDATE payment_proofs
          SET status = 'verified', verified_by = ?, verified_at = ?, rejection_reason = NULL
        WHERE order_id = ? AND file_type = 'payment_proof' AND status = 'pending'`
    )
    .run(actorId, now, orderId);

  return pending;
}

exports.markVerifiedWithOrder = markVerifiedWithOrder;
