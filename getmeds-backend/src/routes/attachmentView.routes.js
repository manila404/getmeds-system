const express = require('express');
const router = express.Router();
const c = require('../controllers/paymentProof.controller');

/**
 * Sep 22, 2026. Deliberately mounted WITHOUT requireAuth (see app.js) —
 * every other route in this app authenticates with the Bearer token
 * src/api/client.js attaches to every request, but the browser loading an
 * <img src="..."> or following an <a href="..."> download link can never
 * carry a custom header. This route's own signed token (see
 * services/attachmentLinkService.js) is the credential instead, minted
 * INSIDE an authenticated call (paymentProof.controller.js's list/get,
 * both behind requireAuth) — exactly the same trust model this app already
 * uses for a Supabase signed URL, just for a link into its own API instead.
 *
 * Sep 23, 2026: the token is now deterministic within its window, not
 * random per mint — the whole point being that the browser can actually
 * cache the response this route sends back, instead of every view being a
 * fresh URL and therefore a fresh download. See attachmentLinkService.js
 * and paymentProof.controller.js's urlsFor/viewAttachment for why.
 *
 * One route, one purpose: reads a file's bytes, from whichever backend
 * (Zoho or Supabase) actually has this attachment right now. Never writes
 * anything, never deletes anything.
 */
router.get('/', c.viewAttachment);

module.exports = router;
