const db = require('../db/database');
const { mirrorAuditEvent } = require('./discordAuditService');
const { hasColumn } = require('./schemaColumns');
const { isCovered, noteSkipped } = require('./orderEventCoverage');

// 1. Prepare the statement once at module load for better performance
// Sep 10, 2026: `created_at` is now a parameter rather than 'now'.
//
// It was hard-coded, which is why the trail on an imported order read as a log
// of when this app last synced: an order raised on 31 Jan showed Confirmed,
// Invoice Sent, Payment Received and Packed all at 08:08 on 10 Sep. Zoho knows
// when each of those actually happened and hands us the dates; there was
// simply nowhere to put them.
//
// Callers that do not pass one still get 'now', which is correct for anything
// a person does IN this app — see logEvent's `occurredAt`.
//
// Sep 18, 2026: NOT a single fixed statement any more — actor_role is a new,
// not-yet-guaranteed-migrated column (see schemaColumns.js), so the column
// list is built per call depending on whether it exists yet. The SQL text is
// still cheap to build (this runs once per user action, never in a bulk
// loop like the 500-row customer sync), and until the migration runs this
// simply falls back to the nine columns it always wrote.
const BASE_EVENT_COLUMNS = ['order_id', 'event_type', 'old_status', 'new_status', 'actor_id', 'actor_name', 'notes', 'metadata', 'created_at'];

/**
 * Log an order event to the order_events audit table.
 * 
 * @param {Object} params - The event details.
 * @param {number|string} params.orderId - Required. The ID of the order.
 * @param {string} params.eventType - Required. The type of event.
 * @param {string} [params.oldStatus] - The previous status.
 * @param {string} [params.newStatus] - The new status.
 * @param {number|string} [params.actorId] - ID of the user performing the action.
 * @param {string} [params.actorName] - Name of the user.
 * @param {string} [params.actorRole] - The actor's role AT THE TIME (Sep 18,
 *   2026) — 'medrep'/'finance'/'dispatch'/'management'/'admin'. Almost never
 *   needs to be passed explicitly: when omitted, this looks it up from
 *   actorId's CURRENT role, which is correct for the overwhelming case (the
 *   role they're acting in right now, at the moment the action happens).
 *   Pass it only when a caller already resolved a different actor than the
 *   request's own req.user (e.g. TEST_MODE's resolveActor swap) and wants to
 *   skip the extra lookup — resolveActor's return value already carries
 *   `.role`.
 * @param {string} [params.notes] - Additional context.
 * @param {Object} [params.metadata] - Extra data to be stored as JSON.
 * @param {string} [params.occurredAt] - ISO timestamp of when the event
 *   actually happened. Omit for anything a person does in this app; pass
 *   Zoho's own date when backfilling something that happened there.
 * @param {boolean} [params.occurredAtExact] - Does `occurredAt` carry a real
 *   time, or is it a bare Zoho date floored to midnight (see zohoDates.js
 *   and schema.pg.sql's comment on order_events.occurred_at_exact)? Defaults
 *   true — correct for every caller except zohoReconcileService.js's
 *   invoice/package/shipment backfills, which pass false explicitly.
 */
