'use strict';

const db = require('../db/database');
const { DIVISIONS } = require('../controllers/auth.controller');

/**
 * Which orders a given user is allowed to see and act on.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Sep 11, 2026. Until today every `management` user saw every order. The
 * business needs three managers with different remits: one who sees
 * everything and owns the approval queue, and two who each see their own
 * divisions.
 *
 * ── ONE PLACE, BECAUSE A SECOND PLACE IS A LEAK ─────────────────────────────
 *
 * The obvious implementation — filter the orders list — is the wrong one. A
 * list filter hides rows from a table; it does not stop a manager opening
 * `/orders/41207` directly, and it does nothing at all about
 * `POST /orders/41207/approve`. The list is the least important surface here:
 * the actions are where a mistake means somebody approved an order that was
 * never theirs.
 *
 * So scope is computed HERE and applied everywhere — list, summary, detail,
 * export, approve, reject, send back. Each caller gets either a SQL fragment
 * (for queries) or a yes/no on one order (for actions), from the same rules.
 *
 * ── SCOPING IS OPT-IN; ONCE OPTED IN, IT FAILS CLOSED ───────────────────────
 *
 * Two different users get two different answers, and the distinction is the
 * whole safety argument:
 *
 *   order_scope = 'divisions', no rules   sees NOTHING
 *   order_scope unset (NULL)              sees everything, as before
 *
 * The first is the one that matters. A manager somebody has deliberately
 * restricted, whose divisions have not been filled in yet, must not fall
 * through to full access — that is the classic authorization bug: a
 * half-finished configuration silently grants everything and looks fine on
 * every screen. An empty list is a visible, reportable problem; another
 * division's orders are an invisible one.
 *
 * The second is not that user. It is one nobody has expressed any intention
 * about — every management account predating this column, and any created by a
 * path that does not set it. Failing closed there would blank the system for
 * an existing manager the moment a migration ran, with no error to explain it.
 *
 * The cost is real and worth stating: create a manager meaning to restrict
 * them, forget to set order_scope, and you have created an unrestricted one.
 * That is why the scope admin screen writes this field explicitly instead of
 * leaning on the default.
 *
 * ── WHAT AN ORDER'S DIVISION IS ─────────────────────────────────────────────
 *
 * `orders.division`, which is set at creation for orders raised here and
 * backfilled from Zoho's Salesperson prefix for imported ones (see
 * scripts/backfill-order-division.js).
 *
 * It is NULL for roughly half the imported history, because Zoho recorded no
 * Salesperson at all on those orders — 30,854 of them. Those cannot be
 * attributed to a division by any means, so they are visible ONLY to a
 * full-scope user. That is a deliberate choice: a scoped manager seeing an
 * unattributable order would be a guess, and the alternative — showing them to
 * everyone — would leak across divisions.
 */

/** A user with this scope sees everything. Held explicitly, never inferred. */
const SCOPE_ALL = 'all';
/** A user with this scope sees only what manager_order_scope lists for them. */
const SCOPE_DIVISIONS = 'divisions';

/**
 * Roles whose visibility is not division-scoped at all.
 *
 * A MedRep's own orders are already restricted by medrep_id elsewhere, and
 * Finance/Dispatch work the whole pipeline by function rather than by
 * division. Scoping is a MANAGEMENT concept; applying it to them would quietly
 * break their queues.
 */
const UNSCOPED_ROLES = new Set(['admin', 'medrep', 'finance', 'dispatch']);

/**
 * Read a user's scope: the mode, plus the (division, sub_division) pairs.
 *
 * `sub_division: null` on a row means the WHOLE division. A row naming a
 * sub-division narrows to just that one, which is how B2B → NBD/CRR is meant
 * to work once those are actually recorded on orders (as of today they are
 * not: NBD appears on one order in 60,866 and CRR on none, because B2B's
 * Salesperson field holds a person's name where HOS holds a territory).
 */
