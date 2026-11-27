const db = require('../db/database');
const deletedDraftPurge = require('../services/deletedDraftPurge');

exports.getAll = async (req, res, next) => {
  try {
    const notifications = await db.prepare(`
      SELECT n.*, o.getmeds_order_id
      FROM notifications n
      LEFT JOIN orders o ON n.order_id = o.id
      WHERE n.recipient_id = ? AND n.channel = 'in_app'
      ORDER BY n.sent_at DESC
      LIMIT 50
    `).all(req.user.id);
    res.json({ success: true, data: { notifications } });
  } catch (err) { next(err); }
};

exports.getUnreadCount = async (req, res, next) => {
  try {
    const count = (await db.prepare(
      "SELECT COUNT(*) as c FROM notifications WHERE recipient_id = ? AND channel = 'in_app' AND is_read = 0"
    ).get(req.user.id)).c;
    res.json({ success: true, data: { count } });
  } catch (err) { next(err); }
};

// Oct 8, 2026: reading a "draft deleted" notification erases that draft for good
// (see services/deletedDraftPurge.js). Only unread ones, so it happens once.
const unreadDeletions = (where, ...params) => db.prepare(
  `SELECT payload FROM notifications WHERE ${where} AND recipient_id = ? AND channel = 'in_app' AND is_read = 0 AND payload LIKE '%deleted_order_id%'`
).all(...params);

exports.markRead = async (req, res, next) => {
  try {
    const deletions = await unreadDeletions('id = ?', req.params.id, req.user.id);
    await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?')
      .run(req.params.id, req.user.id);
    await deletedDraftPurge.purgeForNotifications(deletions);
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const deletions = await unreadDeletions('TRUE', req.user.id);
    await db.prepare("UPDATE notifications SET is_read = 1 WHERE recipient_id = ? AND channel = 'in_app'")
      .run(req.user.id);
    await deletedDraftPurge.purgeForNotifications(deletions);
    res.json({ success: true });
  } catch (err) { next(err); }
};

/**
 * Nov 27, 2026: GET /api/notifications/attention — the orders waiting on THIS
 * person to approve, for the "new order to approve" sound (frontend
 * hooks/useAlertSounds.js). Only ids, newest first, so polling it is cheap:
 *
 *   finance     orders Finance has to verify (financeStages ACTIONABLE),
 *               leaving out imported Zoho history — the same rule as
 *               Finance's own "waiting on you" list
 *   management  the Approval Queue (pending_management_approval), within
 *               the person's own division scope
 *
 * Anyone else gets an empty list. Finance gets no notification when an
 * approved order reaches its queue, so this — not the bell — is what rings.
 */
exports.getAttention = async (req, res, next) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    const { loadScope, scopeSql } = require('../services/orderScopeService');
    const { importedSql } = require('../services/orderOrigin');
    const { ACTIONABLE } = require('../services/financeStages');
    let statuses = null;
    if (role === 'finance') statuses = ACTIONABLE;
    else if (role === 'management') statuses = ['pending_management_approval'];
    if (!statuses) return res.json({ success: true, data: { role, ids: [], items: [], server_now: new Date().toISOString() } });

    const { sql: scopeClause, params: scopeParams } = scopeSql(await loadScope(req.user), 'o');
    // Nov 27, 2026 (2): `since` — when the order reached this list (its latest
    // event moving it into the status), for the 5-minute reminder and the
    // 10-minute bell. server_now so the browser's own clock does not matter.
    const rows = await db.prepare(`
      SELECT o.id,
             COALESCE(
               (SELECT MAX(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.new_status = o.status),
               o.updated_at
             ) AS since
        FROM orders o
       WHERE o.status = ANY(?) AND NOT (${importedSql('o')})${scopeClause ? ` AND ${scopeClause}` : ''}
       ORDER BY o.id DESC
       LIMIT 200
    `).all([statuses, ...scopeParams]);
    res.json({
      success: true,
      data: {
        role,
        ids: rows.map((r) => Number(r.id)),
        items: rows.map((r) => ({ id: Number(r.id), since: r.since ? new Date(r.since).toISOString() : null })),
        server_now: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
};