async function logEvent(
  { orderId, eventType, oldStatus, newStatus, actorId, actorName, actorRole, notes, metadata, occurredAt, occurredAtExact }
) {
  // 2. Validate required fields
  if (!orderId || !eventType) {
    throw new Error('orderId and eventType are required to log an event.');
  }

  // Sep 26, 2026: an event dated before the oldest partition (Zoho history from 2023)
  // cannot be stored, and one refused insert used to fail the whole Zoho reconcile.
  // That history was dropped on purpose, so it is left out rather than raised.
  if (occurredAt && !(await isCovered(occurredAt))) {
    noteSkipped(`A ${eventType} event for order ${orderId}`);
    return;
  }

  try {
    let role = actorRole || null;
    if (!role && actorId) {
      try {
        const actorRow = await db.prepare('SELECT role FROM users WHERE id = ?').get(actorId);
        role = actorRow?.role || null;
      } catch (_) {
        role = null; // a lookup hiccup must not block the event itself
      }
    }
    const canWriteRole = role && (await hasColumn('order_events', 'actor_role'));
    // occurredAtExact defaults true (omitted entirely means "a real time"),
    // so this only needs to WRITE the column when a caller passed false —
    // the column's own DB default already covers every other case, and
    // skipping the write when there's nothing non-default to say keeps this
    // column list from growing on every single logEvent call.
    const canWriteExactness = occurredAtExact === false && (await hasColumn('order_events', 'occurred_at_exact'));

    // 3. Build the column list (see BASE_EVENT_COLUMNS' note on why this is
    //    per-call rather than one fixed prepared statement).
    // 4. Use '??' instead of '||' to preserve falsy values like 0 or ""
    const columns = [...BASE_EVENT_COLUMNS];
    if (canWriteRole) columns.push('actor_role');
    if (canWriteExactness) columns.push('occurred_at_exact');
    const values = [
      orderId,
      eventType,
      oldStatus ?? null,
      newStatus ?? null,
      actorId ?? null,
      actorName ?? null,
      notes ?? null,
      metadata ? JSON.stringify(metadata) : null,
      // When it HAPPENED, not when we heard about it. Defaults to now, which
      // is right for an action taken in this app and wrong for one backfilled
      // from Zoho — see the note on BASE_EVENT_COLUMNS above.
      occurredAt || new Date().toISOString()
    ];
    if (canWriteRole) values.push(role);
    if (canWriteExactness) values.push(false);

    await db
      .prepare(`INSERT INTO order_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...values);

    // Sep 13, 2026: mirror to the order's Discord thread once the event is
    // committed (services/discordAuditService.js). Only who, what and when are
    // handed over: notes and metadata can hold customer details, so they are
    // not passed at all. A no-op unless DISCORD_AUDIT_ENABLED=true.
    db.afterCommit(() => mirrorAuditEvent({ orderId, eventType, oldStatus, newStatus, actorId, actorName, occurredAt }));
  } catch (error) {
    // 5. Handle potential database errors (e.g., constraint violations)
    console.error(`Failed to log order event for orderId: ${orderId}`, error);
    throw error;
  }
}

const { isTestModeEnabled } = require('../middleware/testMode');

const SEEDED_ROLES = {
  medrep: { email: 'medrep@getmeds.ph', defaultName: 'Juan dela Cruz (MedRep)' },
  finance: { email: 'finance@getmeds.ph', defaultName: 'Rosa Reyes (Finance)' },
  dispatch: { email: 'dispatch@getmeds.ph', defaultName: 'Danilo Santos (Dispatch)' },
  management: { email: 'manager@getmeds.ph', defaultName: 'Maria Santos (Management)' },
  admin: { email: 'admin@getmeds.ph', defaultName: 'Admin User' }
};

/**
 * Dynamically resolves the appropriate actor for an action.
 * In TEST_MODE, if an Admin executes a role-specific action (e.g. creating an order,
 * verifying payment, dispatching), the actor is dynamically mapped to the seeded user
 * of that domain so the audit trail faithfully records the proper operational role.
 */
async function resolveActor(user, targetRole) {
  if (!user) return { id: null, name: 'System', role: targetRole || 'system' };
  
  const userRole = (user.role || '').toLowerCase();
  const normalizedTarget = (targetRole || '').toLowerCase();

  // If TEST_MODE is active and Admin is executing a feature for another role:
  if (isTestModeEnabled() && userRole === 'admin' && normalizedTarget && userRole !== normalizedTarget) {
    const seeded = SEEDED_ROLES[normalizedTarget];
    if (seeded) {
      const seededUser = await db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(seeded.email);
      if (seededUser) {
        return seededUser;
      }
      const fallbackUser = await db.prepare('SELECT id, name, email, role FROM users WHERE role = ? AND is_active = 1 LIMIT 1').get(normalizedTarget);
      if (fallbackUser) {
        return fallbackUser;
      }
    }
  }

  return user;
}

module.exports = { logEvent, resolveActor };

