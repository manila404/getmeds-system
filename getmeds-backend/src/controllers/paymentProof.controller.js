'use strict';

const db = require('../db/database');
const proofStorage = require('../services/paymentProofStorage');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const { returnToFinanceIfHeld } = require('../services/financeHoldService');
const zoho = require('../integrations/zoho');
const { constraintAllows, hasColumn } = require('../services/schemaColumns');
const attachmentLink = require('../services/attachmentLinkService');

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
      `SELECT o.id, o.getmeds_order_id, o.status, o.medrep_id, o.zoho_so_id, o.zoho_so_number,
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
const FILE_TYPES = ['payment_proof', 'other', 'purchase_order', 'gl', 'prescription', 'id', 'dispatch_proof'];

// Sep 15, 2026: Dispatch's photo of the order going out — the packed parcel,
// the waybill, a signed receipt — uploaded from the Dispatch page. Like every
// attachment it is pushed onto the Zoho Sales Order; unlike the others it is
// reserved to Dispatch (and management/admin), it is the ONLY type Dispatch
// may attach, and the MedRep is told when one arrives.
const DISPATCH_PROOF = 'dispatch_proof';
// Finance has confirmed the order: from here on it is Dispatch's to prove.
const DISPATCH_PROOF_STATUSES = [
  'ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch',
  'picking_packing', 'dispatched', 'tracking_shared', 'completed'
];

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
function canAttach(user, order, fileType = 'payment_proof') {
  if (!user) return false;
  const role = (user.role || '').toLowerCase();
  if (role === 'admin' || role === 'management') return true;
  // Sep 15, 2026: a dispatch proof is Dispatch's alone — not the MedRep's,
  // even on their own order — and Dispatch attaches nothing else.
  if (fileType === DISPATCH_PROOF) return role === 'dispatch';
  if (order.medrep_id === user.id) return true;
  return Boolean(order.raised_by_id) && order.raised_by_id === user.id;
}

function forbidden(res, user, fileType) {
  const role = (user?.role || '').toLowerCase();
  const message = fileType === DISPATCH_PROOF
    ? 'Only Dispatch can attach a dispatch proof.'
    : role === 'dispatch'
      ? 'Dispatch can only attach a dispatch proof photo.'
      : 'You can only attach a file to your own orders.';
  return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message } });
}

/** The two further conditions on a dispatch proof. Returns the response sent, or null. */
async function refuseDispatchProof(res, order, fileType) {
  if (fileType !== DISPATCH_PROOF) return null;
  if (!DISPATCH_PROOF_STATUSES.includes(order.status)) {
    return res.status(409).json({
      success: false,
      error: {
        code: 'NOT_AT_DISPATCH',
        message: `A dispatch proof can be attached once Finance has confirmed the order. This one is at "${order.status}".`
      }
    });
  }
  // Before the migration widens the file_type CHECK, the INSERT would fail as
  // a database error — say what to do instead. See services/schemaColumns.js.
  if (!(await constraintAllows('payment_proofs', 'file_type', DISPATCH_PROOF))) {
    return res.status(503).json({
      success: false,
      error: {
        code: 'MIGRATION_PENDING',
        message: 'Uploading a dispatch proof needs a database update first. Ask IT to run: node src/db/migrate.pg.js'
      }
    });
  }
  return null;
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

    if (!canAttach(req.user, order, fileType)) return forbidden(res, req.user, fileType);
    const refused = await refuseDispatchProof(res, order, fileType);
    if (refused) return refused;

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

    if (!canAttach(req.user, order, fileType)) return forbidden(res, req.user, fileType);
    const refused = await refuseDispatchProof(res, order, fileType);
    if (refused) return refused;

    // The signed URL from step 1 is the only thing between these two calls, so
    // the path is re-checked here rather than trusted. Without this, a caller
    // could confirm an arbitrary string and point this order's attachment at
    // another order's file.
    if (!String(storagePath).startsWith(proofStorage.pathPrefixFor(order.id))) {
      return badRequest(res, 'storagePath does not belong to this order.');
    }

    const isDispatchProof = fileType === DISPATCH_PROOF;
    const actor = await resolveActor(req.user, isDispatchProof ? 'dispatch' : 'medrep');
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
      eventType: fileType === 'payment_proof'
        ? 'PAYMENT_PROOF_UPLOADED'
        : isDispatchProof ? 'DISPATCH_PROOF_UPLOADED' : 'ATTACHMENT_UPLOADED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: fileType === 'payment_proof'
        ? `Proof of payment attached${fileName ? ` (${fileName})` : ''}.`
        : isDispatchProof
          ? `Dispatch proof attached${fileName ? ` (${fileName})` : ''}.`
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
    // A dispatch proof is not an answer to a Finance hold — and by the time
    // one can be attached, Finance is done with the order anyway.
    const returnedToFinance = isDispatchProof ? false : await returnToFinanceIfHeld(order, actor, {
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
    let zohoDocumentId = null;
    if (order.zoho_so_id) {
      try {
        const buffer = await proofStorage.downloadFile(storagePath);
        const pushResult = await zoho.addSalesOrderAttachment(order.zoho_so_id, {
          buffer,
          filename: fileName || 'attachment',
          contentType: contentType || 'application/octet-stream',
        });
        zohoPushed = true;
        // Sep 22, 2026: Phase 1 of moving attachments toward "Zoho is the
        // real copy" — see zoho_document_id's schema comment. Without this,
        // pushing succeeds but there is no way to ever read the file back
        // FROM Zoho (getSalesOrderAttachment needs the document_id).
        zohoDocumentId = pushResult?.document?.document_id || null;
      } catch (zohoErr) {
        zohoError = zohoErr.message;
        console.warn(
          `[PAYMENT_PROOF] addSalesOrderAttachment failed for SO ${order.zoho_so_id}:`,
          zohoErr.message
        );
      }
    }

    // Sep 19, 2026: persisted (rather than only returned in the response
    // below) so a later deletion request can tell whether this specific file
    // is also sitting on the real Zoho Sales Order — see requestDelete/
    // decideDelete. Best-effort like everything else here: a schema not yet
    // migrated just means that flag stays unavailable, never fails the upload.
    if (await hasColumn('payment_proofs', 'zoho_pushed')) {
      await db.prepare('UPDATE payment_proofs SET zoho_pushed = ? WHERE id = ?').run(zohoPushed, inserted.lastInsertRowid);
    }
    if (zohoDocumentId && (await hasColumn('payment_proofs', 'zoho_document_id'))) {
      await db.prepare('UPDATE payment_proofs SET zoho_document_id = ? WHERE id = ?').run(zohoDocumentId, inserted.lastInsertRowid);
    }

    // Sep 15, 2026: the MedRep who created the order (and whoever raised it)
    // is told when Dispatch attaches a proof — after the Zoho push, so the
    // message can say whether it reached the Sales Order. Best-effort: the
    // upload has already succeeded and is never undone by this.
    if (isDispatchProof) {
      try {
        const where = zohoPushed
          ? `attached to ${order.zoho_so_number || 'the Sales Order'} in Zoho`
          : 'saved in GetMeds (it could not be attached in Zoho yet)';
        await notify({
          orderId: order.id,
          recipientIds: Array.from(new Set([order.medrep_id, order.raised_by_id].filter(Boolean))),
          message: `Order ${order.getmeds_order_id}: Dispatch uploaded a proof photo${fileName ? ` (${fileName})` : ''} — ${where}.`,
          eventType: 'DISPATCH_PROOF_UPLOADED',
          orderData: order,
        });
      } catch (notifyErr) {
        console.warn(`[DISPATCH_PROOF] could not notify for ${order.getmeds_order_id}:`, notifyErr.message);
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

/**
 * Sep 22, 2026: Phase 1 of moving attachments toward "Zoho is the real,
 * permanent copy" (see zoho_document_id's schema comment,
 * attachmentLinkService.js, routes/attachmentView.routes.js).
 *
 * Sep 22, 2026 (2): CRITICAL correction, found by testing this live before
 * trusting it. Zoho's GET /salesorders/{id}/attachment endpoint does NOT
 * respect document_id at all — verified against the real org with two
 * different files on the same Sales Order and a garbage id: every request
 * returned the SAME thing, the single most-recently-uploaded attachment,
 * regardless of which document_id was asked for. The `documents[]` array
 * on a Sales Order is informational only; there is no working way to read
 * an OLDER attachment back from Zoho once a newer one exists on the same
 * order. On real data this is not an edge case — 75% of orders with a
 * synced attachment have more than one (249 of 330), covering 741 of 816
 * pushed rows.
 *
 * So: a row is only ever SERVED from Zoho when it demonstrably IS that
 * order's current latest pushed attachment (checked in viewAttachment
 * below, at request time — not here). Every earlier one on the same
 * order — regardless of its own zoho_document_id — is served from
 * Supabase instead, because Zoho itself has no way to hand it back to us.
 *
 * Sep 23, 2026 (3): every row's viewUrl/downloadUrl now points at this
 * app's own signed link (attachmentLinkService.js), full stop — the
 * Supabase-direct-signed-URL branch this function used to have for
 * non-Zoho-eligible rows is gone. Root cause found investigating a
 * Supabase egress bill of ~9 GB against ~167 MB of actually-stored bytes
 * (≈54×): the OLD code re-minted a brand-new, never-repeating Supabase
 * signed URL on every single list()/get() call, so the browser could
 * never cache a repeat view of an already-seen file — every open of an
 * order's attachments, every tab switch back to it, was a fresh full
 * download. attachmentLinkService's tokens are now DETERMINISTIC within a
 * 6-hour window (same attachment → same URL → the browser's own HTTP
 * cache actually works), which is the fix; routing every row through the
 * same endpoint (rather than only the Zoho-eligible minority) is what
 * makes it apply to the ~91% of rows that were always going to serve from
 * Supabase anyway. See viewAttachment below for which backend a given
 * request actually reads from.
 */
async function isLatestPushedOnOrder(row) {
  if (!row.zoho_document_id) return false;
  // Ordered by `id`, not `uploaded_at` — uploaded_at is a TEXT column
  // holding an ISO string (this app's own convention), and a plain
  // lexicographic sort on it is only correct as long as every row was
  // ever written in that exact format. `id` is auto-increment and
  // therefore a guaranteed-monotonic proxy for insertion order regardless
  // of how any timestamp string happens to be formatted — found the hard
  // way testing this: a row inserted via a differently-formatted
  // timestamp sorted as "earlier" than one uploaded hours before it.
  const latest = await db
    .prepare(
      `SELECT id FROM payment_proofs
        WHERE order_id = ? AND zoho_pushed = true AND deleted_at IS NULL
        ORDER BY id DESC
        LIMIT 1`
    )
    .get(row.order_id);
  return Boolean(latest && latest.id === row.id);
}

function urlsFor(req, row) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const origin = `${proto}://${req.get('host')}`;
  // Deterministic within its window (see attachmentLinkService.js) — the
  // SAME row requested again inside that window gets the SAME token, and
  // therefore the SAME URL, which is the entire point: that's what lets
  // the browser serve a repeat view from its own cache instead of
  // downloading the file again.
  const token = attachmentLink.sign(row.id, row.order_id);
  return {
    viewUrl: `${origin}/api/attachment-view?token=${token}`,
    downloadUrl: `${origin}/api/attachment-view?token=${token}&download=1`
  };
}

