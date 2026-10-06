'use strict';

/**
 * Proof-of-payment file storage, on Supabase Storage.
 *
 * Sep 4, 2026.
 *
 * ── Why the file never passes through this API ─────────────────────────────
 *
 * The obvious implementation — multer, receive the upload, forward it to
 * storage — cannot work here and fails in a way that passes every local test:
 *
 *   - Vercel caps a function's request+response body at 4.5 MB. A proof-of-payment photo
 *     off a phone camera is routinely 3-8 MB, so roughly half of real uploads
 *     would be rejected by the platform before any of our code ran.
 *   - The serverless filesystem is read-only apart from /tmp, and /tmp is
 *     per-instance and wiped between cold starts.
 *
 * So the browser uploads DIRECTLY to Supabase against a signed URL that this
 * module mints. The API only ever handles the resulting path string. See
 * controllers/pod.controller.js for the two-step handshake.
 *
 * ── Keys ───────────────────────────────────────────────────────────────────
 *
 * SUPABASE_SECRET_KEY is the `sb_secret_...` key from Settings > API Keys.
 * The legacy `service_role` JWT still works in the same position but Supabase
 * is deprecating it by the end of 2026, so new code uses the secret key.
 * Either one bypasses row-level security completely: server-side only, and it
 * must never reach the frontend bundle (no VITE_ prefix, ever).
 *
 * ── The bucket is private ──────────────────────────────────────────────────
 *
 * A payment proof carries a customer name, an amount and often a bank account
 * or reference number. Read access is a short-lived signed URL minted per
 * request; nothing stored in the database is a URL, only the object key.
 */

const { createClient } = require('@supabase/supabase-js');
const db = require('../db/database');
const sanity = require('./sanityStorage');

// The bucket created on Sep 4 is still literally named `pod`. Supabase cannot
// rename a bucket, so this is an env override rather than a hard-coded change:
// point SUPABASE_PROOF_BUCKET at a new bucket whenever one is created, and
// nothing else has to move.
const BUCKET = process.env.SUPABASE_PROOF_BUCKET || 'pod';

/** 15 MB. Generous for a phone photo, small enough to bound the free tier. */
const MAX_BYTES = 15 * 1024 * 1024;

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  // Sep 5, 2026: widened for the 'other' attachment type (a PO, a signed
  // contract, an authorization letter) — a proof of payment is realistically
  // always a photo or a PDF, but "any other file worth attaching to the
  // order" is not. Applies to both types; nothing here distinguishes by
  // file_type, since a scanned Word doc is a perfectly normal proof too.
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** How long a view URL stays valid. Re-minted on every read; never stored. */
const VIEW_URL_TTL_SECONDS = 300;

let _client = null;

function client() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Thrown rather than returned so a misconfigured deploy fails loudly on
    // the first upload instead of silently accepting proofs it cannot store.
    throw new Error(
      'Payment-proof storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY ' +
        '(Supabase dashboard > Settings > API Keys > "Publishable and secret API keys").'
    );
  }

  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** Only used by tests, to force a re-read of the environment. */
function _resetClient() {
  _client = null;
}

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extensionFor(contentType, fileName) {
  const fromName = String(fileName || '').match(/\.([A-Za-z0-9]{1,5})$/);
  if (fromName) return fromName[1].toLowerCase();
  return EXT_BY_TYPE[contentType] || 'bin';
}

/**
 * Where the file lands. Derived entirely server-side from the order — the
 * client proposes a name but never chooses a path, so a caller cannot aim an
 * upload at another order's folder or walk out of the bucket. The controller
 * re-checks the prefix on the way back in, because the signed URL is the only
 * thing standing between the two calls.
 *
 * Sep 5, 2026: `fileType` sorts the object into a subfolder
 * (orders/{id}/payment_proof/..., orders/{id}/other/..., or
 * orders/{id}/purchase_order/... — the latter added Sep 5, 2026 (2)) purely
 * for a human browsing the bucket directly — pathPrefixFor still matches on
 * `orders/{id}/` alone, so the ownership check in the controller is
 * unaffected by which subfolder a file lands in.
 */
const KNOWN_FILE_TYPES = ['payment_proof', 'other', 'purchase_order'];

