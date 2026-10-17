#!/usr/bin/env node
'use strict';

/**
 * Push Pharmacy-verified prescriptions that never reached their Zoho Sales Order. Oct 17, 2026.
 *
 * WHY: until the fix in pharmacy.controller.js, the push after Verify ran without being
 * awaited, and on Vercel the function can be frozen once the response is sent. About 1 in 5
 * verified prescriptions (44 of 236 in two weeks) kept zoho_pushed = false. This sends those.
 *
 * WHICH: live (not deleted) prescription files with status 'verified' and zoho_pushed = false,
 * on orders that have a Zoho Sales Order, verified in the last --days (default 30).
 *
 * HOW: the same function Verify uses (zohoAttachmentSync.syncVerifiedPrescriptionsToZoho): it
 * downloads the file and ADDS it to the Sales Order's attachments, then records zoho_pushed
 * and the Zoho document id. Nothing is deleted or changed in Zoho. Re-running skips what is
 * already pushed.
 *
 * SAFE BY DEFAULT: without --apply it only reads our database and lists what it would send.
 *
 *   node scripts/backfill-verified-prescriptions.js                 dry run
 *   node scripts/backfill-verified-prescriptions.js --days 14
 *   node scripts/backfill-verified-prescriptions.js --apply --limit 3   try 3 orders for real
 *   node scripts/backfill-verified-prescriptions.js --apply
 */
require('dotenv').config();
const db = require('../src/db/database');
const { syncVerifiedPrescriptionsToZoho } = require('../src/services/zohoAttachmentSync');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPLY = process.argv.includes('--apply');
const DAYS = Number(arg('days', 30));
const LIMIT = Number(arg('limit', 0)) || Infinity;

(async () => {
  await db.init();
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  const rows = await db
    .prepare(
      `SELECT pp.id, pp.order_id, pp.file_name, pp.verified_at, o.getmeds_order_id, o.zoho_so_id, o.zoho_so_number
         FROM payment_proofs pp JOIN orders o ON o.id = pp.order_id
        WHERE pp.file_type = 'prescription' AND pp.status = 'verified' AND pp.deleted_at IS NULL
          AND pp.zoho_pushed = false AND o.zoho_so_id IS NOT NULL AND pp.verified_at >= ?
        ORDER BY pp.verified_at`
    )
    .all(since);

  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, { order: r, ids: [] });
    byOrder.get(r.order_id).ids.push(r.id);
  }
  console.log(`${rows.length} verified prescription file(s) on ${byOrder.size} order(s) not yet on Zoho (last ${DAYS} days).`);
  for (const { order, ids } of byOrder.values()) {
    console.log(`  ${order.getmeds_order_id}  ${order.zoho_so_number}  ${ids.length} file(s)`);
  }
  if (!APPLY) {
    console.log('\nDry run: nothing was sent. Add --apply to push them (use --limit 3 first).');
    process.exit(0);
  }

  let orders = 0, pushed = 0, failed = 0;
  for (const { order, ids } of byOrder.values()) {
    if (orders >= LIMIT) break;
    const res = await syncVerifiedPrescriptionsToZoho(order.order_id, order.zoho_so_id, ids);
    orders += 1; pushed += res.pushed; failed += res.failed;
    console.log(`  ${order.getmeds_order_id}: pushed ${res.pushed}, failed ${res.failed}`);
  }
  console.log(`\nDone: ${orders} order(s), ${pushed} file(s) pushed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
