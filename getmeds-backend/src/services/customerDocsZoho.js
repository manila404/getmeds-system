'use strict';

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const proofStorage = require('./paymentProofStorage');
const { hasColumn } = require('./schemaColumns');
const { getSyncState, setSyncState } = require('./syncState');

/**
 * Nov 26, 2026: a customer's documents (BIR 2303, LTO permit, business
 * permit — table customer_documents) onto the customer itself in Zoho, the
 * paperclip on the customer's page.
 *
 * Until now they only reached Zoho on the customer's first Sales Order
 * (zohoAttachmentSync.pushCustomerDocuments, Nov 25), so Finance opening the
 * customer in Zoho found nothing (Binakayan Hospital, Nov 26). They now go up:
 *   - when Management pushes a pending customer to Zoho (customerCreateService),
 *   - when Management links a pending customer to one Zoho already has,
 *   - when a document is added to a customer that is already in Zoho,
 *   - and once for older customers, by scripts/push-customer-docs-to-zoho.js.
 *
 * Each document goes up once. What was sent is kept in sync_state under
 * `customer_doc_zoho:<document id>` (the Zoho document id), so no database
 * change is needed and running this again sends nothing twice.
 *
 * Best-effort: one file failing never blocks the rest or the caller.
 */
const sentKey = (docId) => `customer_doc_zoho:${docId}`;
const zohoFileName = (name) => String(name || 'attachment').replace(/\.jfif$/i, '.jpg');

async function pushCustomerDocsToContact(customerId, { adapter = zoho, log = console } = {}) {
  if (!customerId) return { pushed: 0, failed: 0, skipped: 0 };
  if (!(await hasColumn('customer_documents', 'customer_id'))) return { pushed: 0, failed: 0, skipped: 0 };
  const customer = await db.prepare('SELECT id, name, zoho_contact_id FROM customers WHERE id = ?').get(customerId);
  if (!customer || !customer.zoho_contact_id) return { pushed: 0, failed: 0, skipped: 0 };

  const docs = await db.prepare('SELECT * FROM customer_documents WHERE customer_id = ? ORDER BY id').all(customer.id);
  let pushed = 0;
  let failed = 0;
  let skipped = 0;
  for (const doc of docs) {
    if (await getSyncState(sentKey(doc.id))) { skipped += 1; continue; }
    try {
      const buffer = await proofStorage.downloadFile(doc.storage_path);
      const res = await adapter.addContactAttachment(customer.zoho_contact_id, {
        buffer,
        filename: zohoFileName(doc.file_name),
        contentType: doc.content_type || 'application/octet-stream',
      });
      await setSyncState(sentKey(doc.id), (res && res.document && res.document.document_id) || 'sent');
      pushed += 1;
    } catch (err) {
      failed += 1;
      log.warn(`[CUSTOMER_DOCS_ZOHO] could not attach customer_documents.id=${doc.id} (${doc.file_name}) to contact ${customer.zoho_contact_id}:`, err.message);
    }
  }
  return { pushed, failed, skipped };
}

/** Same, never throwing — for callers whose own work must not fail because of it. */
async function pushCustomerDocsQuietly(customerId) {
  try {
    return await pushCustomerDocsToContact(customerId);
  } catch (err) {
    console.warn(`[CUSTOMER_DOCS_ZOHO] customer ${customerId}:`, err.message);
    return { pushed: 0, failed: 0, skipped: 0 };
  }
}

module.exports = { pushCustomerDocsToContact, pushCustomerDocsQuietly, sentKey };
