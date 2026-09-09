const db = require('../db/database');

exports.getSummary = async (req, res, next) => {
  try {
    // Orders by status
    const statusRows = await db.prepare('SELECT status, COUNT(*) as count FROM orders GROUP BY status').all();
    const orders_by_status = {};
    for (const row of statusRows) orders_by_status[row.status] = row.count;

    const total_orders = (await db.prepare('SELECT COUNT(*) as c FROM orders').get()).c;
    // Sep 1, 2026: invoice_drafted/invoice_sent counted here too. Both are
    // orders Finance is still carrying — invoiced in Zoho but not yet paid —
    // and they are already in the Finance queue, so leaving them out made
    // this KPI disagree with the queue it is meant to summarise.
    const pending_payment_count = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('ready_for_draft_invoice','ready_for_invoice_sent','ready_for_dispatch')").get()).c;
    const ready_dispatch_count = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('ready_for_dispatch','picking_packing')").get()).c;
    const dispatched_count = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('dispatched','tracking_shared')").get()).c;
    const completed_count = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'completed'").get()).c;
    // 'deleted' counted alongside 'cancelled' (Sep 1, 2026) so an order whose
    // Sales Order was removed in Zoho still shows up somewhere on the
    // dashboard rather than dropping out of every KPI.
    const exception_count = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('on_hold','exception','cancelled','deleted')").get()).c;

    const today = new Date().toISOString().slice(0, 10);
    const orders_today = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = ?").get(today)).c;

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const orders_this_week = (await db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) >= ?").get(weekAgo)).c;

    // Avg processing time (submitted_at → completed dispatched)
    const avgRow = await db.prepare(`
      SELECT AVG((JULIANDAY(updated_at) - JULIANDAY(submitted_at)) * 24) as avg_hours
      FROM orders
      WHERE status IN ('completed', 'dispatched', 'tracking_shared') AND submitted_at IS NOT NULL
    `).get();
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
        orders_this_week
      }
    });
  } catch (err) { next(err); }
};

exports.getAllOrders = async (req, res, next) => {
  try {
    const { status, customer_type, date_from, date_to, search } = req.query;

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

    // Free-text across the three columns a person actually recognises an order
    // by. Needed once the list is paginated: with 65,000 orders, "find this
    // one" cannot mean "page through until you see it".
    if (search) {
      where.push('(o.getmeds_order_id LIKE ? OR c.name LIKE ? OR o.zoho_so_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = await db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name,
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
    const total = (await db.prepare(`
      SELECT COUNT(*) as c
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
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