function buildPath(orderId, getmedsOrderId, contentType, fileName, fileType) {
  const safeOrderRef = String(getmedsOrderId || 'order').replace(/[^A-Za-z0-9._-]/g, '');
  const safeType = KNOWN_FILE_TYPES.includes(fileType) ? fileType : 'payment_proof';
  return `orders/${orderId}/${safeType}/${safeOrderRef}-${Date.now()}.${extensionFor(contentType, fileName)}`;
}

/** The prefix every path for this order must start with. */
function pathPrefixFor(orderId) {
  return `orders/${orderId}/`;
}

function validateUpload({ contentType, fileSize }) {
  if (!ALLOWED_TYPES.includes(contentType)) {
    return `Unsupported file type. Allowed: ${ALLOWED_TYPES.join(', ')}`;
  }
  const size = Number(fileSize);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    return `File is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`;
  }
  return null;
}

async function createUploadUrl(storagePath) {
  const { data, error } = await client().storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error) throw error;
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
}

/**
 * Oct 3, 2026: the Sanity copy of a stored file, or null when it is still only in
 * Supabase. One primary-key lookup. A failed lookup counts as "not in Sanity", so
 * the old Supabase path keeps working if this table is unreachable or missing.
 */
async function sanityAssetFor(storagePath) {
  try {
    return (await db.prepare('SELECT sanity_asset_id, sanity_url, is_image FROM attachment_assets WHERE storage_path = ?').get(storagePath)) || null;
  } catch (err) {
    console.warn(`[ATTACHMENTS] Sanity lookup failed for ${storagePath}: ${err.message}`);
    return null;
  }
}

