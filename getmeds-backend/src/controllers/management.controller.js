const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');
// Sep 21, 2026: Team Lead's view of this same dashboard — person-scoped
// (their assigned MedReps) rather than division-scoped. See
// services/teamScopeService.js. Both branches feed the exact same
// scopeClause/scopeParams pair everything below already consumes.
const { teamScopeSql, teamMedrepIds } = require('../services/teamScopeService');

/** The names on this Team Lead's team, for the dashboard's "what am I seeing" line. */
async function teamMemberNames(teamLeadUserId) {
  const ids = await teamMedrepIds(teamLeadUserId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.prepare(`SELECT name FROM users WHERE id IN (${placeholders}) ORDER BY name`).all(...ids);
  return rows.map((r) => r.name);
}

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
/**
 * Sep 24, 2026: the status groups behind each dashboard KPI, defined ONCE and
 * returned to the browser (`status_groups`) so a card's count and the table
 * it click-throughs to can never drift apart — the count and the filter are
 * literally the same list.
 *
 * pending_payment used to include 'ready_for_dispatch', which
 * ready_dispatch also counts, so one order showed up in two cards and the
 * cards could not be added up. Each status now belongs to exactly one card.
 */
const STATUS_GROUPS = {
  pending_payment: ['ready_for_draft_invoice', 'ready_for_invoice_sent'],
  ready_dispatch: ['ready_for_dispatch', 'picking_packing'],
  in_transit: ['dispatched', 'tracking_shared'],
  completed: ['completed'],
  // 'deleted' counted alongside 'cancelled' (Sep 1, 2026) so an order whose
  // Sales Order was removed in Zoho still shows up somewhere on the dashboard.
  exceptions: ['on_hold', 'exception', 'cancelled', 'deleted']
};
const inList = (statuses) => `status IN (${statuses.map((s) => `'${s}'`).join(',')})`;

// Orders imported from Zoho carry Zoho's own (often years-old) creation date
// but were adopted into this app only recently — see zohoOrderImportService.
// They are history, not current operations, so the dashboard separates them.
const IMPORTED = "getmeds_order_id LIKE 'ZOHO-%'";
const NATIVE = "getmeds_order_id NOT LIKE 'ZOHO-%'";
const SOURCES = ['native', 'imported', 'all'];

/** Not-finished statuses an order can sit in and go quiet. */
const STALE_EXCLUDED = ['draft', 'completed', 'cancelled', 'deleted'];
const STALE_HOURS_DEFAULT = 48;

exports.getSummary = async (req, res, next) => {
  try {
    const isTeamLead = req.user.role === 'team_lead';
    // 'all' stays the API default so every existing caller and test keeps its
    // meaning; the dashboard asks for 'native' explicitly.
    const source = SOURCES.includes(req.query.source) ? req.query.source : 'all';
    const sourceClause = source === 'native' ? NATIVE : source === 'imported' ? IMPORTED : '';
    // Sep 21, 2026: same {sql, params} shape either way — everything below
    // this point has no idea, and needs no idea, which kind of scope produced
    // scopeClause/scopeParams. See teamScopeService.js for why a Team Lead's
    // rule (their assigned MedReps) is a different shape than a manager's
    // (their divisions) and gets its own function rather than a branch inside
    // orderScopeService.
    const scope = isTeamLead ? null : await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = isTeamLead
      ? await teamScopeSql(req.user.id, 'orders')
      : scopeSql(scope, 'orders');

    // Compose each query's own WHERE with the viewer's scope. Returns the SQL
    // and the params in the right order, because getting those out of step is
    // how a scoped query silently becomes an unscoped one.
    const scoped = (where = '', params = []) => {
      const parts = [];
      if (where) parts.push(`(${where})`);
      if (sourceClause) parts.push(sourceClause);
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
    const pending_payment_count = await countWhere(inList(STATUS_GROUPS.pending_payment));
    const ready_dispatch_count = await countWhere(inList(STATUS_GROUPS.ready_dispatch));
    const dispatched_count = await countWhere(inList(STATUS_GROUPS.in_transit));
    const completed_count = await countWhere(inList(STATUS_GROUPS.completed));
    const exception_count = await countWhere(inList(STATUS_GROUPS.exceptions));

    const today = new Date().toISOString().slice(0, 10);
    const orders_today = await countWhere('DATE(created_at) = ?', [today]);

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const orders_this_week = await countWhere('DATE(created_at) >= ?', [weekAgo]);

    // Sep 24, 2026: processing time, rebuilt. It used to average
    // (updated_at - submitted_at) over every completed/dispatched order,
    // which read "25,004.7h" (~2.85 years): 59,400 of the 59,763 orders in
    // that pool were imported from Zoho, stamped with Zoho's original
    // creation date (as far back as 2021) but an import-time updated_at.
    // Two changes:
    //   1. NATIVE orders only, always — an imported order has no real
    //      "submitted to done" span in this app, whatever the source toggle
    //      says. (Toggled to 'imported', this is therefore empty → N/A.)
    //   2. Reported as a MEDIAN alongside the mean: a few very slow orders
    //      drag a mean far above what a typical order experiences. On live
    //      data: mean 22.5h, median 2.9h, 90th percentile 93.2h.
    // The end point stays updated_at ("last touched"). A completion-EVENT end
    // point was tried and rejected: the dispatch/complete events on native
    // orders are largely Zoho-date backfills clamped to the Sales Order's
    // creation, which collapses every span to ~0h and is less truthful than
    // the imperfect updated_at. Labelled "Submit → last update" in the UI.
    const proc = scoped(`${NATIVE} AND status IN ('completed', 'dispatched', 'tracking_shared') AND submitted_at IS NOT NULL`);
    const procRow = await db
      .prepare(
        `SELECT COUNT(*)::int AS n, AVG(hrs) AS avg_hours,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY hrs) AS median_hours
           FROM (
             SELECT GREATEST(EXTRACT(EPOCH FROM (orders.updated_at::timestamptz - orders.submitted_at::timestamptz)) / 3600.0, 0) AS hrs
               FROM orders${proc.clause}
           ) t`
      )
      .get(...proc.params);
    const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
    const avg_processing_time_hours = round1(procRow.avg_hours);
    const median_processing_time_hours = round1(procRow.median_hours);
    const processing_sample_size = procRow.n || 0;

    // Sep 24, 2026: "Action Needed" — the counts an admin should see before
    // anything else, each a click-through to the page/filter that resolves it.
    // Every count goes through the same scope as the KPIs above.
    const staleHours = STALE_HOURS_DEFAULT;
    const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
    const action_needed = {
      pending_approvals: await countWhere("status = 'pending_management_approval'"),
      holds: await countWhere("status IN ('on_hold','exception')"),
      stale_orders: await countWhere(
        `${NATIVE} AND status NOT IN (${STALE_EXCLUDED.map((s) => `'${s}'`).join(',')}) AND updated_at < ?`,
        [staleCutoff]
      ),
      stale_hours: staleHours,
      // Not division-scoped data, and their pages are admin/management only —
      // a Team Lead gets neither.
      failed_syncs: null,
      pending_customers: null
    };
    if (!isTeamLead) {
      if (req.user.role === 'admin') {
        action_needed.failed_syncs = (
          await db.prepare("SELECT COUNT(*) as c FROM zoho_sync_queue WHERE status = 'failed_permanent'").get()
        ).c;
      }
      action_needed.pending_customers = (
        await db.prepare("SELECT COUNT(*) as c FROM customers WHERE zoho_sync_status IN ('pending','failed')").get()
      ).c;
    }

    // Sep 21, 2026: a Team Lead's "what am I looking at" is their team's
    // names, not a division list — same purpose as the block below, different
    // shape of scope.
    const scopeMeta = isTeamLead
      ? { mode: 'team', team: await teamMemberNames(req.user.id) }
      : {
          mode: scope.mode,
          divisions: scope.rules.map((r) =>
            r.sub_division ? `${r.division} / ${r.sub_division}` : r.division
          )
        };

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
        median_processing_time_hours,
        processing_sample_size,
        orders_today,
        orders_this_week,
        action_needed,
        status_groups: STATUS_GROUPS,
        source,
        // What these numbers are counting. Without it a scoped manager cannot
        // tell a quiet day from a narrowed view.
        scope: scopeMeta
      }
    });
  } catch (err) { next(err); }
};

