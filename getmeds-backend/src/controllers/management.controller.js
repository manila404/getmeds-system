const db = require('../db/database');

exports.getSummary = (req, res, next) => {
  try {
    // Orders by status
    const statusRows = db.prepare('SELECT status, COUNT(*) as count FROM orders GROUP BY status').all();
    const orders_by_status = {};
    for (const row of statusRows) orders_by_status[row.status] = row.count;

    const total_orders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
    // Sep 1, 2026: invoice_drafted/invoice_sent counted here too. Both are
    // orders Finance is still carrying — invoiced in Zoho but not yet paid —
    // and they are already in the Finance queue, so leaving them out made
    // this KPI disagree with the queue it is meant to summarise.
    const pending_payment_count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('ready_for_draft_invoice','ready_for_invoice_sent','ready_for_dispatch')").get().c;
    const ready_dispatch_count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('ready_for_dispatch','picking_packing')").get().c;
    const dispatched_count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('dispatched','tracking_shared')").get().c;
    const completed_count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'completed'").get().c;
    // 'deleted' counted alongside 'cancelled' (Sep 1, 2026) so an order whose
    // Sales Order was removed in Zoho still shows up somewhere on the
    // dashboard rather than dropping out of every KPI.
    const exception_count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('on_hold','exception','cancelled','deleted')").get().c;

    const today = new Date().toISOString().slice(0, 10);
    const orders_today = db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = ?").get(today).c;

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const orders_this_week = db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) >= ?").get(weekAgo).c;

    // Avg processing time (submitted_at → completed dispatched)
    const avgRow = db.prepare(`
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

exports.getAllOrders = (req, res, next) => {
  try {
    const { status, customer_type, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = [];
    let params = [];
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customer_type) { where.push('o.customer_type = ?'); params.push(customer_type); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name,
             p.status as payment_status, d.status as dispatch_status, d.tracking_number, d.courier
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      LEFT JOIN dispatch_records d ON o.id = d.order_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const total = db.prepare(`SELECT COUNT(*) as c FROM orders o ${whereClause}`).get(...params).c;

    res.json({ success: true, data: { orders, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) } } });
  } catch (err) { next(err); }
};
