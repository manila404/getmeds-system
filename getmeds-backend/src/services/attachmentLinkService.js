'use strict';

const crypto = require('crypto');

/**
 * Self-contained links for viewing an attachment straight through this
 * app's own API (see paymentProof.controller.js's viewAttachment,
 * ZohoAdapter.js's getSalesOrderAttachment).
 *
 * Sep 22, 2026. The frontend authenticates every API call with a Bearer
 * token in the Authorization header (src/api/client.js) — fine for a
 * fetch/axios call, but an <img src="..."> or <a href="..."> the browser
 * loads directly can never carry a custom header. Mint a credential INSIDE
 * an authenticated API call (list/get, both already behind requireAuth),
 * embed it in the URL itself, and let the browser load that URL with no
 * further auth needed — see routes/attachmentView.routes.js, mounted
 * outside requireAuth on purpose, because the token IS the credential.
 *
 * Deliberately NOT a JWT: this is a single-purpose, single-claim link
 * (which attachment, until when), and pulling in the JWT library for a
 * three-field HMAC would be more machinery than the job needs.
 *
 * ── Sep 23, 2026: DETERMINISTIC, not random, per call ───────────────────────
 *
 * This started (Sep 22) minting `exp = Date.now() + ttl` — a different
 * value, and therefore a completely different token/URL, on literally every
 * call, even for the exact same attachment a second apart. That defeated
 * the ONE thing that makes a URL cacheable: browsers key their HTTP cache on
 * the full URL string, so a URL that never repeats can never be served from
 * cache, no matter how long the TTL is or what Cache-Control says. This was
 * the actual root cause of a ~9 GB/167 MB (≈54×) gap between what Supabase
 * actually stores and what it billed in egress — every view of an
 * already-seen file was a brand new URL, forcing a brand new full download.
 *
 * `sign()` now rounds the expiry UP to the next fixed-size window boundary
 * (`alignedExpiry`), so every call within the same window — regardless of
 * which request, which component, which browser tab — produces the
 * IDENTICAL token. The browser's own cache then does the rest: the first
 * view within a window costs a real download, every other view of that
 * same attachment within that window costs nothing.
 *
 * TTL bumped accordingly, from 5 minutes to LONG_TTL_SECONDS (6 hours) —
 * safe because a `payment_proofs` row's file is immutable once uploaded
 * (there is no edit-in-place anywhere in this app; a replacement is always
 * a new row with its own new attachment id). A stale VIEW of old content
 * was never the risk; the risk was only ever an old CREDENTIAL still being
 * honoured after it should have stopped working, and the token's own exp
 * check still enforces that.
 */

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  // Thrown lazily (on first sign/verify, not at require time) is not
  // possible here without extra state — but JWT_SECRET is already a
  // required env var everywhere else in this app (see auth.controller.js),
  // so an environment missing it has already failed loudly elsewhere.
  console.warn('[ATTACHMENT_LINK] JWT_SECRET is not set — attachment view links will fail to sign.');
}

/**
 * How long a minted link stays valid, and — because exp is window-aligned,
 * not random — also how big the cache window is: every request for the
 * same attachment inside the same TTL-sized window gets the same URL.
 *
 * Long, deliberately: this is what turns "every view is a fresh multi-MB
 * download" into "one download per attachment per 6-hour window." A
 * shorter window is safer against a leaked link outliving its usefulness,
 * but caching is the entire point of this file as of Sep 23, 2026 — 6h
 * covers a normal shift without forcing a mid-day re-download of files
 * everyone keeps re-opening (Finance's verify checklist, Dispatch's
 * receipt view, a held order reopened).
 */
const LONG_TTL_SECONDS = 6 * 60 * 60;

function hmac(payload) {
  return crypto.createHmac('sha256', SECRET || 'unset').update(payload).digest('base64url');
}

/**
 * The next window boundary at or after now, so every call inside the same
 * window returns the identical value. Epoch-aligned (not calendar-aligned)
 * — simpler, and the exact wall-clock boundary doesn't matter, only that
 * repeated calls within `ttlSeconds` of each other agree on it.
 */
function alignedExpiry(ttlSeconds) {
  const windowMs = ttlSeconds * 1000;
  return Math.ceil(Date.now() / windowMs) * windowMs;
}

/** @returns {string} an opaque, deterministic-within-its-window token encoding {attachmentId, orderId, exp}. */
function sign(attachmentId, orderId, ttlSeconds = LONG_TTL_SECONDS) {
  const exp = alignedExpiry(ttlSeconds);
  const payload = `${attachmentId}.${orderId}.${exp}`;
  const sig = hmac(payload);
  return Buffer.from(`${payload}.${sig}`, 'utf8').toString('base64url');
}

/** @returns {{attachmentId: number, orderId: number} | null} null if invalid, tampered, or expired. */
function verify(token) {
  try {
    const decoded = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 4) return null;
    const [attachmentId, orderId, exp, sig] = parts;
    const payload = `${attachmentId}.${orderId}.${exp}`;
    const expected = hmac(payload);
    // Constant-time comparison — this is a bearer credential, not a
    // display string; a timing side-channel on it is a real weakness.
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() > Number(exp)) return null;
    const attachmentIdNum = Number(attachmentId);
    const orderIdNum = Number(orderId);
    if (!Number.isInteger(attachmentIdNum) || !Number.isInteger(orderIdNum)) return null;
    return { attachmentId: attachmentIdNum, orderId: orderIdNum };
  } catch {
    return null;
  }
}

module.exports = { sign, verify, TTL_SECONDS: LONG_TTL_SECONDS, LONG_TTL_SECONDS, alignedExpiry };
