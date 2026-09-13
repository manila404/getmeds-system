const crypto = require('crypto');
const db = require('../db/database');

/**
 * "Only the first click wins" for the actions that write to Zoho.
 *
 * Sep 12, 2026. Nothing in this app locks an order while someone acts on it:
 * status writes are check-then-write, so two managers pressing Approve at once
 * both pass the check and both create a Sales Order (see chapter 11 of the
 * field guide). The new Finance and Dispatch buttons each make a real change
 * in Zoho, so the same race would mean two invoices, two packages or two
 * shipments.
 *
 * A claim is a conditional UPDATE: it succeeds only if the order is still at a
 * status the action expects AND nobody else holds a fresh claim. The database
 * reports how many rows changed, so exactly one of two simultaneous callers
 * gets `changes === 1`. The loser is told who got there first.
 *
 * Claims go stale after CLAIM_TTL_MS so a request that died half-way (a
 * serverless function killed mid-call) cannot lock an order forever.
 */
const CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * @param {number} orderId
 * @param {string[]} expectedStatuses - the statuses this action may start from
 * @param {string} label - what is being done and by whom, shown to a second clicker
 * @returns {Promise<string|null>} a claim token, or null if the order is not claimable
 */
async function claimOrder(orderId, expectedStatuses, label) {
  const token = `${label}|${crypto.randomUUID()}`;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const res = await db
    .prepare(
      `UPDATE orders SET action_claim = ?, action_claim_at = ?
        WHERE id = ? AND status = ANY(?)
          AND (action_claim IS NULL OR action_claim_at < ?)`
    )
    .run(token, now.toISOString(), orderId, expectedStatuses, staleBefore);
  return res.changes === 1 ? token : null;
}

/** Drop a claim, but only if it is still ours. Safe to call twice. */
async function releaseClaim(orderId, token) {
  if (!token) return;
  await db
    .prepare('UPDATE orders SET action_claim = NULL, action_claim_at = NULL WHERE id = ? AND action_claim = ?')
    .run(orderId, token);
}

/** The human-readable part of a claim token: "Create invoice by Ben Ramos". */
function describeClaim(token) {
  return token ? String(token).split('|')[0] : null;
}

module.exports = { claimOrder, releaseClaim, describeClaim, CLAIM_TTL_MS };
