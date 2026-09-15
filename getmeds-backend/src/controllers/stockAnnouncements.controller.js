const db = require('../db/database');
const { tableExists } = require('../services/schemaColumns');

/**
 * Stock announcements (Sep 15, 2026).
 *
 * Dispatch tells everyone about an item's stock — out of stock, back in
 * stock, low, or a general update — with a message. MedReps and Management
 * see the open ones as a banner on their dashboards, and the order form warns
 * a MedRep who adds a flagged product. Confirmed with the business: tied to a
 * product, and shown until Dispatch resolves it.
 *
 * A new announcement about a product supersedes the open one before it —
 * "back in stock" closes "out of stock" — so there is one current word on
 * each item, not a pile of contradicting banners.
 *
 * Before the migration adds the table: the list is empty (and says why) and
 * posting answers "needs a database update", rather than a database error.
 */
const KINDS = ['out_of_stock', 'back_in_stock', 'low_stock', 'stock_update'];
const TABLE = 'stock_announcements';

const notReady = (res) =>
  res.status(503).json({
    success: false,
    error: {
      code: 'MIGRATION_PENDING',
      message: 'Stock announcements need a database update first. Ask IT to run: node src/db/migrate.pg.js'
    }
  });

const actorOf = (user) => ({ id: user.id, name: user.name || user.email });

const OPEN_QUERY = `
  SELECT a.id, a.product_id, a.kind, a.message, a.created_by_name, a.created_at,
         p.name AS product_name, p.sku
    FROM stock_announcements a
    LEFT JOIN products p ON p.id = a.product_id
   WHERE a.resolved_at IS NULL`;

/** GET /api/stock-announcements — the open ones, newest first. Any signed-in user. */
exports.list = async (req, res, next) => {
  try {
    if (!(await tableExists(TABLE))) {
      return res.json({ success: true, data: { announcements: [], migration_pending: true } });
    }
    const rows = await db.prepare(`${OPEN_QUERY} ORDER BY a.created_at DESC, a.id DESC LIMIT 200`).all();
    res.json({ success: true, data: { announcements: rows } });
  } catch (err) { next(err); }
};

/** POST /api/stock-announcements { product_id, kind, message? } — Dispatch, Management, admin. */
exports.create = async (req, res, next) => {
  try {
    if (!(await tableExists(TABLE))) return notReady(res);
    const productId = parseInt(req.body?.product_id, 10);
    const kind = String(req.body?.kind || '').trim();
    const message = String(req.body?.message || '').trim();
    const bad = (m) => res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: m } });
    if (!productId) return bad('Pick the product this is about.');
    if (!KINDS.includes(kind)) return bad(`kind must be one of: ${KINDS.join(', ')}`);
    if (message.length > 300) return bad('The message is too long (300 characters at most).');

    const product = await db.prepare('SELECT id, name FROM products WHERE id = ?').get(productId);
    if (!product) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Product not found' } });

    const me = actorOf(req.user);
    const now = new Date().toISOString();
    await db.transaction(async () => {
      // The newest word on a product replaces the one before it.
      await db
        .prepare(
          `UPDATE stock_announcements SET resolved_at = ?, resolved_by = ?, resolved_by_name = ?
            WHERE product_id = ? AND resolved_at IS NULL`
        )
        .run(now, me.id, me.name, productId);
      await db
        .prepare(
          `INSERT INTO stock_announcements (product_id, kind, message, created_by, created_by_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(productId, kind, message || null, me.id, me.name, now);
    })();

    const saved = await db.prepare(`${OPEN_QUERY} AND a.product_id = ? ORDER BY a.id DESC LIMIT 1`).get(productId);
    res.status(201).json({ success: true, data: { announcement: saved } });
  } catch (err) { next(err); }
};

/** POST /api/stock-announcements/:id/resolve — take it down. Dispatch, Management, admin. */
exports.resolve = async (req, res, next) => {
  try {
    if (!(await tableExists(TABLE))) return notReady(res);
    const me = actorOf(req.user);
    const result = await db
      .prepare(
        `UPDATE stock_announcements SET resolved_at = ?, resolved_by = ?, resolved_by_name = ?
          WHERE id = ? AND resolved_at IS NULL`
      )
      .run(new Date().toISOString(), me.id, me.name, parseInt(req.params.id, 10));
    if (!result.changes) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No open announcement with that id.' } });
    }
    res.json({ success: true, data: { id: parseInt(req.params.id, 10), resolved: true } });
  } catch (err) { next(err); }
};

exports.KINDS = KINDS;