// ─── 3a. List every attachment on an order (new) ────────────────────────────

exports.list = async (req, res, next) => {
  try {
    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    // Sep 19, 2026: a deleted attachment (see decideDelete) is a soft
    // delete — the row stays for the trail, but disappears from every list
    // that shows what's actually on the order. Conditional on the column
    // existing yet: pre-migration, nothing can be deleted, so there is
    // nothing to filter.
    const excludeDeleted = await hasColumn('payment_proofs', 'deleted_at');
    const rows = await db
      .prepare(
        `SELECT p.*,
                up.name AS uploaded_by_name,
                vp.name AS verified_by_name
           FROM payment_proofs p
           LEFT JOIN users up ON p.uploaded_by = up.id
           LEFT JOIN users vp ON p.verified_by = vp.id
          WHERE p.order_id = ?${excludeDeleted ? ' AND p.deleted_at IS NULL' : ''}
          ORDER BY p.uploaded_at DESC`
      )
      .all(order.id);

    // Minted per request, short-lived, never stored — same as the old single
    // `get`. A view URL per row is one Supabase (or now, sometimes, one
    // Zoho-link-signing) call each; fine at the scale an order's attachment
    // list actually reaches (a handful of files).
    //
    // Sep 19, 2026: downloadUrl alongside it — "add download feature for all
    // users to download attachments". Same object, just minted with
    // Content-Disposition: attachment so a click saves the file instead of
    // opening it. No role check beyond the one already on this route (order
    // ownership, via loadOrder above) — whoever could already view a file
    // can now also save it.
    // Sep 23, 2026: urlsFor is now a pure, synchronous token-sign — no
    // Supabase/Zoho call happens at list-time any more (that only happens
    // when the URL is actually loaded — see viewAttachment). No more
    // Promise.all needed for it, but the map itself stays simple either way.
    const attachments = rows.map((row) => ({ ...row, ...urlsFor(req, row) }));

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
    const excludeDeleted = await hasColumn('payment_proofs', 'deleted_at');
    const proof = await db
      .prepare(
        `SELECT p.*,
                up.name AS uploaded_by_name,
                vp.name AS verified_by_name
           FROM payment_proofs p
           LEFT JOIN users up ON p.uploaded_by = up.id
           LEFT JOIN users vp ON p.verified_by = vp.id
          WHERE p.order_id = ? AND p.file_type = 'payment_proof'${excludeDeleted ? ' AND p.deleted_at IS NULL' : ''}
          ORDER BY p.uploaded_at DESC
          LIMIT 1`
      )
      .get(req.params.id);

    if (!proof) return notFound(res, 'No proof of payment attached to this order.');

    res.json({ success: true, data: { proof: { ...proof, ...urlsFor(req, proof) } } });
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

// ─── 5. Request deletion of an attachment (Sep 19, 2026) ────────────────────
//
// "the only resubmits from medreps are only message" led to this the same
// way it led to resubmit's own widening — a MedRep who uploaded the wrong
// file, or the wrong order's file, had no way to get rid of it: attachments
// were permanent once created (no DELETE, no soft-delete column, anywhere in
// this file — confirmed before writing this).
//
// This does not delete anything. It only marks the attachment as awaiting a
// decision, the same way a Finance hold is a request rather than an
// action — decideDelete below is the one write that can actually remove it,
// and only Management/admin can call that (requireRole, orders.routes.js).
// Same ownership rule as attaching in the first place (canAttach): the
// MedRep who owns or raised the order, or management/admin.
exports.requestDelete = async (req, res, next) => {
  try {
    if (!(await hasColumn('payment_proofs', 'deletion_status'))) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'MIGRATION_PENDING',
          message: 'Requesting a deletion needs a database update first. Ask IT to run: node src/db/migrate.pg.js'
        }
      });
    }

    const cleanReason = String(req.body?.reason || '').trim();
    if (!cleanReason) return badRequest(res, 'Say why this should be deleted.');
    if (cleanReason.length > 500) {
      return badRequest(res, 'The reason is too long (500 characters at most).');
    }

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    const attachment = await db
      .prepare('SELECT * FROM payment_proofs WHERE id = ? AND order_id = ?')
      .get(req.params.attachmentId, order.id);
    if (!attachment) return notFound(res, 'Attachment not found on this order.');
    if (!canAttach(req.user, order, attachment.file_type)) return forbidden(res, req.user, attachment.file_type);

    if (attachment.deleted_at) {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_DELETED', message: 'This attachment was already deleted.' }
      });
    }
    if (attachment.deletion_status === 'requested') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_REQUESTED', message: 'A deletion request for this attachment is already awaiting Management.' }
      });
    }

    const actor = await resolveActor(req.user, (req.user.role || '').toLowerCase());
    const now = new Date().toISOString();

    await db.transaction(async () => {
      await db
        .prepare(
          `UPDATE payment_proofs
              SET deletion_status = 'requested', deletion_reason = ?, deletion_requested_by = ?, deletion_requested_at = ?,
                  deletion_decided_by = NULL, deletion_decided_at = NULL, deletion_decision_note = NULL
            WHERE id = ?`
        )
        .run(cleanReason, actor.id, now, attachment.id);

      await logEvent({
        orderId: order.id,
        eventType: 'ATTACHMENT_DELETE_REQUESTED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: `Requested deletion of "${attachment.file_name || 'a file'}": ${cleanReason}`,
        metadata: { attachmentId: attachment.id, fileName: attachment.file_name, reason: cleanReason }
      });

      await notify({
        orderId: order.id,
        recipientIds: await getUserIdsByRole('management'),
        message: `Order ${order.getmeds_order_id}: ${actor.name} wants to delete "${attachment.file_name || 'a file'}" — ${cleanReason}`,
        eventType: 'ATTACHMENT_DELETE_REQUESTED',
        orderData: order
      });
    })();

    res.json({ success: true, data: { id: attachment.id, deletion_status: 'requested' } });
  } catch (err) { next(err); }
};

