#!/usr/bin/env node
/**
 * One-off catch-up: push every local attachment that already sits on an
 * order with a real Zoho Sales Order (zoho_so_id) but never reached it.
 *
 * Sep 21, 2026. services/zohoAttachmentSync.js's pushUnsyncedAttachments is
 * now called the moment a Sales Order is FIRST created (orders.controller.js,
 * zohoRetryService.js) — but that only catches attachments from here on. Any
 * order whose Sales Order already existed before that fix shipped, with a
 * proof of payment attached earlier and never pushed (the MedRep-uploads-
 * before-approval gap described in that change), is not touched by it. This
 * script is the one-time sweep for those.
 *
 * ── WHAT IT TOUCHES ──────────────────────────────────────────────────────────
 * Only payment_proofs rows where the parent order already has a zoho_so_id
 * and the row is not already marked zoho_pushed. Nothing else. Every push
 * goes through the exact same zoho.addSalesOrderAttachment call the live app
 * uses — this is not a simulation.
 *
 * ── SAFE TO REPEAT ───────────────────────────────────────────────────────────
 * Only ever sends a file once: a successful push sets zoho_pushed = true, so
 * re-running this (e.g. after fixing a few failures) skips everything already
 * sent and only retries what's left.
 *
 * ── NO UNDO ──────────────────────────────────────────────────────────────────
 * This app has no delete-type Zoho write (see ZohoAdapter.js) — a file pushed
 * to the wrong Sales Order cannot be removed through this app, only by hand in
 * Zoho. Report-only by default for that reason; nothing is sent without --yes.
 *
 *   node scripts/backfill-zoho-attachments.js          # report only
 *   node scripts/backfill-zoho-attachments.js --yes    # actually push
 */
require('dotenv').config();
// Share the database politely: this is a bulk job, and the deployed app is on
// the same Supabase pooler. See lib/batch-job.js.
require('./lib/batch-job');

const db = require('../src/db/database');
const { pushUnsyncedAttachments } = require('../src/services/zohoAttachmentSync');
const { hasColumn } = require('../src/services/schemaColumns');

const confirmed = process.argv.includes('--yes');
const num = (n) => n.toLocaleString();

(async () => {
  const canTrackPushed = await hasColumn('payment_proofs', 'zoho_pushed');
  const canSoftDelete = await hasColumn('payment_proofs', 'deleted_at');
  if (!canTrackPushed) {
    console.log(
      '\npayment_proofs.zoho_pushed does not exist yet — run `node src/db/migrate.pg.js` first, ' +
        'then re-run this script.\n'
    );
    await db.close();
    return;
  }

  const conditions = ['o.zoho_so_id IS NOT NULL', 'p.zoho_pushed = false'];
  if (canSoftDelete) conditions.push('p.deleted_at IS NULL');

  const rows = await db
    .prepare(
      `SELECT p.id AS proof_id, p.order_id, p.file_name, p.file_type,
              o.getmeds_order_id, o.zoho_so_id, o.zoho_so_number
         FROM payment_proofs p
         JOIN orders o ON o.id = p.order_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY o.id, p.id`
    )
    .all();

  if (!rows.length) {
    console.log('\nNothing to push — every attachment on every synced order already reached Zoho.\n');
    await db.close();
    return;
  }

  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) {
      byOrder.set(r.order_id, {
        getmeds_order_id: r.getmeds_order_id,
        zoho_so_id: r.zoho_so_id,
        zoho_so_number: r.zoho_so_number,
        files: []
      });
    }
    byOrder.get(r.order_id).files.push(r);
  }

  console.log(`\n${num(rows.length)} attachment(s) across ${num(byOrder.size)} order(s) never reached Zoho:\n`);
  for (const [, info] of byOrder) {
    const names = info.files.map((f) => f.file_name || `#${f.proof_id}`).join(', ');
    console.log(`  ${info.getmeds_order_id}  (SO ${info.zoho_so_number || info.zoho_so_id})  —  ${names}`);
  }

  if (!confirmed) {
    console.log(`\nReport only — nothing sent to Zoho. Re-run with --yes to push these ${num(rows.length)} file(s).\n`);
    await db.close();
    return;
  }

  console.log('\nPushing…\n');
  let totalPushed = 0;
  let totalFailed = 0;
  for (const [orderId, info] of byOrder) {
    const result = await pushUnsyncedAttachments(orderId, info.zoho_so_id);
    console.log(`  ${info.getmeds_order_id}: pushed ${result.pushed}, failed ${result.failed}`);
    totalPushed += result.pushed;
    totalFailed += result.failed;
  }

  console.log(`\n✅ ${num(totalPushed)} pushed, ${num(totalFailed)} failed.\n`);
  if (totalFailed) {
    console.log('Failures were logged above ([ZOHO_ATTACHMENT_SYNC]) — re-run this script to retry only those; already-pushed files are skipped automatically.\n');
  }
  await db.close();
})().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
