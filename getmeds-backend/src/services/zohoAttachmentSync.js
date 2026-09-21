'use strict';

const db = require('../db/database');
const proofStorage = require('./paymentProofStorage');
const zoho = require('../integrations/zoho');
const { hasColumn } = require('./schemaColumns');

/**
 * Sep 21, 2026: push every local attachment an order already has onto its
 * Zoho Sales Order the moment that Sales Order first exists.
 *
 * paymentProof.controller.js's attach already pushes a NEW upload the
 * instant it lands (zoho.addSalesOrderAttachment) — but only when the order
 * already carries a zoho_so_id. Most attachments don't arrive that late: a
 * MedRep attaches proof of payment while raising the order, well before
 * Management approves it and this app creates the Sales Order in Zoho (see
 * orders.controller.js's syncOrderToZohoAndFinalize), or while a failed sync
 * sits in zohoRetryService's queue. Those files had no zoho_so_id to push to
 * at upload time and nothing ever came back for them — only whatever Dispatch
 * attached afterward (always after the Sales Order exists) reliably reached
 * Zoho. This is the catch-up pass: called once, right after a Sales Order is
 * created, so every attachment already sitting on the order — not just ones
 * uploaded from here on — reaches it in one sweep.
 *
 * Best-effort per file, same shape as the original push: one file failing
 * never blocks the rest or the caller. zoho_pushed is used both to select
 * what still needs sending and to record what succeeded, so re-running this
 * for the same order (e.g. a race between submit and a retry pass) is a
 * no-op for anything already there.
 */
async function pushUnsyncedAttachments(orderId, zohoSoId) {
  if (!orderId || !zohoSoId) return { pushed: 0, failed: 0 };

  const canTrackPushed = await hasColumn('payment_proofs', 'zoho_pushed');
  const canSoftDelete = await hasColumn('payment_proofs', 'deleted_at');

  const conditions = ['order_id = ?'];
  if (canSoftDelete) conditions.push('deleted_at IS NULL');
  if (canTrackPushed) conditions.push('zoho_pushed = false');

  const rows = await db
    .prepare(`SELECT * FROM payment_proofs WHERE ${conditions.join(' AND ')}`)
    .all(orderId);

  let pushed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const buffer = await proofStorage.downloadFile(row.storage_path);
      await zoho.addSalesOrderAttachment(zohoSoId, {
        buffer,
        filename: row.file_name || 'attachment',
        contentType: row.content_type || 'application/octet-stream',
      });
      if (canTrackPushed) {
        await db.prepare('UPDATE payment_proofs SET zoho_pushed = ? WHERE id = ?').run(true, row.id);
      }
      pushed += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[ZOHO_ATTACHMENT_SYNC] could not push payment_proofs.id=${row.id} onto SO ${zohoSoId}:`,
        err.message
      );
    }
  }
  return { pushed, failed };
}

module.exports = { pushUnsyncedAttachments };
