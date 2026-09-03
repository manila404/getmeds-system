const db = require('../db/database');

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

exports.markRead = async (req, res, next) => {
  try {
    await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?')
      .run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.markAllRead = async (req, res, next) => {
  try {
    await db.prepare("UPDATE notifications SET is_read = 1 WHERE recipient_id = ? AND channel = 'in_app'")
      .run(req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
};
