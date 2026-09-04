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
 */
function buildPath(orderId, getmedsOrderId, contentType, fileName) {
  const safeOrderRef = String(getmedsOrderId || 'order').replace(/[^A-Za-z0-9._-]/g, '');
  return `orders/${orderId}/${safeOrderRef}-${Date.now()}.${extensionFor(contentType, fileName)}`;
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

async function createViewUrl(storagePath, expiresIn = VIEW_URL_TTL_SECONDS) {
  const { data, error } = await client().storage.from(BUCKET).createSignedUrl(storagePath, expiresIn);
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
  try {
    const { error } = await client().storage.from(BUCKET).remove([storagePath]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.warn(`[PAYMENT_PROOF] Could not remove superseded object ${storagePath}: ${err.message}`);
    return false;
  }
}

module.exports = {
  BUCKET,
  MAX_BYTES,
  ALLOWED_TYPES,
  VIEW_URL_TTL_SECONDS,
  buildPath,
  pathPrefixFor,
  validateUpload,
  createUploadUrl,
  createViewUrl,
  removeQuietly,
  _resetClient,
};
