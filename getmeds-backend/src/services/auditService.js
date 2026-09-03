const db = require('../db/database');

// 1. Prepare the statement once at module load for better performance
const insertEventStmt = db.prepare(`
  INSERT INTO order_events (
    order_id, event_type, old_status, new_status, 
    actor_id, actor_name, notes, metadata, created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

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
 * @param {string} [params.notes] - Additional context.
 * @param {Object} [params.metadata] - Extra data to be stored as JSON.
 */
async function logEvent(
  { orderId, eventType, oldStatus, newStatus, actorId, actorName, notes, metadata }
) {
  // 2. Validate required fields
  if (!orderId || !eventType) {
    throw new Error('orderId and eventType are required to log an event.');
  }

  try {
    // 3. Execute the cached statement
    // 4. Use '??' instead of '||' to preserve falsy values like 0 or ""
    await insertEventStmt.run(
      orderId,
      eventType,
      oldStatus ?? null,
      newStatus ?? null,
      actorId ?? null,
      actorName ?? null,
      notes ?? null,
      metadata ? JSON.stringify(metadata) : null
    );
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

