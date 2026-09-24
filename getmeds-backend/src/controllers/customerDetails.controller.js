'use strict';

/**
 * Client Details — the Clients Directory's detail modal.
 *
 * Sep 24, 2026.
 *
 *   GET    /api/customers/:id/details                 the customer, read live from Zoho
 *   POST   /api/customers/:id/documents/upload-url    step 1 of an upload
 *   POST   /api/customers/:id/documents               step 2: record it
 *   GET    /api/customers/:id/documents/:docId/url    a fresh link to open one
 *   DELETE /api/customers/:id/documents/:docId
 *
 * ── Reading ────────────────────────────────────────────────────────────────
 * On demand, per customer, the moment somebody opens the modal — not synced in
 * bulk. The directory holds ~95,000 customers and most of these fields (licence
 * dates, LTO type, company id, both addresses) are not stored locally at all;
 * pulling them for everyone would be ~95,000 Zoho calls for data almost nobody
 * looks at. Read-only towards Zoho: nothing here writes to a contact. If Zoho
 * cannot be reached, the modal still opens on what is stored locally and says
 * so, rather than failing.
 *
 * ── Documents ──────────────────────────────────────────────────────────────
 * Up to 10 per customer, 10 MB each. They are stored in GetMeds' own private
 * storage, NOT attached to the contact in Zoho — this app's Zoho access does
 * not include writing files to a contact, and the modal says where they live.
 *
 * Same two-step handshake as order attachments, for the same reason: a 10 MB
 * file cannot pass through a serverless function (4.5 MB request cap), so the
 * browser uploads straight to storage against a signed URL and the API only
 * ever handles the resulting path.
 */

const db = require('../db/database');
const zoho = require('../integrations/zoho');
const storage = require('../services/paymentProofStorage');
const { mapZohoContact, mapLocalCustomer } = require('../services/customerDetailsService');

const MAX_DOCUMENTS = 10;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const notFound = (res) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });

const bad = (res, code, message, status = 400) =>
  res.status(status).json({ success: false, error: { code, message } });

async function loadCustomer(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  return await db.prepare('SELECT * FROM customers WHERE id = ?').get(n);
}

const listDocuments = async (customerId) =>
  await db
    .prepare(
      `SELECT d.id, d.file_name, d.content_type, d.file_size, d.created_at, u.name AS uploaded_by_name
         FROM customer_documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.customer_id = ?
        ORDER BY d.id`
    )
    .all(customerId);

/** GET /api/customers/:id/details */
const getDetails = async (req, res, next) => {
  try {
    const customer = await loadCustomer(req.params.id);
    if (!customer) return notFound(res);

    let fields;
    let source = 'local';
    let zohoError = null;

    if (customer.zoho_contact_id) {
      try {
        const result = await zoho.getContact(customer.zoho_contact_id);
        if (result && result.contact) {
          fields = mapZohoContact(result.contact);
          source = 'zoho';
        } else {
          zohoError = 'Zoho returned no contact for this customer.';
        }
      } catch (err) {
        console.warn(`[CUSTOMER_DETAILS] getContact failed for ${customer.zoho_contact_id}: ${err.message}`);
        zohoError = err.message || 'Could not reach Zoho.';
      }
    }
    if (!fields) fields = mapLocalCustomer(customer);

    res.json({
      success: true,
      data: {
        id: customer.id,
        source,
        zoho_contact_id: customer.zoho_contact_id || null,
        // Set when a Zoho read was expected and did not happen, so the modal can
        // say the values on screen are the stored ones.
        zoho_error: zohoError,
        zoho_sync_status: customer.zoho_sync_status || null,
        is_active: customer.is_active === 1 || customer.is_active === true,
        type: customer.type,
        ...fields,
        documents: await listDocuments(customer.id),
        document_limits: { max_documents: MAX_DOCUMENTS, max_bytes: MAX_DOCUMENT_BYTES },
      },
    });
  } catch (err) {
    next(err);
  }
};

const safeName = (name) => String(name || 'document').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
const pathPrefix = (customerId) => `customers/${customerId}/documents/`;