async function loadScope(user) {
  if (!user) return { mode: SCOPE_DIVISIONS, rules: [] };
  if (UNSCOPED_ROLES.has(user.role)) return { mode: SCOPE_ALL, rules: [] };

  const row = await db.prepare('SELECT order_scope FROM users WHERE id = ?').get(user.id);

  // ── NULL means "not scoped", not "scoped to nothing" ──────────────────────
  //
  // Scoping is opt-IN. A management user whose order_scope was never set keeps
  // what every management user had before this feature existed: everything.
  //
  // This is a deliberate exception to the fail-closed rule above, and it is
  // worth being precise about which risk each choice takes. The dangerous
  // fail-open — a user who IS scoped but whose rules have not been written yet
  // quietly seeing every division — stays closed: that is the `!rules.length`
  // case, and it returns nothing. What this handles is a DIFFERENT user: one
  // nobody has expressed any intention about, including every management
  // account that predates this column and every one created by a path that
  // does not set it.
  //
  // Failing closed there would mean a new manager, or an existing one on a
  // database migrated a moment ago, silently seeing an empty system with no
  // error to explain it. The cost is that an admin who creates a restricted
  // manager and forgets to restrict them has created an unrestricted one — so
  // the scope admin screen sets this explicitly rather than relying on the
  // default, and the column carries DEFAULT 'all' to match.
  const stored = row?.order_scope;
  const mode = stored === SCOPE_DIVISIONS ? SCOPE_DIVISIONS : SCOPE_ALL;
  if (mode === SCOPE_ALL) return { mode: SCOPE_ALL, rules: [] };

  const rules = await db
    .prepare('SELECT division, sub_division FROM manager_order_scope WHERE user_id = ? ORDER BY division, sub_division')
    .all(user.id);

  return { mode: SCOPE_DIVISIONS, rules };
}

/**
 * A SQL fragment restricting a query to what this user may see, as
 * `{ sql, params }` ready to push onto a WHERE list.
 *
 * `sql` is null when no restriction applies, so a caller can skip it rather
 * than paste `AND 1=1` into every query.
 *
 * `alias` is the orders table's alias in the calling query — the management
 * list uses `o`, so that is the default.
 */
function scopeSql(scope, alias = 'o') {
  if (scope.mode === SCOPE_ALL) return { sql: null, params: [] };

  // Fails closed: no rules means no orders, not all orders.
  if (!scope.rules.length) return { sql: '1 = 0', params: [] };

  const clauses = [];
  const params = [];
  for (const r of scope.rules) {
    if (r.sub_division) {
      clauses.push(`(${alias}.division = ? AND ${alias}.sub_division = ?)`);
      params.push(r.division, r.sub_division);
    } else {
      clauses.push(`${alias}.division = ?`);
      params.push(r.division);
    }
  }

  // An order with no division matches nothing here, which is what excludes the
  // ~30,854 unattributable imports from a scoped manager's view.
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/** Does this user's scope cover this one order? The action guard. */
function covers(scope, order) {
  if (scope.mode === SCOPE_ALL) return true;
  if (!scope.rules.length) return false;
  if (!order || !order.division) return false;

  return scope.rules.some(
    (r) =>
      r.division === order.division &&
      (!r.sub_division || r.sub_division === order.sub_division)
  );
}

/** Convenience for a route: load the scope and answer for one order. */
async function canAccessOrder(user, order) {
  const scope = await loadScope(user);
  return covers(scope, order);
}

/**
 * Who may change another user's scope.
 *
 * Confirmed with the business (Sep 11, 2026): the full-scope manager hands out
 * access, so this is not admin-only. A scoped manager cannot widen their own
 * remit — which is the point of the check.
 */
async function canManageScopes(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'management') return false;
  const row = await db.prepare('SELECT order_scope FROM users WHERE id = ?').get(user.id);
  return row?.order_scope === SCOPE_ALL;
}

/** Validate a proposed scope row before it is written. */
function validateRule({ division, sub_division: subDivision }) {
  if (!division || !DIVISIONS.includes(division)) {
    return `Division must be one of: ${DIVISIONS.join(', ')}`;
  }
  // Sub-division is deliberately NOT validated against
  // SUB_DIVISIONS_BY_DIVISION: B2B has no list there, and NBD/CRR are exactly
  // the case this has to support. Free text, same as on the order itself.
  if (subDivision != null && typeof subDivision !== 'string') {
    return 'Sub-division must be text or omitted';
  }
  return null;
}

module.exports = {
  SCOPE_ALL,
  SCOPE_DIVISIONS,
  UNSCOPED_ROLES,
  loadScope,
  scopeSql,
  covers,
  canAccessOrder,
  canManageScopes,
  validateRule
};
