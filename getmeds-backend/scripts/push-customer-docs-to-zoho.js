#!/usr/bin/env node
/**
 * Nov 26, 2026: one-time catch-up — every customer document (BIR 2303, LTO,
 * permits) not yet on its Zoho customer goes there now. New ones go up by
 * themselves from now on (services/customerDocsZoho.js).
 *
 *   node scripts/push-customer-docs-to-zoho.js           # dry run: lists what would be sent
 *   node scripts/push-customer-docs-to-zoho.js --apply   # sends them
 *
 * Safe to run again: each document is sent once (sync_state customer_doc_zoho:<id>).
 * Uses the DATABASE_URL and Zoho settings in .env.
 */
require('dotenv').config();
// Use its own Zoho access token, never the app's shared one.
process.env.ZOHO_SHARED_TOKEN = 'off';

const db = require('../src/db/database');
const { getSyncState } = require('../src/services/syncState');
const { pushCustomerDocsToContact, sentKey } = require('../src/services/customerDocsZoho');

(async () => {
  const apply = process.argv.includes('--apply');
  const customers = await db.prepare(`
    SELECT c.id, c.name, c.zoho_contact_id
      FROM customers c
     WHERE c.zoho_contact_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM customer_documents d WHERE d.customer_id = c.id)
     ORDER BY c.id
  `).all();

  let total = 0;
  for (const c of customers) {
    const docs = await db.prepare('SELECT id, file_name FROM customer_documents WHERE customer_id = ? ORDER BY id').all(c.id);
    const unsent = [];
    for (const d of docs) if (!(await getSyncState(sentKey(d.id)))) unsent.push(d);
    if (!unsent.length) continue;
    total += unsent.length;
    console.log(`${c.name} (contact ${c.zoho_contact_id}): ${unsent.map((d) => d.file_name).join(' | ')}`);
    if (apply) {
      const r = await pushCustomerDocsToContact(c.id);
      console.log(`  -> sent ${r.pushed}, failed ${r.failed}`);
    }
  }
  console.log(apply ? `Done. ${total} document(s) processed.` : `Dry run: ${total} document(s) would be sent. Add --apply to send them.`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
