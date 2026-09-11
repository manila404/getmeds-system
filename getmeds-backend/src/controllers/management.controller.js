const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');

/**
 * Sep 11, 2026: every KPI on this dashboard counts only what the viewer is
 * allowed to see.
 *
 * Scoping the orders LIST and not this would be worse than not scoping at
 * all: a manager restricted to B2B would see "60,866 total orders" over a
 * table holding 9,941, and the obvious conclusion is that the table is broken.
 * Numbers a person cannot drill into are not a smaller leak than rows — they
 * are the same leak, harder to notice.
 */
exports.getSummary = async (req, res, next) => {
  try {
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'orders');

    // Compose each query's own WHERE with the viewer's scope. Returns the SQL
    // and the params in the right order, because getting those out of step is
    // how a scoped query silently becomes an unscoped one.
    const scoped = (where = '', params = []) => {
      const parts = [];
      if (where) parts.push(`(${where})`);
      if (scopeClause) parts.push(scopeClause);
      const clause = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
      return { clause, params: [...params, ...(scopeClause ? scopeParams : [])] };
    };

    const countWhere = async (where = '', params = []) => {
      const { clause, params: p } = scoped(where, params);
      return (await db.prepare(`SELECT COUNT(*) as c FROM orders${clause}`).get(...p)).c;
    };

    // Orders by status
    const byStatus = scoped();
    const statusRows = await db
      .prepare(`SELECT status, COUNT(*) as count FROM orders${byStatus.clause} GROUP BY status`)
      .all(...byStatus.params);
    const orders_by_status = {};
    for (const row of statusRows) orders_by_status[row.status] = row.count;

    const total_orders = await countWhere();
    // Sep 1, 2026: invoice_drafted/invoice_sent counted here too. Both are
    // orders Finance is still carrying — invoiced in Zoho but not yet paid —
    // and they are already in the Finance queue, so leaving them out made
    // this KPI disagree with the queue it is meant to summarise.
    const pending_payment_count = await countWhere("status IN ('ready_for_draft_invoice','ready_for_invoice_sent','ready_for_dispatch')");
    const ready_dispatch_count = await countWhere("status IN ('ready_for_dispatch','picking_packing')");
    const dispatched_count = await countWhere("status IN ('dispatched','tracking_shared')");
    const completed_count = await countWhere("status = 'completed'");
    // 'deleted' counted alongside 'cancelled' (Sep 1, 2026) so an order whose
    // Sales Order was removed in Zoho still shows up somewhere on the
    // dashboard rather than dropping out of every KPI.
    const exception_count = await countWhere("status IN ('on_hold','exception','cancelled','deleted')");

    const today = new Date().toISOString().slice(0, 10);
    const orders_today = await countWhere('DATE(created_at) = ?', [today]);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const orders_this_week = await countWhere('DATE(created_at) >= ?', [weekAgo]);

    // Avg processing time (submitted_at → completed dispatched)
    const avg = scoped(
      "status IN ('completed', 'dispatched', 'tracking_shared') AND submitted_at IS NOT NULL"
    );
    const avgRow = await db
      .prepare(
        `SELECT AVG((JULIANDAY(updated_at) - JULIANDAY(submitted_at)) * 24) as avg_hours
           FROM orders${avg.clause}`
      )
      .get(...avg.params);
    const avg_processing_time_hours = avgRow.avg_hours ? Math.round(avgRow.avg_hours * 10) / 10 : null;

    res.json({
      success: true,
      data: {
        orders_by_status,
        total_orders,
        pending_payment_count,
        ready_dispatch_count,
        dispatched_count,
        completed_count,
        exception_count,
        avg_processing_time_hours,
        orders_today,
        orders_this_week,
        // What these numbers are counting. Without it a scoped manager cannot
        // tell a quiet day from a narrowed view.
        scope: {
          mode: scope.mode,
          divisions: scope.rules.map((r) =>
            r.sub_division ? `${r.division} / ${r.sub_division}` : r.division
          )
        }
      }
    });
  } catch (err) { next(err); }
};