/**
 * Sep 24, 2026: the dashboard's Recent Activity feed — the latest decisions and
 * problems across the orders this viewer can see, newest first.
 *
 * A curated list of event types, not "everything": the audit trail holds 30+
 * kinds of event and most (attachment added, items synced, tracking entered)
 * are bookkeeping nobody wants scrolling past. These are the ones an admin
 * would otherwise have to go looking for — approvals and rejections, holds,
 * exceptions, Zoho sync failures and recoveries, completions.
 *
 * Native orders only (an imported order's events are Zoho history, dated to
 * the day they happened in Zoho — they would flood a "recent" feed), scoped
 * exactly like the list and KPIs, and bounded to 30 days so the scan stays
 * cheap however large the audit trail grows.
 */
const ACTIVITY_EVENT_TYPES = [
  'ORDER_SUBMITTED', 'ORDER_RESUBMITTED',
  'MANAGEMENT_APPROVED', 'MANAGEMENT_REJECTED', 'MANAGEMENT_SENT_BACK',
  'FINANCE_VERIFIED', 'FINANCE_REJECTED',
  'EXCEPTION_SET', 'DISPATCH_HOLD', 'TRACKING_ON_HOLD',
  'ZOHO_SYNC_FAILED_PERMANENT', 'ZOHO_SYNC_RECOVERED',
  'ORDER_COMPLETED'
];