/** Validates what a file's own description claims; used by both steps of an upload. */
function checkFile({ file_name: fileName, content_type: contentType, file_size: fileSize }) {
  if (!fileName || typeof fileName !== 'string') return 'file_name is required.';
  if (!storage.ALLOWED_TYPES.includes(contentType)) {
    return `Unsupported file type. Allowed: PDF, images (JPG, PNG, WebP, HEIC), Word and Excel.`;
  }
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) return 'file_size is required.';
  if (size > MAX_DOCUMENT_BYTES) return `That file is over the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit.`;
  return null;
}

const documentCount = async (customerId) =>
  Number((await db.prepare('SELECT COUNT(*) AS n FROM customer_documents WHERE customer_id = ?').get(customerId)).n);

const fullMessage = `This customer already has ${MAX_DOCUMENTS} documents, the most it can hold. Delete one to add another.`;

/** POST /api/customers/:id/documents/upload-url */
const getUploadUrl = async (req, res, next) => {
  try {
    const customer = await loadCustomer(req.params.id);
    if (!customer) return notFound(res);

    const problem = checkFile(req.body || {});
    if (problem) return bad(res, 'VALIDATION_ERROR', problem);
    if ((await documentCount(customer.id)) >= MAX_DOCUMENTS) return bad(res, 'DOCUMENT_LIMIT', fullMessage, 409);

    const storagePath = `${pathPrefix(customer.id)}${Date.now()}-${safeName(req.body.file_name)}`;
    const { signedUrl } = await storage.createUploadUrl(storagePath);
    res.json({ success: true, data: { signedUrl, storagePath } });
  } catch (err) {
    next(err);
  }
};

/** POST /api/customers/:id/documents */
const attachDocument = async (req, res, next) => {
  try {
    const customer = await loadCustomer(req.params.id);
    if (!customer) return notFound(res);

    const body = req.body || {};
    const problem = checkFile(body);
    if (problem) return bad(res, 'VALIDATION_ERROR', problem);

    // The signed URL was the only thing tying the two calls together, so the
    // path is re-checked: it has to be inside THIS customer's folder.
    const storagePath = String(body.storage_path || '');
    if (!storagePath.startsWith(pathPrefix(customer.id)) || storagePath.includes('..')) {
      return bad(res, 'VALIDATION_ERROR', 'That upload does not belong to this customer.');
    }
    if ((await documentCount(customer.id)) >= MAX_DOCUMENTS) {
      await storage.removeQuietly(storagePath);
      return bad(res, 'DOCUMENT_LIMIT', fullMessage, 409);
    }

    const result = await db
      .prepare(
        `INSERT INTO customer_documents (customer_id, storage_path, file_name, content_type, file_size, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(customer.id, storagePath, body.file_name.trim(), body.content_type, Math.round(Number(body.file_size)), req.user.id);

    const doc = await db
      .prepare(
        `SELECT d.id, d.file_name, d.content_type, d.file_size, d.created_at, u.name AS uploaded_by_name
           FROM customer_documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`
      )
      .get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: { document: doc } });
  } catch (err) {
    next(err);
  }
};

async function loadDocument(req) {
  const docId = parseInt(req.params.docId, 10);
  const customerId = parseInt(req.params.id, 10);
  if (!Number.isInteger(docId) || !Number.isInteger(customerId)) return null;
  return await db
    .prepare('SELECT * FROM customer_documents WHERE id = ? AND customer_id = ?')
    .get(docId, customerId);
}

/** GET /api/customers/:id/documents/:docId/url — a fresh, short-lived link. */
const getDocumentUrl = async (req, res, next) => {
  try {
    const doc = await loadDocument(req);
    if (!doc) return bad(res, 'NOT_FOUND', 'Document not found', 404);
    const url = await storage.createViewUrl(doc.storage_path);
    res.json({ success: true, data: { url, file_name: doc.file_name } });
  } catch (err) {
    next(err);
  }
};

/** DELETE /api/customers/:id/documents/:docId */
const deleteDocument = async (req, res, next) => {
  try {
    const doc = await loadDocument(req);
    if (!doc) return bad(res, 'NOT_FOUND', 'Document not found', 404);
    await db.prepare('DELETE FROM customer_documents WHERE id = ?').run(doc.id);
    await storage.removeQuietly(doc.storage_path);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  getDetails,
  getUploadUrl,
  attachDocument,
  getDocumentUrl,
  deleteDocument,
};