exports.getAllOrders = async (req, res, next) => {
  try {
    const { status, customer_type, date_from, date_to, search, medrep_id, unassigned } = req.query;

    // Sep 9, 2026: bounded. The Zoho import means this table is no longer a
    // few hundred rows — the live org has 65,000+ Sales Orders — so an
    // unbounded page would ship megabytes of JSON and lock the browser. 25 is
    // the frontend's page size; the cap is what stops `?limit=999999` from
    // being the same unbounded query by another name. Export CSV asks for a
    // deliberately larger page, which is why the cap is 5,000 and not 100.
    const MAX_LIMIT = 5000;
    const DEFAULT_LIMIT = 25;
    // A nonsense limit falls back to the default rather than being clamped
    // into range: Math.max(1, -4) is 1, so `?limit=-4` would quietly serve
    // one-row pages, which looks like a broken table rather than bad input.
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(MAX_LIMIT, requestedLimit)
        : DEFAULT_LIMIT;
    const requestedPage = parseInt(req.query.page, 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const offset = (page - 1) * limit;

    let where = [];
    let params = [];
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customer_type) { where.push('o.customer_type = ?'); params.push(customer_type); }

    // Sep 9, 2026: date range, as a plain comparison on created_at rather than
    // DATE(o.created_at) BETWEEN ?. Two reasons, and the second is the real one:
    //
    //  1. There is an index on orders(created_at DESC). A range comparison can
    //     use it; wrapping the column in DATE() cannot, and on 65,000 rows
    //     that is the difference between a lookup and a full scan on every
    //     page of every filtered view.
    //  2. created_at is TEXT holding ISO-8601, and ISO-8601 sorts
    //     lexicographically in the same order it sorts chronologically — which
    //     is the entire reason this column format was chosen. So a string
    //     comparison against 'YYYY-MM-DD...' is exact, not an approximation,
    //     and it stays exact for the mixed suffixes the import brings in
    //     (Zoho's created_time carries a +0800 offset; this app writes Z).
    //
    // Both bounds are INCLUSIVE of their whole day, which is what a person
    // picking "9 Sep to 9 Sep" means. The upper bound is therefore the end of
    // the day, not its midnight — with midnight, picking a single day returns
    // only orders created in the first instant of it, i.e. almost always none.
    if (date_from) { where.push('o.created_at >= ?'); params.push(`${date_from}T00:00:00.000Z`); }
    if (date_to) { where.push('o.created_at <= ?'); params.push(`${date_to}T23:59:59.999Z`); }

    // Sep 10, 2026: filter by who the order is ASSIGNED to.
    //
    // The point of this one is verification, not browsing. After the Zoho
    // import handed 60,817 orders to whoever ran it, and the Order Ownership
    // screen handed some of them on to real reps, the only way to check that
    // landed correctly is to ask "show me everything assigned to this rep" and
    // look at it. Without that, the assignment is a number in a toast.
    //
    // `unassigned=true` is the other half of the same question: everything
    // still sitting with the importing admin, which is what remains to be
    // decided. It reads better than making someone know the admin's user id.
    if (medrep_id) { where.push('o.medrep_id = ?'); params.push(parseInt(medrep_id, 10)); }
    if (String(unassigned || '').toLowerCase() === 'true') {
      where.push("o.getmeds_order_id LIKE 'ZOHO-%' AND u.role = 'admin'");
    }

    // Free-text across the three columns a person actually recognises an order
    // by. Needed once the list is paginated: with 65,000 orders, "find this
    // one" cannot mean "page through until you see it".
    if (search) {
      where.push('(o.getmeds_order_id LIKE ? OR c.name LIKE ? OR o.zoho_so_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    // Sep 11, 2026: the viewer's own scope, applied last and unconditionally.
    //
    // Pushed onto the SAME `where` list as the query-string filters rather
    // than bolted on at the end, so there is no route by which a caller's
    // parameters can displace it — every filter above narrows what is already
    // narrowed by this, and none of them can widen it.
    //
    // For a manager restricted to divisions with no rules configured this is
    // `1 = 0`: no orders, deliberately. See services/orderScopeService.js.
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    if (scopeClause) {
      where.push(scopeClause);
      params.push(...scopeParams);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = await db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name,
             -- Sep 10, 2026: the OWNER'S ROLE, so the table can tell "assigned
             -- to a rep" from "still sitting with the admin who ran the
             -- import". Both look like a name in medrep_name; only the role
             -- says which one it is.
             u.role as medrep_role,
             -- Sep 9, 2026: the effective Salesperson, resolved here rather
             -- than in the browser.
             --
             -- Two places hold one answer, and which one is authoritative
             -- depends on where the order came from. orders.salesperson is set
             -- when Management picked a Salesperson for this specific order,
             -- and on every order adopted from Zoho (which carries Zoho's own
             -- Salesperson and has no MedRep account behind it — see
             -- services/zohoOrderImportService.js). Otherwise it is NULL and
             -- means "whatever the ordering MedRep's account says", which is
             -- users.salesperson, a generated "<division> | <display name>".
             COALESCE(o.salesperson, u.salesperson) as salesperson_name,
             p.status as payment_status, d.status as dispatch_status, d.tracking_number, d.courier
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      LEFT JOIN dispatch_records d ON o.id = d.order_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // The count has to join customers too now — the search clause filters on
    // c.name, and counting over `orders o` alone would raise "missing FROM
    // clause entry for table c" the moment anyone typed in the search box.
    // The count joins users as well as customers now — `unassigned` filters on
    // u.role, and counting over a narrower FROM than the row query filters on
    // is how a total silently stops matching the rows under it.
    const total = (await db.prepare(`
      SELECT COUNT(*) as c
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      ${whereClause}
    `).get(...params)).c;

    res.json({
      success: true,
      data: {
        orders,
        pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) }
      }
    });
  } catch (err) { next(err); }
};
