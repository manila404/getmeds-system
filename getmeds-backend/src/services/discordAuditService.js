'use strict';

/**
 * Mirrors the order audit trail into Discord: one thread per order, named with
 * its Getmeds order id, and one post per event.
 *
 * Sep 13, 2026.
 *
 * ── WHAT GOES TO DISCORD ─────────────────────────────────────────────────────
 *
 * Who did what, and when: the event, the status change, the person's name and
 * role, and the time. Never `notes` or `metadata`. Those carry customer names,
 * amounts and payment references, and anyone who can read the channel reads
 * the thread. auditService.js does not even hand them over.
 *
 * ── WHICH EVENTS ─────────────────────────────────────────────────────────────
 *
 * Events that happen from now on, on orders raised in this app.
 *
 *   * Backfilled events are skipped. logEvent gets `occurredAt` only when Zoho
 *     history is being replayed, and one import run writes thousands of those;
 *     posting them would bury the channel in the past.
 *   * Imported orders (ZOHO-…) are skipped: finished business that lives in
 *     Zoho. Same rule as the Finance queue, from services/orderOrigin.js.
 *
 * ── WHY IT CANNOT HURT AN ORDER ──────────────────────────────────────────────
 *
 * logEvent calls this through db.afterCommit, so nothing is posted for an event
 * a rollback then undid, and nothing here runs inside the order's transaction.
 * Every failure is logged and swallowed. Posts for one order are chained, so
 * its thread is started once and its events arrive in the order they happened.
 */

const db = require('../db/database');
const discord = require('../integrations/discord');
const { isImportedRef } = require('./orderOrigin');

// medrep reads "Salesperson": that is what the role is being renamed to.
const ROLE_LABELS = { medrep: 'Salesperson', finance: 'Finance', dispatch: 'Dispatch', management: 'Management', admin: 'Admin' };
const COLOR = 0x1f3864;
const ROLE_TTL_MS = 10 * 60 * 1000;

const WORDS = { zoho: 'Zoho', so: 'Sales Order', gm: 'GM', id: 'ID' };
const PHRASES = { picking_packing: 'Picking and packing' };

/** PAYMENT_PROOF_UPLOADED -> "Payment proof uploaded", ZOHO_SO_EDITED -> "Zoho Sales Order edited". */
function humanize(code) {
  const key = String(code || '').toLowerCase();
  if (PHRASES[key]) return PHRASES[key];
  const words = key.split('_').filter(Boolean).map((w) => WORDS[w] ?? w);
  if (!words.length) return '';
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

/** The first message in the channel, which the order's thread hangs off. */
function starterPayload(order) {
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: String(order.getmeds_order_id).slice(0, 256),
      description: 'Audit trail. Every step on this order is posted in its thread.',
      color: COLOR,
    }],
  };
}

/** One audit event, as a post in the thread. Only the fields named here can reach Discord. */
function eventPayload(event, role) {
  const change = event.oldStatus && event.newStatus && event.oldStatus !== event.newStatus
    ? `${humanize(event.oldStatus)} → ${humanize(event.newStatus)}`
    : event.newStatus ? `Status: ${humanize(event.newStatus)}` : null;
  const who = event.actorName
    ? `${String(event.actorName).slice(0, 200)}${role ? ` · ${ROLE_LABELS[role] ?? humanize(role)}` : ''}`
    : 'System';
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: humanize(event.eventType).slice(0, 256),
      ...(change ? { description: change } : {}),
      color: COLOR,
      footer: { text: who },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** Where threads are remembered, and what an event needs to look up. Swappable for tests. */
function createStore(database = db) {
  const roles = new Map();   // actorId -> { role, at }
  return {
    order: (orderId) => database.prepare('SELECT id, getmeds_order_id FROM orders WHERE id = ?').get(orderId),
    async actorRole(actorId) {
      const hit = roles.get(actorId);
      if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.role;
      const row = await database.prepare('SELECT role FROM users WHERE id = ?').get(actorId);
      roles.set(actorId, { role: row?.role ?? null, at: Date.now() });
      return row?.role ?? null;
    },
    thread: (orderId) => database.prepare('SELECT starter_message_id, thread_id FROM order_audit_threads WHERE order_id = ?').get(orderId),
    saveThread: (orderId, starterMessageId, threadId) => database.prepare(
      `INSERT INTO order_audit_threads (order_id, starter_message_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT (order_id) DO UPDATE SET starter_message_id = EXCLUDED.starter_message_id, thread_id = EXCLUDED.thread_id`
    ).run(orderId, starterMessageId, threadId),
  };
}

function createAuditMirror({ store = createStore(), transport = discord } = {}) {
  const lines = new Map();   // orderId -> the promise its next post waits on
  let missingTable = false;

  async function ensureThread(order) {
    const known = await store.thread(order.id);
    if (known?.thread_id) return known.thread_id;
    // The starter is saved before the thread is started, so a failure between
    // the two retries on the same message rather than posting a second one.
    let starterId = known?.starter_message_id;
    if (!starterId) {
      starterId = (await transport.post(starterPayload(order))).messageId;
      await store.saveThread(order.id, starterId, null);
    }
    const thread = await transport.startThread(starterId, order.getmeds_order_id);
    await store.saveThread(order.id, starterId, thread.id);
    return thread.id;
  }

  async function deliver(event) {
    const order = await store.order(event.orderId);
    if (!order || isImportedRef(order.getmeds_order_id)) return 'skipped';
    const role = event.actorId ? await store.actorRole(event.actorId) : null;
    const payload = eventPayload(event, role);

    if (transport.mode === 'mock') {
      const e = payload.embeds[0];
      console.log(`[DISCORD_MOCK] ${order.getmeds_order_id} thread: ${e.title}${e.description ? ` · ${e.description}` : ''} · ${e.footer.text}`);
      await transport.post(payload, { threadId: `mock:${order.getmeds_order_id}` });
      return 'mocked';
    }

    const threadId = await ensureThread(order);
    await transport.post(payload, { threadId });
    return 'posted';
  }

  /** Resolves to 'posted', 'mocked', 'skipped', 'backfill', 'off' or 'failed'. Never rejects. */
  function mirror(event) {
    if (!transport.enabled || missingTable) return Promise.resolve('off');
    if (event.occurredAt) return Promise.resolve('backfill');

    const previous = lines.get(event.orderId) ?? Promise.resolve();
    const next = previous.then(() => deliver(event)).catch((err) => {
      if (err.code === '42P01') {   // undefined_table
        missingTable = true;
        console.warn('[DISCORD] order_audit_threads does not exist yet. Run `npm run migrate:pg`, then restart; audit threads are paused until then.');
      } else {
        console.warn(`[DISCORD] audit event ${event.eventType} for order ${event.orderId} not posted: ${err.message}`);
      }
      return 'failed';
    });
    lines.set(event.orderId, next);
    next.then(() => { if (lines.get(event.orderId) === next) lines.delete(event.orderId); });
    return next;
  }

  return { mirror };
}

let _mirror = null;

/** What auditService.logEvent calls, after the event is committed. */
function mirrorAuditEvent(event) {
  if (!_mirror) _mirror = createAuditMirror();
  return _mirror.mirror(event);
}

module.exports = { mirrorAuditEvent, createAuditMirror, createStore, eventPayload, starterPayload, humanize, ROLE_LABELS };
