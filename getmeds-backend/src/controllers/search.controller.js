const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');

/**
 * GET /api/search?q= — the top-nav search bar (Topbar.jsx), wired up for
 * the first time. It had no handler, no state and no endpoint behind it at
 * all before this — not a fix, new work.
 *
 * Sep 19, 2026. Three categories, each capped small (MAX_PER_CATEGORY) — this
 * feeds a dropdown under a search box, not a results page, so "the top few
 * matches" is the right answer, not "every match." Orders are the only
 * category with a page to link to; customers and products have no dedicated
 * URL anywhere in this app (confirmed before writing this — see ClientsPage.jsx
 * and the lack of any /customers/:id or /products/:id route), so those two
 * are shown for reference only.
 *
 * Scope: a MedRep sees only their own orders in search results, same
 * ownership rule orders.controller.js's getAll already applies (medrep_id OR
 * raised_by_id). A division-scoped manager gets scopeSql applied here even
 * though getAll's own list does not — a search result is a direct link to
 * /orders/:id, and getById already 403s a scoped manager outside their
 * divisions, so showing an unopenable result would be worse than not
 * showing it. Finance/dispatch/admin are unscoped, same as everywhere else.
 */

const MAX_PER_CATEGORY = 6;

/** % and _ are matched as themselves, not as wildcards — same escaping as dispatch.controller.js's search. */
function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

exports.search = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ success: true, data: { query: q, orders: [], customers: [], products: [] } });
    }
    const like = likePattern(q);

    const orderWhere = ['(o.getmeds_order_id LIKE ? OR c.name LIKE ?)'];
    const orderParams = [like, like];
    if (req.user.role === 'medrep') {
      orderWhere.push('(o.medrep_id = ? OR o.raised_by_id = ?)');
      orderParams.push(req.user.id, req.user.id);
    }
    if (req.user.role === 'management') {
      const scope = await loadScope(req.user);
      const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
      if (scopeClause) {
        orderWhere.push(scopeClause);
        orderParams.push(...scopeParams);
      }
    }

    const [orders, customers, products] = await Promise.all([
      db
        .prepare(
          `SELECT o.id, o.getmeds_order_id, o.status, o.total_amount, c.name AS customer_name
             FROM orders o
             LEFT JOIN customers c ON o.customer_id = c.id
            WHERE ${orderWhere.join(' AND ')}
            ORDER BY o.created_at DESC
            LIMIT ${MAX_PER_CATEGORY}`
        )
        .all(...orderParams),
      db
        .prepare(
          `SELECT id, name, contact_person, contact_number, type
             FROM customers
            WHERE (name LIKE ? OR contact_person LIKE ? OR contact_number LIKE ?)
            ORDER BY name
            LIMIT ${MAX_PER_CATEGORY}`
        )
        .all(like, like, like),
      db
        .prepare(
          `SELECT id, name, sku, unit_price, is_active
             FROM products
            WHERE (name LIKE ? OR sku LIKE ?)
            ORDER BY is_active DESC, name
            LIMIT ${MAX_PER_CATEGORY}`
        )
        .all(like, like),
    ]);

    res.json({ success: true, data: { query: q, orders, customers, products } });
  } catch (err) { next(err); }
};