async function createViewUrl(storagePath, expiresIn = VIEW_URL_TTL_SECONDS) {
  const asset = await sanityAssetFor(storagePath);
  if (asset) return asset.sanity_url;
  const { data, error } = await client().storage.from(BUCKET).createSignedUrl(storagePath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Sep 19, 2026: same signed URL as createViewUrl, but with `download` passed
 * to Supabase — it answers with `Content-Disposition: attachment` instead of
 * inline, so clicking it saves the file under its own name instead of
 * opening in a browser tab. Open and download are two different things a
 * signed URL from this bucket can do; view stays the default everywhere it
 * already was, this is only minted where a caller adds an explicit Download
 * control.
 */
async function createDownloadUrl(storagePath, fileName, expiresIn = VIEW_URL_TTL_SECONDS) {
  const asset = await sanityAssetFor(storagePath);
  if (asset) return sanity.downloadUrl(asset.sanity_url, fileName);
  const { data, error } = await client()
    .storage.from(BUCKET)
    .createSignedUrl(storagePath, expiresIn, { download: fileName || true });
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Best-effort delete of a superseded object. Never allowed to fail a request:
 * an orphaned file in a private bucket costs a few KB, while a failed delete
 * blocking a re-upload would stop a MedRep replacing a rejected proof.
 */
async function removeQuietly(storagePath) {
  if (!storagePath) return false;
  // The Sanity copy first, then the Supabase object (which only exists for files
  // not moved yet, or whose move failed). Each is best-effort on its own.
  const asset = await sanityAssetFor(storagePath);
  if (asset) {
    try {
      if (sanity.isEnabled()) await sanity.deleteAsset(asset.sanity_asset_id);
      await db.prepare('DELETE FROM attachment_assets WHERE storage_path = ?').run(storagePath);
    } catch (err) {
      console.warn(`[ATTACHMENTS] Could not remove Sanity asset for ${storagePath}: ${err.message}`);
    }
  }
  try {
    const { error } = await client().storage.from(BUCKET).remove([storagePath]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`[PAYMENT_PROOF] Could not remove superseded object ${storagePath}: ${err.message}`);
    return false;
  }
}

/**
 * Download a stored file's raw bytes.
 *
 * Sep 8, 2026: every other read in this file hands back a short-lived
 * signed URL instead of the bytes themselves — this is the one place file
 * content actually leaves Supabase through this server, and only because
 * pushing a copy to Zoho's own Sales Order attachment endpoint (see
 * integrations/zoho/*.addSalesOrderAttachment, called from
 * paymentProof.controller.js's attach) needs the file body, not a link to
 * it. Zoho's API has no way to fetch a file FROM a signed URL on our
 * behalf — the bytes have to be in the request we send it.
 *
 * Sep 23, 2026: `transform` added — paymentProof.controller.js's
 * viewAttachment uses it to serve a resized rendition for a
 * thumbnail/preview context (OrderDetailsModal's grid, PaymentProofPanel's
 * inline preview) instead of the original file. Verified live against this
 * project's own Supabase Storage before relying on it: Image
 * Transformations IS enabled here, and `.download(path, { transform })`
 * returns the resized bytes directly — no separate signed-URL detour
 * needed (confirmed against a 20,274-byte source: a 300x300 request came
 * back as a 7,615-byte JPEG). Ignored — silently, by Supabase itself, not
 * by anything here — for a non-image object; this is only ever called with
 * a transform for rows already known to be images (see viewAttachment).
 */
async function downloadFile(storagePath, transform) {
  return (await downloadRendition(storagePath, transform)).buffer;
}

/**
 * The file's bytes, resized when that is possible, plus whether it was resized (a
 * resized rendition is always a JPEG; the original keeps its own type).
 *
 * Oct 6, 2026: only Sanity resizes. A file with no Sanity copy is sent whole from
 * Supabase and never resized there: Supabase bills Image Transformations per distinct
 * original image (100 included on Pro), and the Sep 23 – Oct 3 thumbnails, when every
 * opened image was resized by Supabase, took the project over that limit.
 */
async function downloadRendition(storagePath, transform) {
  const asset = await sanityAssetFor(storagePath);
  if (asset) {
    // Only IMAGE assets can be resized by Sanity; any other file is sent whole.
    const useResize = Boolean(transform && asset.is_image);
    const buffer = await sanity.fetchBytes(useResize
      ? sanity.resizedUrl(asset.sanity_url, { width: transform.width, height: transform.height, quality: transform.quality })
      : asset.sanity_url);
    return { buffer, resized: useResize };
  }
  return { buffer: await downloadFileFromSupabase(storagePath), resized: false };
}

/**
 * Oct 3, 2026: "stage, then move". The browser still uploads to Supabase (a
 * Vercel request is capped at 4.5 MB, so the file cannot pass through this API).
 * Once the upload is confirmed this copies it into Sanity, records the mapping and
 * removes the Supabase object. NEVER throws and never blocks the request: if
 * anything fails the file simply stays in Supabase, where reads still find it.
 * Returns true when the file is now in Sanity.
 */
async function moveToSanityQuietly(storagePath, { contentType, fileName } = {}) {
  if (!sanity.isEnabled() || !storagePath) return false;
  try {
    if (await sanityAssetFor(storagePath)) return true;
    const buffer = await downloadFileFromSupabase(storagePath);
    const up = await sanity.upload(buffer, fileName || storagePath.split('/').pop(), contentType);
    await db
      .prepare('INSERT INTO attachment_assets (storage_path, sanity_asset_id, sanity_url, is_image) VALUES (?, ?, ?, ?)')
      .run(storagePath, up.assetId, up.url, up.isImage);
    // Only after the mapping is saved, so there is never a moment with no copy.
    const { error } = await client().storage.from(BUCKET).remove([storagePath]);
    if (error) console.warn(`[ATTACHMENTS] Moved ${storagePath} to Sanity but could not remove the Supabase copy: ${error.message}`);
    return true;
  } catch (err) {
    console.warn(`[ATTACHMENTS] Could not move ${storagePath} to Sanity (kept in Supabase): ${err.message}`);
    return false;
  }
}

async function downloadFileFromSupabase(storagePath) {
  const { data, error } = await client().storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

module.exports = {
  moveToSanityQuietly,
  BUCKET,
  MAX_BYTES,
  ALLOWED_TYPES,
  VIEW_URL_TTL_SECONDS,
  buildPath,
  pathPrefixFor,
  validateUpload,
  createUploadUrl,
  createViewUrl,
  createDownloadUrl,
  removeQuietly,
  downloadFile,
  downloadRendition,
  _resetClient,
};