exports.getRecentActivity = async (req, res, next) => {
  try {
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(20, requested) : 8;

    const { sql: scopeClause, params: scopeParams } = req.user.role === 'team_lead'
      ? await teamScopeSql(req.user.id, 'o')
      : scopeSql(await loadScope(req.user), 'o');

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const where = [
      `e.event_type IN (${ACTIVITY_EVENT_TYPES.map(() => '?').join(',')})`,
      "o.getmeds_order_id NOT LIKE 'ZOHO-%'",
      'e.created_at >= ?'
    ];
    const params = [...ACTIVITY_EVENT_TYPES, since];
    if (scopeClause) { where.push(scopeClause); params.push(...scopeParams); }

    const rows = await db.prepare(`
      SELECT e.id, e.event_type, e.actor_name, e.actor_role, e.created_at, e.notes,
             o.id AS order_id, o.getmeds_order_id, c.name AS customer_name
        FROM order_events e
        JOIN orders o ON o.id = e.order_id
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?
    `).all(...params, limit);

    res.json({ success: true, data: { events: rows } });
  } catch (err) { next(err); }
};

exports.getAllOrders = async (req, res, next) => {
  try {
    const { status, customer_type, date_from, date_to, search, medrep_id, unassigned, source, stale_hours } = req.query;

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
    // Sep 24, 2026: `status` accepts a comma-separated list. A dashboard KPI
    // such as "Exceptions" is several statuses, and its click-through has to
    // filter the table to exactly what the card counted. A single value
    // behaves exactly as before ('a' → `= 'a'`).
    if (status) {
      const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) { where.push('o.status = ?'); params.push(statuses[0]); }
      else if (statuses.length > 1) {
        where.push(`o.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (customer_type) { where.push('o.customer_type = ?'); params.push(customer_type); }

    // Sep 24, 2026: native vs Zoho-imported. Omitted = everything, as before —
    // the approval queue and other callers rely on that.
    if (source === 'native') where.push("o.getmeds_order_id NOT LIKE 'ZOHO-%'");
    else if (source === 'imported') where.push("o.getmeds_order_id LIKE 'ZOHO-%'");

    // Sep 24, 2026: "stuck" orders — the Action Needed strip's click-through.
    // Same definition getSummary counts: native, not finished, untouched for N
    // hours. Bounded so a typo can't ask for a negative window.
    const staleN = parseInt(stale_hours, 10);
    if (Number.isFinite(staleN) && staleN > 0) {
      where.push(
        "o.getmeds_order_id NOT LIKE 'ZOHO-%' AND o.status NOT IN ('draft','completed','cancelled','deleted') AND o.updated_at < ?"
      );
      params.push(new Date(Date.now() - staleN * 60 * 60 * 1000).toISOString());
    }

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
    //
    // Sep 21, 2026: a Team Lead gets teamScopeSql instead — same {sql,params}
    // shape, scoped to their assigned MedReps rather than a division. See
    // teamScopeService.js.
    const { sql: scopeClause, params: scopeParams } = req.user.role === 'team_lead'
      ? await teamScopeSql(req.user.id, 'o')
      : scopeSql(await loadScope(req.user), 'o');
    if (scopeClause) {
      where.push(scopeClause);
      params.push(...scopeParams);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = await db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name,
             -- Sep 15, 2026: the last time Management sent this order back,
             -- so the approval queue can say "Resubmitted — sent back by
             -- Veronica: Change source". See the mapping below.
             sb.sent_back_by, sb.sent_back_at, sb.sent_back_meta,
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
      LEFT JOIN LATERAL (
        SELECT e.actor_name AS sent_back_by, e.created_at AS sent_back_at, e.metadata AS sent_back_meta
          FROM order_events e
         WHERE e.order_id = o.id AND e.event_type = 'MANAGEMENT_SENT_BACK'
         ORDER BY e.id DESC LIMIT 1
      ) sb ON TRUE
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // A resubmission is an order waiting for approval AGAIN after a Send
    // Back. A draft that was sent back is not one yet — it has not come back.
    const orders = rows.map(({ sent_back_by: by, sent_back_at: at, sent_back_meta: meta, ...o }) => {
      let reason = null;
      try {
        reason = JSON.parse(meta || '{}').reason || null;
      } catch {
        reason = null;
      }
      return { ...o, resubmission: o.status === 'pending_management_approval' && by ? { by, at, reason } : null };
    });

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