// ─── 6. Management decides a pending deletion request (Sep 19, 2026) ────────
//
// approved -> the attachment is actually removed: the row is soft-deleted
// (deleted_at set, so it drops out of list/get above but the request/
// decision stay on it for the trail) and its storage object is best-effort
// freed. rejected -> nothing is removed; the row goes back to normal, with
// the decision note recorded for the MedRep to read.
//
// Deliberately LOCAL-ONLY. This app has no delete-type Zoho write at
// all (ZohoAdapter.js: "no delete, no void" — addSalesOrderAttachment can
// only ADD one) and building the first one blind, bundled into this, is
// exactly the kind of thing that goes wrong quietly. If the file was
// already pushed to the real Zoho Sales Order (zoho_pushed, set at upload
// time), the response and the trail both say so, so a human removes it
// there on purpose instead of this app guessing at an untested API.
exports.decideDelete = async (req, res, next) => {
  try {
    if (!(await hasColumn('payment_proofs', 'deletion_status'))) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'MIGRATION_PENDING',
          message: 'Deciding a deletion request needs a database update first. Ask IT to run: node src/db/migrate.pg.js'
        }
      });
    }

    const { approved } = req.body || {};
    if (typeof approved !== 'boolean') return badRequest(res, 'approved (true or false) is required.');
    const cleanNote = String(req.body?.note || '').trim() || null;

    const order = await loadOrder(req.params.id);
    if (!order) return notFound(res, 'Order not found');

    const attachment = await db
      .prepare('SELECT * FROM payment_proofs WHERE id = ? AND order_id = ?')
      .get(req.params.attachmentId, order.id);
    if (!attachment) return notFound(res, 'Attachment not found on this order.');

    if (attachment.deletion_status !== 'requested') {
      return res.status(409).json({
        success: false,
        error: { code: 'NOT_AWAITING_DECISION', message: 'No deletion request is awaiting a decision on this attachment.' }
      });
    }

    const actor = await resolveActor(req.user, 'management');
    const now = new Date().toISOString();
    // Set only on approval, and only here — deleted_at is what list/get
    // actually filter on, deletion_status is the human-readable record beside it.
    const stillOnZoho = approved && Boolean(attachment.zoho_pushed) && Boolean(order.zoho_so_id);

    await db.transaction(async () => {
      // Guarded on deletion_status = 'requested' so two Management users
      // deciding at once produce one write, not two conflicting ones.
      const upd = await db
        .prepare(
          `UPDATE payment_proofs
              SET deletion_status = ?, deletion_decided_by = ?, deletion_decided_at = ?, deletion_decision_note = ?,
                  deleted_at = ?
            WHERE id = ? AND deletion_status = 'requested'`
        )
        .run(approved ? 'approved' : 'rejected', actor.id, now, cleanNote, approved ? now : null, attachment.id);

      if (!upd.changes) {
        const conflict = new Error('This deletion request was already decided by someone else.');
        conflict.statusCode = 409;
        conflict.code = 'ALREADY_DECIDED';
        throw conflict;
      }

      await logEvent({
        orderId: order.id,
        eventType: approved ? 'ATTACHMENT_DELETED' : 'ATTACHMENT_DELETE_REJECTED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: actor.id,
        actorName: actor.name,
        notes: approved
          ? `Deleted "${attachment.file_name || 'a file'}" — requested: ${attachment.deletion_reason}` +
            `${cleanNote ? ` · ${cleanNote}` : ''}` +
            `${stillOnZoho ? ` — still on Zoho Sales Order ${order.zoho_so_number || order.zoho_so_id}; not removed there automatically.` : ''}`
          : `Declined to delete "${attachment.file_name || 'a file'}"${cleanNote ? `: ${cleanNote}` : ''}`,
        metadata: {
          attachmentId: attachment.id,
          fileName: attachment.file_name,
          requestReason: attachment.deletion_reason,
          decisionNote: cleanNote,
          stillOnZoho
        }
      });

      if (approved) {
        await proofStorage.removeQuietly(attachment.storage_path);
      }

      await notify({
        orderId: order.id,
        recipientIds: [attachment.deletion_requested_by].filter(Boolean),
        message: approved
          ? `Order ${order.getmeds_order_id}: "${attachment.file_name || 'your file'}" was deleted as requested.`
          : `Order ${order.getmeds_order_id}: your request to delete "${attachment.file_name || 'a file'}" was declined${cleanNote ? `: ${cleanNote}` : ''}.`,
        eventType: approved ? 'ATTACHMENT_DELETED' : 'ATTACHMENT_DELETE_REJECTED',
        orderData: order
      });
    })();

    res.json({
      success: true,
      data: {
        id: attachment.id,
        deletion_status: approved ? 'approved' : 'rejected',
        deleted: approved,
        stillOnZoho,
        zohoSoNumber: order.zoho_so_number || null
      }
    });
  } catch (err) {
    if (err && err.statusCode === 409) {
      return res.status(409).json({
        success: false,
        error: { code: err.code || 'CONFLICT', message: err.message }
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

// ─── 7. Stream an attachment's bytes (Sep 22, 2026, Phase 1; broadened Sep 23) ──
//
// GET /api/attachment-view?token=...&download=1 — mounted OUTSIDE
// requireAuth (see routes/attachmentView.routes.js and
// attachmentLinkService.js's module comment for why: the signed token IS
// the credential, the same trust model this app already used for a
// Supabase signed URL, now applied to every attachment instead of only the
// Zoho-eligible minority — see urlsFor above). Never touches the local
// storage_path in a way that changes anything, and never deletes anything
// — this only reads, from whichever backend actually has this row's file.
exports.viewAttachment = async (req, res, next) => {
  try {
    const claim = attachmentLink.verify(req.query.token);
    if (!claim) {
      return res.status(403).json({
        success: false,
        error: { code: 'INVALID_LINK', message: 'This link has expired — reopen the attachment to get a fresh one.' }
      });
    }

    const attachment = await db
      .prepare(
        `SELECT p.id, p.order_id, p.file_name, p.content_type, p.storage_path, p.zoho_document_id, p.file_size, o.zoho_so_id
           FROM payment_proofs p
           JOIN orders o ON o.id = p.order_id
          WHERE p.id = ? AND p.order_id = ?`
      )
      .get(claim.attachmentId, claim.orderId);

    if (!attachment) return notFound(res, 'Attachment not found.');

    const download = req.query.download === '1' || req.query.download === 'true';
    const name = (attachment.file_name || 'attachment').replace(/["\r\n]/g, '');
    const contentType = attachment.content_type || 'application/octet-stream';

    // Sep 23, 2026 (Priority 2): a thumbnail/preview context asks for a
    // resized rendition via ?w=&h= — OrderDetailsModal's 128px grid cell
    // and PaymentProofPanel's/FinanceQueuePage's inline preview were
    // loading the full original (up to several MB) into a box a few
    // hundred pixels wide, every time, no caching of any smaller variant.
    // Verified live against this project's own Supabase Storage before
    // relying on it: Image Transformations is enabled — see
    // paymentProofStorage.js's downloadFile.
    //
    // Clamped, not trusted outright: this parameter comes from a public,
    // unauthenticated route (the signed token only proves WHICH attachment,
    // not what size is reasonable to ask for). Only meaningful for an
    // image — a PDF/doc's viewUrl+&w= would otherwise ask Supabase to
    // "transform" a file type it cannot, for no reason (nothing in the
    // frontend does this; PaymentProofPanel's own isImage check is what
    // decides whether a thumbnail is ever requested at all — see there for
    // why non-images never get an <img> tag in the first place).
    const clampSize = (v) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 20), 2000) : null;
    };
    const w = clampSize(req.query.w);
    const h = clampSize(req.query.h);
    const isImage = contentType.startsWith('image/');

    // Sep 23, 2026: skip the transform for a file that's already small.
    // Found live during Priority 2 testing — a 20,274-byte source (an
    // already-compressed WebP) came back as a 28,138-byte JPEG at
    // width=1000, LARGER than the original: re-encoding to JPEG at a size
    // close to the source's own has no headroom to win, and can lose to a
    // more efficient source format. The whole point of this endpoint is to
    // cut egress, so it must never trade a small original for a bigger
    // rendition. 150 KB is comfortably above what either target size
    // (300x300 grid thumbnail, 1000px-wide preview) produces for a real
    // photo, so this only ever skips the cases where resizing can't help.
    const SKIP_TRANSFORM_BELOW_BYTES = 150 * 1024;
    const alreadySmall = Number.isFinite(attachment.file_size) && attachment.file_size > 0 && attachment.file_size <= SKIP_TRANSFORM_BELOW_BYTES;
    const transform = (w || h) && isImage && !alreadySmall ? { width: w || undefined, height: h || undefined, resize: 'cover', quality: 75 } : null;

    if (transform) {
      // Thumbnails always come from Supabase — we still hold the local
      // copy regardless of Zoho push status (nothing in this app deletes
      // it; that would be a later phase, not built), and Zoho has no
      // resize capability of its own to route this to even for an
      // otherwise Zoho-eligible row.
      const buffer = await proofStorage.downloadFile(attachment.storage_path, transform);
      res.setHeader('Content-Type', 'image/jpeg'); // Supabase's transform re-encodes to JPEG regardless of source type
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      res.setHeader('Cache-Control', `private, max-age=${attachmentLink.LONG_TTL_SECONDS}`);
      return res.send(buffer);
    }

    // Sep 22, 2026: re-checked here, not just when the link was minted
    // (urlsFor above, or whenever this token's window started) — a link
    // stays valid for attachmentLink's full TTL (6 hours as of Sep 23),
    // long enough for a newer attachment to land on the same order in
    // between. Zoho's own GET only ever serves its single latest
    // attachment (see the correctness note on isLatestPushedOnOrder), so a
    // row that WAS the latest when the link was minted but isn't any more
    // must fall back to Supabase here rather than silently hand back a
    // different file.
    const zohoEligible = attachment.zoho_document_id && attachment.zoho_so_id &&
      (await isLatestPushedOnOrder(attachment));

    if (zohoEligible) {
      try {
        const result = await zoho.getSalesOrderAttachment(attachment.zoho_so_id, attachment.zoho_document_id);
        res.setHeader('Content-Type', result.contentType || contentType);
        res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${result.fileName || name}"`);
        // Sep 23, 2026: shorter than the Supabase branch below on purpose.
        // The TOKEN is what makes repeat requests for this attachment
        // reuse the same URL (see attachmentLinkService.js) — that part is
        // unconditional. Cache-Control is a separate, independent knob for
        // how long the BROWSER trusts a cached response before asking
        // again, and Zoho's answer for a given row can flip from
        // "eligible" to "not" the moment a newer file supersedes it on the
        // same order — a long browser-side cache would then keep serving
        // an increasingly stale answer. Supabase content never changes
        // once uploaded, so that branch gets the full window instead.
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(result.buffer);
      } catch (zohoErr) {
        // Best-effort: Zoho being briefly unreachable must not turn into a
        // broken image when Supabase still has the exact same content.
        console.warn(`[ATTACHMENT_VIEW] Zoho fetch failed for payment_proofs.id=${attachment.id}, falling back to Supabase:`, zohoErr.message);
      }
    }

    const buffer = await proofStorage.downloadFile(attachment.storage_path);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);
    // Sep 23, 2026: the full window, matching the token's own TTL — safe
    // because a payment_proofs row's file is immutable once uploaded (no
    // edit-in-place anywhere in this app; a replacement is always a new
    // row with its own new id and its own new token). This is the change
    // that actually fixes the egress problem: the vast majority of
    // attachments serve from here, not from Zoho.
    res.setHeader('Cache-Control', `private, max-age=${attachmentLink.LONG_TTL_SECONDS}`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
};
