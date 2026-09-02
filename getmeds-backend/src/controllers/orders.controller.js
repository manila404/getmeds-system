const db = require('../db/database');
const stateMachine = require('../workflow/stateMachine');
const { generateOrderId } = require('../services/orderIdService');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const zoho = require('../integrations/zoho');
const zohoRetryService = require('../services/zohoRetryService');
const { isDryRunMode, getTestCustomerZohoIds } = require('../services/zohoTestFlags');
// Sep 1, 2026: syncFromZoho below is the manual mirror of every webhook
// branch, so it uses the same two services the live handler does — status
// writes through the state machine, and one shared shipped-AND-paid rule.
// These used to be two hand-copied blocks that drifted apart.
const { setOrderStatus, advanceTo } = require('../services/orderStatusService');
const { evaluateCompletion } = require('../services/orderCompletionService');
// Sep 1, 2026 (3): the Zoho reconcile moved to its own service so the manual
// button, the refresh-on-open below, and the background poller all run one
// implementation instead of three copies. See zohoReconcileService.js.
const { reconcileOrder, reconcileOrderFully } = require('../services/zohoReconcileService');
const { shouldRefreshOnOpen, markRefreshed } = require('../services/zohoAutoSyncService');
// Sep 2, 2026: the MedRep -> Zoho Salesperson mapping ("<division> | <display
// name>", from sign-up) and the read-only check that Zoho actually knows that
// name. Zoho has Salesperson as a mandatory Sales Order field here.
const salespersonService = require('../services/salespersonService');
const { isTestModeEnabled } = require('../middleware/testMode');

/**
 * Which MedRep is this order actually FOR?
 *
 * Sep 2, 2026. Normally: whoever is logged in. In TEST_MODE an admin passes
 * every role gate (see middleware/auth.js's requireRole), and `resolveActor`
 * has always quietly attributed their order to the one seeded
 * medrep@getmeds.ph account — fine when there was one MedRep and no
 * per-MedRep anything, useless now that each carries their own Zoho
 * Salesperson. Testing "does an order from Aaron reach Zoho as
 * TEST | Aaron Manila" needs to be possible without logging out.
 *
 * So an admin may name the MedRep with `medrep_id` in the body. Four
 * conditions, all required, none of them skippable:
 *   - TEST_MODE is on;
 *   - the caller is an admin;
 *   - the id names a real, active user;
 *   - whose role is medrep.
 *
 * Outside TEST_MODE, or for anyone who is not an admin, `medrep_id` is
 * IGNORED rather than refused — it is a test affordance, and a stray field
 * from an old client must never silently move an order onto someone else's
 * name in normal operation. A bad id from an admin who IS allowed to use it
 * is a 400, because there the caller meant something specific and got it
 * wrong.
 *
 * Returns { actor, onBehalf } or { error }.
 */
function resolveOrderMedrep(user, requestedMedrepId) {
  const fallback = resolveActor(user, 'medrep');
  const asked = requestedMedrepId !== undefined && requestedMedrepId !== null && requestedMedrepId !== '';
  if (!asked) return { actor: fallback, onBehalf: false };

  const isAdmin = (user.role || '').toLowerCase() === 'admin';
  if (!isTestModeEnabled() || !isAdmin) return { actor: fallback, onBehalf: false };

  const target = db
    .prepare('SELECT id, name, email, role, salesperson FROM users WHERE id = ? AND is_active = 1')
    .get(requestedMedrepId);

  if (!target || (target.role || '').toLowerCase() !== 'medrep') {
    return {
      error: {
        code: 'INVALID_MEDREP',
        message: `medrep_id ${requestedMedrepId} is not an active MedRep account.`
      }
    };
  }
  return { actor: target, onBehalf: target.id !== user.id };
}

// How long GET /api/orders/:id will wait on Zoho before giving up and serving
// the order as it stands. Deliberately short — this is a page load, and the
// background poller will catch anything this misses.
const OPEN_REFRESH_TIMEOUT_MS = parseInt(process.env.ZOHO_OPEN_REFRESH_TIMEOUT_MS, 10) || 4000;

// ─── ZOHO TEST-CUSTOMER SAFETY GATE (Aug 27, 2026) ────────────────────────────
//
// While ZOHO_TEST_CUSTOMER_IDS is set (one or more Zoho contact ids), this
// app refuses to create a Zoho Sales Order for any customer other than one
// of those local rows — server-side, not just a filtered dropdown, so a
// direct API call can't bypass it either. Leave the env var unset to
// disable the gate entirely (all customers usable, as before).
//
// Aug 31, 2026 (6): widened from one customer to a list (TEST-CUSTOMER_1/
// 2/3) — testing needed more than one, e.g. to exercise both 'credit' and
// 'direct' customer_type paths side by side, without loosening the gate to
// "everyone" (see zohoTestFlags.js).
//
// Bypassed entirely while ZOHO_DRY_RUN is on: dry run mode never calls
// Zoho for ANY customer (see buildDryRunSalesOrder below), so there is
// nothing for this gate to protect against — restricting it would only
// get in the way of testing broadly against real customers pulled in via
// sync-from-zoho.
function checkTestCustomerGate(customer) {
  if (isDryRunMode()) return null; // dry run: no Zoho call happens for anyone, gate is moot
  const testZohoIds = getTestCustomerZohoIds();
  if (!testZohoIds.length) return null; // gate disabled
  if (testZohoIds.includes(customer.zoho_contact_id)) return null; // one of the allowed customers
  return {
    code: 'TEST_CUSTOMER_ONLY',
    message: `Order creation is currently restricted to the designated TEST customers only ` +
      `(safety gate while testing against the real company Zoho). "${customer.name}" is not one of them.`
  };
}

// ─── ZOHO DRY RUN (Aug 27, 2026) ───────────────────────────────────────────────
//
// While ZOHO_DRY_RUN=true, create/submit below skip the real
// zoho.createSalesOrder() call completely — no HTTP request is made, so it
// is structurally impossible for a dry-run order to write anything to
// Zoho, regardless of customer or ZOHO_MODE. This function fabricates a
// response shaped exactly like a real one (same fields the rest of this
// controller and the frontend already read: salesorder_id,
// salesorder_number, notes, line_items, ...) so the whole local flow —
// state machine, notifications, audit trail — runs precisely as it would
// against a real Zoho response. The fabricated id/number are prefixed
// DRYRUN- so nothing downstream could ever mistake one for a real Zoho
// Sales Order id.
function buildDryRunSalesOrder(payload) {
  const fakeId = `DRYRUN-${payload.getmeds_order_id}`;
  return {
    code: 0,
    message: 'Sales order NOT sent to Zoho — ZOHO_DRY_RUN is enabled',
    salesorder: {
      salesorder_id: fakeId,
      salesorder_number: fakeId,
      status: 'draft',
      customer_id: payload.zoho_customer_id || null,
      customer_name: payload.customer_name,
      total: payload.total_amount,
      reference_number: payload.getmeds_order_id,
      notes: `[DRY RUN — nothing was sent to Zoho] Getmeds Order: ${payload.getmeds_order_id}`,
      date: new Date().toISOString().slice(0, 10),
      line_items: (payload.items || []).map((item) => ({
        item_id: item.zoho_item_id || null,
        name: item.name,
        quantity: item.quantity,
        rate: item.unit_price,
        item_total: item.subtotal
      })),
      created_time: new Date().toISOString(),
      _dry_run: true
    }
  };
}

// ─── META ──────────────────────────────────────────────────────────────────────

// Aug 27, 2026: while ZOHO_TEST_CUSTOMER_IDS is set, this app is restricted
// to the designated TEST customer(s) for creating live Zoho Sales Orders
// (safety gate for testing against the real company Zoho — see
// customers.controller.js and the hard server-side check in create/submit
// below). The order-creation dropdown only ever shows those customers
// while the gate is on, so a MedRep never picks one that will be rejected.
// Leave ZOHO_TEST_CUSTOMER_IDS unset to see/select every local customer, as
// before.
//
// Aug 31, 2026 (6): widened from one id to a list — see checkTestCustomerGate.
exports.getCustomers = (req, res, next) => {
  try {
    const dryRun = isDryRunMode();
    // Dry run bypasses the gate everywhere (see checkTestCustomerGate), so
    // the dropdown shows every customer too — no point filtering it down
    // when no order created here can ever reach Zoho anyway.
    const testZohoIds = dryRun ? [] : getTestCustomerZohoIds();

    // Sep 2, 2026: active customers by default, with ?include_inactive=true
    // to see the rest — the same shape getProducts already uses for inactive
    // items, and for the same reason: "this client exists and is inactive in
    // Zoho" is far more useful to a MedRep than the client simply not
    // appearing and them assuming they mistyped the name. Inactive rows are
    // returned labelled (is_active = 0) and the form refuses to select one,
    // since Zoho rejects a Sales Order raised against an inactive contact.
    const includeInactive = req.query.include_inactive === 'true';

    // Sep 2, 2026 (2): SEARCH AND LIMIT, server-side.
    //
    // This used to return every customer, unbounded. That was survivable at
    // a few hundred and became unusable the moment the real org synced in:
    // ~95,000 rows of SELECT * shipped to the browser on page load, then
    // re-filtered in JavaScript on every keystroke, then rendered as
    // however many thousand <li> a one-letter query matches. The order
    // form's customer box lagged for exactly that reason.
    //
    // The Clients Directory already solved this — its suggestion dropdown
    // is a small `limit`-bounded server query (see customers.controller.js's
    // getCustomersOverview). This brings the order form in line.
    const search = (req.query.search || '').trim();
    const category = (req.query.category || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));

    const where = [];
    const params = [];
    if (!includeInactive) where.push('is_active = 1');
    if (testZohoIds.length) {
      where.push(`zoho_contact_id IN (${testZohoIds.map(() => '?').join(',')})`);
      params.push(...testZohoIds);
    }
    if (search) {
      where.push('(name LIKE ? OR contact_person LIKE ? OR contact_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Active first, so the ones a MedRep can actually order for are never
    // buried under inactive ones with alphabetically earlier names.
    const customers = db
      .prepare(`SELECT * FROM customers ${whereSql} ORDER BY is_active DESC, name LIMIT ?`)
      .all(...params, limit);

    // So the UI can say "showing 25 of 1,240" rather than implying the list
    // is everything there is.
    const totalMatching = db
      .prepare(`SELECT COUNT(*) c FROM customers ${whereSql}`)
      .get(...params).c;

    // How many the toggle would add, counted under the same gate so the
    // number always matches what turning it on actually shows.
    const inactiveWhere = ['is_active = 0'];
    if (testZohoIds.length) {
      inactiveWhere.push(`zoho_contact_id IN (${testZohoIds.map(() => '?').join(',')})`);
    }
    const inactiveCount = db
      .prepare(`SELECT COUNT(*) c FROM customers WHERE ${inactiveWhere.join(' AND ')}`)
      .get(...testZohoIds).c;

    res.json({
      success: true,
      data: {
        customers,
        total_matching: totalMatching,
        limit,
        inactive_count: inactiveCount,
        includes_inactive: includeInactive,
        test_customer_gate_enabled: testZohoIds.length > 0,
        zoho_dry_run_enabled: dryRun
      }
    });
  } catch (err) { next(err); }
};

exports.getProducts = (req, res, next) => {
  try {
    // Sep 1, 2026 (7): inactive products are returned too, so the order form
    // can LABEL them rather than silently omitting them. They are not
    // selectable there (Zoho rejects an inactive item on a Sales Order — see
    // the validation in create/submit), but "this medicine exists and is
    // deactivated in Zoho" is far more useful to a MedRep than the product
    // not appearing at all and them assuming they mistyped the name.
    const products = db.prepare('SELECT * FROM products ORDER BY is_active DESC, name').all();
    res.json({ success: true, data: { products } });
  } catch (err) { next(err); }
};

/**
 * GET /api/orders/meta/salesperson — is the caller's Salesperson real?
 *
 * Sep 2, 2026. Zoho has "Salesperson" as a MANDATORY field on Sales Orders
 * in this org and matches it by name, so an order naming a Salesperson Zoho
 * has never heard of is rejected on submit — after the MedRep has filled in
 * the whole form. The order form asks this on open and warns instead.
 *
 * Read-only towards Zoho (listSalespersons), and answers cached for a few
 * minutes in salespersonService so re-opening the form doesn't re-read.
 *
 * Never fails the request: "could not reach Zoho" comes back as
 * checked:false rather than a 5xx, because not being able to check is not
 * the same as the name being wrong, and the form should say so precisely.
 */
/**
 * GET /api/orders/meta/medreps — who can this order be raised for?
 *
 * Sep 2, 2026. Only ever non-empty for an admin in TEST_MODE; everyone else
 * gets `{ enabled: false, medreps: [] }`. Deliberately a 200 with an empty
 * list rather than a 403: the order form calls this unconditionally and uses
 * `enabled` to decide whether to render the picker at all, so the BACKEND
 * decides who sees it. The alternative — the frontend checking
 * VITE_TEST_MODE — would put the same decision in two places that can drift,
 * and the one that matters is the server's, since it is the server that
 * honours or ignores `medrep_id` on create.
 *
 * `salesperson` comes along so the form can show what each choice would put
 * on the Zoho Sales Order without a second call per rep.
 */
exports.getMedreps = (req, res, next) => {
  try {
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    if (!isTestModeEnabled() || !isAdmin) {
      return res.json({ success: true, data: { enabled: false, medreps: [] } });
    }
    const medreps = db
      .prepare(
        `SELECT id, name, email, display_name, division, sub_division, salesperson
         FROM users
         WHERE LOWER(role) = 'medrep' AND is_active = 1
         ORDER BY COALESCE(NULLIF(TRIM(display_name), ''), name)`
      )
      .all();
    res.json({ success: true, data: { enabled: true, medreps } });
  } catch (err) { next(err); }
};

exports.getSalespersonStatus = async (req, res, next) => {
  try {
    const status = await salespersonService.statusForUser(req.user.id, {
      force: req.query.refresh === 'true'
    });
    res.json({ success: true, data: status });
  } catch (err) { next(err); }
};

// ─── LIST / GET ────────────────────────────────────────────────────────────────

exports.getAll = (req, res, next) => {
  try {
    const { status, customer_type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    let params = [];

    // MedReps only see their own orders
    if (req.user.role === 'medrep') {
      where.push('o.medrep_id = ?');
      params.push(req.user.id);
    }
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customer_type) { where.push('o.customer_type = ?'); params.push(customer_type); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = db.prepare(`
      SELECT o.*, c.name as customer_name, c.type as customer_type_detail,
             u.name as medrep_name,
             p.status as payment_status,
             d.status as dispatch_status, d.tracking_number, d.courier
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN payments p ON o.id = p.order_id
      LEFT JOIN dispatch_records d ON o.id = d.order_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const totalRow = db.prepare(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`
    ).get(...params);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          total: totalRow.total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(totalRow.total / parseInt(limit))
        }
      }
    });
  } catch (err) { next(err); }
};

exports.getById = async (req, res, next) => {
  try {
    const loadOrder = () => db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_person, c.contact_number,
             u.name as medrep_name, u.email as medrep_email
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    let order = loadOrder();

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });

    // MedRep can only see their own orders
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    // Sep 1, 2026 (3): pull this order's current state from Zoho before
    // answering, so the trail a human is looking at is up to date without
    // them clicking "Sync from Zoho" first. Throttled by
    // orders.last_reconciled_at (see zohoAutoSyncService) — the frontend
    // re-fetches on a timer, and without a cooldown one open Order Detail
    // page would produce a continuous stream of Zoho reads for one order.
    //
    // Deliberately best-effort: reconcileOrder never throws, and a failure is
    // ignored here. Zoho being unreachable must not turn viewing an order
    // into an error page — the poller will catch it up shortly, and the
    // reason is in the server log either way.
    //
    // Sep 1, 2026 (4): the whole block is wrapped, and bounded by a timeout.
    // The first version was neither, and it broke this page the same day: the
    // stamp write threw "no such column: last_reconciled_at" on a database
    // that hadn't been migrated yet, the exception escaped, and Order Detail
    // showed "Failed to load order" — a convenience feature taking down the
    // page whose entire job is displaying the order.
    //
    // The rule now: showing the order is the contract, refreshing it is a
    // bonus. NOTHING in here — a missing column, a Zoho outage, a slow
    // response — may prevent the order from being returned. The timeout
    // matters as much as the catch: a Zoho call that hangs for 30 seconds
    // would otherwise leave the user staring at a spinner. If we stop waiting,
    // the reconcile still finishes in the background and its results show up
    // on the next load; the poller is the backstop either way.
    try {
      if (shouldRefreshOnOpen(order)) {
        const reconcile = reconcileOrderFully({
          orderId: order.id,
          actorId: req.user?.id || null,
          actorName: `${req.user?.name || 'User'} (opened the order)`,
          source: 'page_open'
        });
        const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), OPEN_REFRESH_TIMEOUT_MS));
        const outcome = await Promise.race([reconcile, timeout]);

        if (outcome?.timedOut) {
          console.warn(`[ORDER_OPEN] Zoho refresh for order ${order.id} exceeded ${OPEN_REFRESH_TIMEOUT_MS}ms — serving what we have.`);
          // Stamp anyway once it eventually lands, so a permanently slow Zoho
          // doesn't make every page load start another overlapping call.
          reconcile.then(() => markRefreshed(order.id)).catch(() => {});
        } else {
          markRefreshed(order.id);
        }
        order = loadOrder() || order;
      }
    } catch (err) {
      console.warn(`[ORDER_OPEN] Zoho refresh for order ${order.id} failed (order still served): ${err.message}`);
    }

    const items = db.prepare(`
      SELECT oi.*, p.name as product_name, p.sku, p.unit
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(order.id);

    const payment = db.prepare(`
      SELECT p.*, u.name as verified_by_name
      FROM payments p
      LEFT JOIN users u ON p.verified_by = u.id
      WHERE p.order_id = ?
    `).get(order.id);

    const dispatch = db.prepare(`
      SELECT d.*, u.name as dispatched_by_name
      FROM dispatch_records d
      LEFT JOIN users u ON d.dispatched_by = u.id
      WHERE d.order_id = ?
    `).get(order.id);

    const events = db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC'
    ).all(order.id);

    res.json({ success: true, data: { order, items, payment, dispatch, events } });
  } catch (err) { next(err); }
};

// ─── ZOHO RECONCILE (manual fallback for a missed webhook) ────────────────────
//
// The webhook in webhook.controller.js is the primary way this app hears
// "the Sales Order was confirmed in Zoho" — but it only arrives if the
// backend + ngrok tunnel were actually running and reachable at the exact
// moment Finance clicked Confirm. If they weren't (dev server restarted,
// ngrok's free-tier URL rotated, whatever), Zoho does not retry, and the
// confirmation silently never reaches this app — the order's audit trail
// just stops at "ORDER SUBMITTED" even though Zoho itself shows Confirmed.
//
// This endpoint is the fallback: it asks Zoho directly for this order's
// Sales Order right now and, if Zoho reports it Confirmed/Open (or
// Void/Cancelled) but that hasn't been logged yet, backfills the exact same
// audit trail entry + notification the webhook would have written — same
// event type, same status transition, just stamped with the current time
// (Zoho's API doesn't expose *when* the SO was confirmed, only its current
// state, so "the moment this was noticed" is the closest available
// timestamp). Idempotent — safe to call repeatedly.
exports.syncFromZoho = async (req, res, next) => {
  try {
    // Sep 1, 2026 (3): the reconcile logic that used to live here now lives in
    // services/zohoReconcileService.js, so the background poller and the
    // refresh-on-open path run the exact same code as this button rather than
    // a second copy that would drift. All that is left here is what is
    // genuinely HTTP: who is allowed to ask, and what the response looks like.
    const owner = db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(req.params.id);
    if (!owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && owner.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    const result = await reconcileOrder({
      orderId: req.params.id,
      actorId: req.user?.id || null,
      actorName: `${req.user?.name || 'User'} (manual Zoho sync)`,
      source: 'manual_reconcile'
    });

    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'NO_ZOHO_SO' ? 400 : 502;
      return res.status(status).json({ success: false, error: { code: result.code, message: result.message } });
    }

    res.json({
      success: true,
      data: {
        action: result.action,
        zoho_status: result.zohoStatus,
        order: result.order,
        events: result.events
      }
    });
  } catch (err) { next(err); }
};

// Manual, on-demand PUSH of a failed Zoho Sales Order sync — the opposite
// direction from syncFromZoho above (which pulls). Added Aug 30, 2026 when
// the automatic 30s background retry loop (zohoRetryService.start(), see
// server.js) was switched off by default: a failed sync used to keep
// retrying itself forever, filling the audit timeline with repeats while a
// real problem was being diagnosed. This is the replacement — a single
// explicit retry per click, with no backoff window to wait out (unlike the
// background loop, it ignores zoho_sync_queue.next_attempt_at and
// zoho_sync_queue.status entirely, so it works even on a row already
// marked 'failed_permanent' after exhausting its automatic attempts).
exports.retryZohoSync = async (req, res, next) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name, u.email as medrep_email, u.id as medrep_user_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    if (order.zoho_sync_status !== 'failed') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOTHING_TO_RETRY',
          message: `This order's Zoho sync status is '${order.zoho_sync_status}', not 'failed' — there is nothing queued to retry.`
        }
      });
    }

    // Most recent queue row for this order, regardless of its own status —
    // deliberately not filtered to status='pending' so a row that already
    // hit 'failed_permanent' (5 automatic attempts exhausted) can still be
    // retried manually here.
    const row = db.prepare(`
      SELECT * FROM zoho_sync_queue WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(order.id);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_QUEUED', message: 'No Zoho sync record was found queued for this order.' }
      });
    }

    const result = await zohoRetryService.processOne(row);
    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

    res.json({ success: true, data: { order: updatedOrder, result } });
  } catch (err) { next(err); }
};

exports.getEvents = (req, res, next) => {
  try {
    const events = db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC'
    ).all(req.params.id);
    res.json({ success: true, data: { events } });
  } catch (err) { next(err); }
};

// ─── CREATE (DRAFT) ───────────────────────────────────────────────────────────

exports.create = async (req, res, next) => {
  try {
    const {
      customer_id, items, delivery_address, delivery_notes, customer_type, status: requestedStatus,
      // Aug 27, 2026: optional order-intake fields matching the MedRep's
      // paper/spreadsheet order form (see schema.sql's `orders` table
      // comment). Purely informational — never required, and never part of
      // the Zoho payload built below (zohoPayload only ever carries
      // customer/items/address/total). courier/hospital_name/patient_name/
      // mode_of_payment/pls_give_note are kept accepted here for backward
      // compatibility (tests/orderIntakeFields.test.js, and any older
      // client) even though the Aug 30, 2026 order form redesign no longer
      // collects them.
      courier, doctor_name, hospital_name, patient_name, mode_of_payment,
      receiver_name, receiver_contact_no, order_source, pls_give_note,
      // Aug 30, 2026: "Create New Order" form redesign — see schema.sql's
      // `orders`/`order_items` comments and ZOHO_SALES_ORDER_FIELD_MAPPING.md.
      // All optional server-side (so older clients / the tests above keep
      // working unchanged) even though the new form marks Source and
      // Invoicing From as required — that's a client-side UX guarantee, not
      // a data-integrity one this endpoint should enforce by rejecting
      // requests from anything else that talks to this API.
      delivery_method, terms, invoicing_from,
      // Aug 30, 2026 (2): Payment Terms — mirrors the same-named field on
      // Zoho's own Sales Order screen (Net 15 / 30 days / 45 Day /
      // BPO WALLET / 60 Day / DSWD/PCSO, or a custom typed value). Same
      // "optional, free text, not wired into the Zoho payload yet" pattern
      // as delivery_method/terms above.
      payment_terms,
      // Sep 2, 2026: TEST_MODE + admin only — raise this order for a named
      // MedRep instead of the seeded stand-in. See resolveOrderMedrep above
      // for the four conditions and why it is ignored rather than refused
      // everywhere else.
      medrep_id
    } = req.body;
    const clean = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    const medrepChoice = resolveOrderMedrep(req.user, medrep_id);
    if (medrepChoice.error) {
      return res.status(400).json({ success: false, error: medrepChoice.error });
    }
    const effectiveActor = medrepChoice.actor;
    const onBehalfOf = medrepChoice.onBehalf;
    // Salesperson + Division + Sub-division, from the MedRep the order is
    // FOR (not whoever is clicking) — one read, so they cannot disagree.
    const medrepProfile = salespersonService.profileForUser(effectiveActor.id);

    const ALLOWED_INVOICING_FROM = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

    // Validation
    if (!customer_id) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'customer_id is required' } });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'At least one order item is required' } });
    if (!delivery_address) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'delivery_address is required' } });
    if (invoicing_from != null && clean(invoicing_from) && !ALLOWED_INVOICING_FROM.includes(clean(invoicing_from))) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `invoicing_from must be one of: ${ALLOWED_INVOICING_FROM.join(', ')}`
        }
      });
    }

    // Verify customer exists
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND is_active = 1').get(customer_id);
    if (!customer) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });

    const gateError = checkTestCustomerGate(customer);
    if (gateError) return res.status(403).json({ success: false, error: gateError });

    const resolvedCustomerType = customer.type || customer_type || 'direct';

    // Calculate totals and validate products
    let total_amount = 0;
    const resolvedItems = [];
    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Each item needs product_id and quantity > 0' } });
      }
      // Sep 1, 2026 (7): tell the difference between "no such product" and
      // "that product is deactivated in Zoho". Both used to answer NOT_FOUND,
      // which was actively misleading now that the order form lists inactive
      // items — a MedRep would see the medicine on screen and be told it does
      // not exist. Zoho rejects an inactive item on a Sales Order
      // ("Inactive items cannot be added to the sales order"), so this is the
      // same refusal, just made early and in words that explain it.
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Product ${item.product_id} not found` } });
      if (!product.is_active) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PRODUCT_INACTIVE',
            message: `"${product.name}" is marked Inactive in Zoho and cannot be added to a Sales Order. Reactivate it in Zoho, run an inventory sync, then try again.`
          }
        });
      }

      // Aug 30, 2026: Rate is now an editable line-item field on the order
      // form (matching a Zoho Sales Order line item, which always allows
      // overriding the catalog rate) — falls back to the product's catalog
      // price when not sent, so every existing caller that never sent a
      // rate (older frontend, the tests above) behaves exactly as before.
      const rate = (item.rate !== undefined && item.rate !== null && item.rate !== '')
        ? Math.max(0, Number(item.rate))
        : product.unit_price;
      const subtotal = rate * item.quantity;

      // Per-line Discount (flat currency amount) and Tax (simple flat-rate
      // preset, e.g. "VAT 12%") — both default to zero/none, so an item
      // that doesn't send them produces line_total === subtotal, unchanged
      // from before this field existed.
      const discountAmount = Math.min(subtotal, Math.max(0, Number(item.discount) || 0));
      const taxPercent = Math.max(0, Number(item.tax_percent) || 0);
      const taxableBase = subtotal - discountAmount;
      const taxAmount = taxableBase * (taxPercent / 100);
      const lineTotal = taxableBase + taxAmount;

      total_amount += lineTotal;
      resolvedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: rate,
        subtotal,
        discount_amount: discountAmount,
        tax_percent: taxPercent,
        tax_label: clean(item.tax_label),
        line_total: lineTotal,
        sku: product.sku,
        name: product.name,
        zoho_item_id: product.zoho_item_id,
        unit: product.unit
      });
    }

    // 1. Generate unique Getmeds Order ID (GM-YYYYMMDD-XXXX)
    const getmedsOrderId = generateOrderId();
    const isDraft = requestedStatus === 'draft';
    const isCredit = resolvedCustomerType === 'credit';
    // Sep 1, 2026: same change as submit() below — a credit order stops at
    // 'so_created' until Zoho confirms the Sales Order, instead of landing
    // in the Dispatch queue while the SO is still an unconfirmed Draft. This
    // path (create-and-submit in one call) had its own copy of the rule, so
    // it had to be fixed in both places or the two entry points would
    // disagree about where a credit order starts.
    const finalStatus = isDraft ? 'draft' : (isCredit ? 'so_created' : 'ready_for_draft_invoice');
    const now = new Date().toISOString();
    // "Sales Order Date (Automatic Today)" on the form — always set here,
    // server-side, to today's date. There is no client override; a
    // sales_order_date sent in the request body (there isn't one — the
    // frontend never sends it) would be ignored regardless.
    const salesOrderDate = now.slice(0, 10);

    // 2. Create Zoho SO *before* opening the DB transaction below.
    let zohoResult = null;
    let zohoSyncStatus = 'pending';
    let zohoError = null;
    const zohoPayload = {
      getmeds_order_id: getmedsOrderId,
      customer_name: customer.name,
      customer_type: resolvedCustomerType,
      customer_master_type: customer.type,
      zoho_customer_id: customer.zoho_contact_id || null,
      total_amount,
      delivery_address,
      items: resolvedItems,
      // Aug 30, 2026 (3): wired to Zoho's "Doctor Name" / "Source" custom
      // fields on the Sales Order (see LiveZohoAdapter.createSalesOrder —
      // confirmed live via ZohoInventory_get_sales_order that this org
      // already has both configured, with matching customfield_ids).
      doctor_name: clean(doctor_name),
      order_source: clean(order_source),
      // Aug 30, 2026 (4): wired to Zoho's "Invoicing From" custom field —
      // same discovery as Doctor Name/Source: this org already has
      // cf_invoicing_from configured (not a separate Zoho organization, as
      // ZOHO_SALES_ORDER_FIELD_MAPPING.md previously assumed before this
      // was checked live).
      invoicing_from: clean(invoicing_from),
      // Sep 2, 2026: the ordering MedRep's own Salesperson —
      // "<division> | <display name>" from their sign-up, generated in the
      // database (users.salesperson).
      //
      // Keyed off effectiveActor, NOT req.user: in TEST_MODE an admin can
      // raise the order for a named MedRep (see resolveOrderMedrep), and the
      // Sales Order has to carry that rep's Salesperson — attributing it to
      // the admin would defeat the entire point of being able to choose.
      // Same row that goes into orders.medrep_id below, so the two can never
      // disagree.
      //
      // NULL for an account created before sign-up collected a division
      // (the seeded logins), in which case LiveZohoAdapter falls back to
      // the TEST | MEDREP stand-in for TestGM- orders and to nothing for a
      // real one — see the note there.
      salesperson_name: medrepProfile.salesperson,
      // Sep 2, 2026: Division / Sub-division — this org's own Sales Order
      // custom fields (cf_division / cf_sub_division), read from the same
      // user row as the Salesperson above so all three agree.
      division: medrepProfile.division,
      sub_division: medrepProfile.sub_division
    };
    // Aug 30, 2026: delivery_method, terms, and each line's discount/tax are
    // all captured and stored below (in the orders/order_items tables) but
    // are still NOT added to this payload — wiring each into an actual Zoho
    // call is a deliberately separate, later piece of work (Doctor
    // Name/Source/Invoicing From are the first fields off that list to
    // actually get wired — see above). See
    // ZOHO_SALES_ORDER_FIELD_MAPPING.md for exactly which Zoho Sales Order
    // field each remaining one is meant to land on.
    //
    // Only ever creates the Zoho Sales Order (as a plain Draft — nothing
    // here confirms it). Confirming, invoicing, and recording payment all
    // happen directly in Zoho by Finance now, never through this app.
    if (!isDraft) {
      if (isDryRunMode()) {
        // ZOHO_DRY_RUN=true — no HTTP call to Zoho is made at all.
        zohoResult = buildDryRunSalesOrder(zohoPayload);
        zohoSyncStatus = 'skipped';
      } else {
        try {
          zohoResult = await zoho.createSalesOrder(zohoPayload);
          zohoSyncStatus = 'synced';
        } catch (err) {
          zohoSyncStatus = 'failed';
          zohoError = err.message;
          console.error(`[ZOHO] createSalesOrder failed for ${getmedsOrderId} — order will still be created and queued for automatic retry:`, err.message);
        }
      }
    }

    const createOrderTxn = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO orders (
          getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
          delivery_address, delivery_notes,
          intake_courier, intake_doctor, intake_hospital, intake_patient, intake_mop,
          intake_receiver, intake_contact_no, intake_source, intake_pls_give,
          sales_order_date, intake_delivery_method, intake_terms, intake_payment_terms, invoicing_from,
          zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status,
          created_at, submitted_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        getmedsOrderId,
        customer_id,
        effectiveActor.id,
        finalStatus,
        resolvedCustomerType,
        total_amount,
        delivery_address,
        delivery_notes || null,
        clean(courier),
        clean(doctor_name),
        clean(hospital_name),
        clean(patient_name),
        clean(mode_of_payment),
        clean(receiver_name),
        clean(receiver_contact_no),
        clean(order_source),
        clean(pls_give_note),
        salesOrderDate,
        clean(delivery_method),
        clean(terms),
        clean(payment_terms),
        clean(invoicing_from),
        zohoResult ? zohoResult.salesorder.salesorder_id : null,
        zohoResult ? zohoResult.salesorder.salesorder_number : null,
        // Sep 1, 2026: seed the Zoho-side status ('draft' as Zoho creates
        // it). Without this baseline the first "Confirm" in Zoho had nothing
        // to diff against and logged "no change detected in the fields this
        // app tracks" instead of "confirmed" — see submit() below.
        zohoResult ? (zohoResult.salesorder.status || 'draft') : null,
        zohoSyncStatus,
        now,
        isDraft ? null : now,
        now
      );

      const orderId = result.lastInsertRowid;

      // Insert line items
      const insItem = db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, quantity, unit_price, subtotal,
          discount_amount, tax_percent, tax_label, line_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ri of resolvedItems) {
        insItem.run(
          orderId, ri.product_id, ri.quantity, ri.unit_price, ri.subtotal,
          ri.discount_amount, ri.tax_percent, ri.tax_label, ri.line_total
        );
      }

      // 2. Evaluate Workflow Gate & Create Child Records
      if (!isDraft) {
        if (isCredit) {
          db.prepare("INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'queued', datetime('now'))").run(orderId);
        } else {
          db.prepare("INSERT INTO payments (order_id, status, created_at) VALUES (?, 'pending', datetime('now'))").run(orderId);
        }

        // 3. Trigger Audit Trail (ORDER_SUBMITTED in the same transaction)
        logEvent({
          orderId,
          eventType: 'ORDER_SUBMITTED',
          oldStatus: 'draft',
          newStatus: finalStatus,
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          notes:
            `Order submitted for ${customer.name} (${isCredit ? 'Credit Fast-Track' : 'Direct Patient Payment Queue'})` +
            // Sep 2, 2026: an order raised by an admin FOR a MedRep is
            // attributed to that MedRep everywhere else, which is what makes
            // the Zoho Salesperson right — so the trail has to say who
            // actually clicked, or the attribution becomes untraceable.
            (onBehalfOf ? ` — raised by ${req.user.name} (admin, Test Mode) on behalf of ${effectiveActor.name}` : ''),
          metadata: onBehalfOf
            ? { onBehalfOf: true, raisedByUserId: req.user.id, raisedByName: req.user.name }
            : undefined
        });

        if (zohoSyncStatus === 'failed') {
          zohoRetryService.enqueue({ orderId, payload: zohoPayload, error: zohoError });
          logEvent({
            orderId,
            eventType: 'ZOHO_SYNC_FAILED',
            oldStatus: finalStatus,
            newStatus: finalStatus,
            actorName: 'System',
            notes: `Zoho sync failed, order proceeds normally and sync is queued for automatic retry: ${zohoError}`
          });
        }
      } else {
        logEvent({
          orderId,
          eventType: 'ORDER_CREATED',
          newStatus: 'draft',
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          notes:
            'Draft order created' +
            (onBehalfOf ? ` — raised by ${req.user.name} (admin, Test Mode) on behalf of ${effectiveActor.name}` : ''),
          metadata: onBehalfOf
            ? { onBehalfOf: true, raisedByUserId: req.user.id, raisedByName: req.user.name }
            : undefined
        });
      }

      return { orderId, getmedsOrderId, finalStatus, isCredit, zohoResult };
    });

    const { orderId } = createOrderTxn();

    // Trigger Notifications outside transaction
    if (!isDraft) {
      const orderDataForNotif = {
        getmeds_order_id: getmedsOrderId,
        customer_name: customer.name,
        status: finalStatus,
        medrep_email: req.user.email
      };

      notify({
        orderId,
        recipientIds: [req.user.id],
        message: `Your order ${getmedsOrderId} for ${customer.name} has been submitted (${isCredit ? 'Sales Order drafted in Zoho — awaiting confirmation' : 'Waiting for Finance Payment Verification'}).`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      if (!isCredit) {
        const financeIds = getUserIdsByRole('finance');
        notify({ orderId, recipientIds: financeIds, message: `New direct patient order ${getmedsOrderId} requires payment verification.`, eventType: 'PAYMENT_VERIFICATION_REQUIRED', orderData: orderDataForNotif });
      } else {
        const dispatchIds = getUserIdsByRole('dispatch');
        notify({ orderId, recipientIds: dispatchIds, message: `New credit order ${getmedsOrderId} is ready for dispatch.`, eventType: 'ORDER_READY_FOR_DISPATCH', orderData: orderDataForNotif });
      }
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    res.status(201).json({ success: true, data: { order } });
  } catch (err) { next(err); }
};

// ─── SUBMIT ───────────────────────────────────────────────────────────────────

exports.submit = async (req, res, next) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name as customer_name, c.type as customer_master_type, c.contact_number, c.zoho_contact_id as customer_zoho_contact_id, u.name as medrep_name, u.email as medrep_email, u.salesperson as medrep_salesperson, u.division as medrep_division, u.sub_division as medrep_sub_division
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your order' } });
    }
    if (order.status !== 'draft') {
      return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: `Order is already ${order.status}, cannot submit` } });
    }
    const gateError = checkTestCustomerGate({ name: order.customer_name, zoho_contact_id: order.customer_zoho_contact_id });
    if (gateError) return res.status(403).json({ success: false, error: gateError });

    const items = db.prepare(`
      SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id);

    // Step 1: submitted → validating → so_pending → so_created
    const getmedsOrderId = generateOrderId();
    const now = new Date().toISOString();

    // Step 2: Create Zoho SO. Done *before* opening the DB transaction
    // below for the same reason as in `create` above — better-sqlite3
    // transactions can't contain an `await`, and this call is async
    // (mock, http-mock, or live depending on ZOHO_MODE).
    //
    // Fail-safe, not fail-closed: a Zoho rejection here does not abort the
    // submission or leave the order stuck in `draft` — it still advances
    // through the state machine with zoho_sync_status='failed' and gets
    // queued for automatic background retry (see zohoRetryService).
    const zohoPayload = {
      getmeds_order_id: getmedsOrderId,
      customer_name: order.customer_name,
      customer_type: order.customer_type,
      customer_master_type: order.customer_master_type,
      zoho_customer_id: order.customer_zoho_contact_id || null,
      total_amount: order.total_amount,
      delivery_address: order.delivery_address,
      items,
      // Same wiring as `create` above — pulled from the draft row this
      // order was created from rather than req.body, since submit() acts
      // on an already-stored draft.
      doctor_name: order.intake_doctor,
      order_source: order.intake_source,
      invoicing_from: order.invoicing_from,
      // Sep 2, 2026: the Salesperson of the MedRep the ORDER belongs to
      // (order.medrep_id), not whoever is submitting it — an admin
      // submitting on someone's behalf must not have the Sales Order
      // attributed to them. Comes from the users join in the query above.
      salesperson_name: order.medrep_salesperson || null,
      division: order.medrep_division || null,
      sub_division: order.medrep_sub_division || null
    };
    let zohoResult = null;
    let zohoSyncStatus = 'pending';
    let zohoError = null;
    // Only ever creates the Zoho Sales Order (as a plain Draft — nothing
    // here confirms it). Confirming, invoicing, and recording payment all
    // happen directly in Zoho by Finance now, never through this app.
    if (isDryRunMode()) {
      // ZOHO_DRY_RUN=true — no HTTP call to Zoho is made at all.
      zohoResult = buildDryRunSalesOrder(zohoPayload);
      zohoSyncStatus = 'skipped';
    } else {
      try {
        zohoResult = await zoho.createSalesOrder(zohoPayload);
        zohoSyncStatus = 'synced';
      } catch (err) {
        zohoSyncStatus = 'failed';
        zohoError = err.message;
        console.error(`[ZOHO] createSalesOrder failed for ${getmedsOrderId} — order will still be submitted and queued for automatic retry:`, err.message);
      }
    }

    const submitTxn = db.transaction(() => {
      // Step 3: Determine next status based on customer type.
      //
      // Sep 1, 2026: a CREDIT order now stops at 'so_created' instead of
      // running straight through to a dispatch-ready state. All this app has
      // done at this point is create a DRAFT Sales Order in Zoho — nobody
      // has confirmed it, and Finance may still void or edit it. Sending it
      // to ready_for_dispatch here put orders in the Dispatch queue that no
      // one had approved, and it also meant the later salesorder.confirmed
      // webhook found the order already past every status it knows how to
      // advance, so confirming in Zoho changed nothing. Credit orders are
      // now released by that webhook (see webhook.controller.js).
      //
      // A DIRECT order still goes to 'ready_for_draft_invoice' — unchanged, so
      // the Finance queue behaves exactly as before.
      const isCredit = (order.customer_type === 'credit' || order.customer_master_type === 'credit');
      const finalStatus = isCredit ? 'so_created' : 'ready_for_draft_invoice';

      // Seed the Zoho-side status as 'draft'. Sep 1, 2026: without this
      // baseline, the first time anyone confirmed the SO in Zoho the
      // "edited in Zoho" handler had a null previous value to compare
      // against, treated it as "just learning the baseline", and logged a
      // bland "no change detected in the fields this app tracks" instead of
      // "Sales Order confirmed in Zoho (draft → confirmed)". It only started
      // reading correctly from the SECOND status change onward.
      const initialZohoStatus = zohoResult ? (zohoResult.salesorder.status || 'draft') : null;

      db.prepare(`
        UPDATE orders SET
          getmeds_order_id = ?, customer_type = ?, status = ?, submitted_at = ?, updated_at = ?,
          zoho_so_id = ?, zoho_so_number = ?, zoho_so_status = ?, zoho_sync_status = ?
        WHERE id = ?
      `).run(getmedsOrderId, isCredit ? 'credit' : 'direct', finalStatus, now, now,
        zohoResult ? zohoResult.salesorder.salesorder_id : null,
        zohoResult ? zohoResult.salesorder.salesorder_number : null,
        initialZohoStatus,
        zohoSyncStatus,
        order.id);

      if (zohoSyncStatus === 'failed') {
        zohoRetryService.enqueue({ orderId: order.id, payload: zohoPayload, error: zohoError });
      }

      // Step 4: If direct patient, create payment record for Finance queue
      if (!isCredit) {
        db.prepare(`
          INSERT INTO payments (order_id, status, created_at)
          VALUES (?, 'pending', datetime('now'))
        `).run(order.id);
      }

      // Step 5: If credit customer, create dispatch record immediately
      if (isCredit) {
        db.prepare(`
          INSERT INTO dispatch_records (order_id, status, created_at)
          VALUES (?, 'queued', datetime('now'))
        `).run(order.id);
      }

      // Audit trail — log all status hops. Sep 1, 2026: the credit path now
      // ends at so_created; ready_for_dispatch is logged later, by the
      // salesorder.confirmed webhook that actually earns it.
      const statusPath = isCredit
        ? ['submitted', 'validating', 'so_pending', 'so_created']
        : ['submitted', 'validating', 'so_pending', 'so_created', 'ready_for_draft_invoice'];

      const effectiveActor = resolveActor(req.user, 'medrep');

      let prev = 'draft';
      for (const s of statusPath) {
        logEvent({ orderId: order.id, eventType: 'STATUS_CHANGE', oldStatus: prev, newStatus: s, actorId: effectiveActor.id, actorName: effectiveActor.name,
          notes: s === 'so_created'
            ? (zohoResult ? `Zoho SO created: ${zohoResult.salesorder.salesorder_number}` : `Zoho sync failed, queued for automatic retry: ${zohoError}`)
            : undefined });
        prev = s;
      }

      // Step 6: Notify
      const orderDataForNotif = { getmeds_order_id: getmedsOrderId, customer_name: order.customer_name, status: finalStatus, medrep_email: order.medrep_email };

      // 6a. Notify submitting MedRep
      notify({
        orderId: order.id,
        recipientIds: [effectiveActor.id],
        message: `Your order ${getmedsOrderId} for ${order.customer_name} has been submitted (${isCredit ? 'Sales Order drafted in Zoho — awaiting confirmation' : 'Waiting for Finance Payment Verification'}).`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      // 6b. Route notification based on customer type
      if (order.customer_type === 'direct') {
        const financeIds = getUserIdsByRole('finance');
        notify({ orderId: order.id, recipientIds: financeIds, message: `New direct patient order ${getmedsOrderId} requires payment verification.`, eventType: 'PAYMENT_VERIFICATION_REQUIRED', orderData: orderDataForNotif });
      } else {
        // Sep 1, 2026: Dispatch is told the order exists, not that it's
        // ready — it isn't until Zoho confirms the Sales Order. The
        // ORDER_READY_FOR_DISPATCH notification now fires from the
        // salesorder.confirmed webhook instead.
        const dispatchIds = getUserIdsByRole('dispatch');
        notify({ orderId: order.id, recipientIds: dispatchIds, message: `New credit order ${getmedsOrderId} drafted in Zoho — will reach dispatch once Finance confirms the Sales Order.`, eventType: 'ORDER_SUBMITTED', orderData: orderDataForNotif });
      }

      return { getmedsOrderId, finalStatus, zohoResult, zohoSyncStatus };
    });

    const result = submitTxn();
    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    res.json({
      success: true,
      data: {
        order: updatedOrder,
        zoho: result.zohoResult ? result.zohoResult.salesorder : null,
        zoho_sync_status: result.zohoSyncStatus
      }
    });
  } catch (err) { next(err); }
};

// ─── EXCEPTION / ON HOLD ──────────────────────────────────────────────────────

exports.setException = (req, res, next) => {
  try {
    const { reason, status } = req.body;
    const targetStatus = status === 'on_hold' ? 'on_hold' : 'exception';
    const effectiveActor = resolveActor(req.user, 'management');

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (!stateMachine.canTransition(order.status, targetStatus)) {
      return res.status(409).json({ success: false, error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${order.status} to ${targetStatus}` } });
    }

    const txn = db.transaction(() => {
      db.prepare('UPDATE orders SET status = ?, exception_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(targetStatus, reason || null, order.id);

      logEvent({ orderId: order.id, eventType: 'EXCEPTION_SET', oldStatus: order.status, newStatus: targetStatus, actorId: effectiveActor.id, actorName: effectiveActor.name, notes: reason });
    });
    txn();

    const medrepIds = [order.medrep_id];
    const mgmtIds = getUserIdsByRole('management');
    notify({ orderId: order.id, recipientIds: [...medrepIds, ...mgmtIds], message: `Order ${order.getmeds_order_id} is now ${targetStatus}. Reason: ${reason || 'None provided'}`, eventType: 'ORDER_EXCEPTION', orderData: order });

    res.json({ success: true, data: { status: targetStatus } });
  } catch (err) { next(err); }
};

// ─── EDIT ORDER ITEMS (Aug 31, 2026) ──────────────────────────────────────────
//
// Added after TestGM-20260831-0001 failed its Zoho sync with "Inactive
// items cannot be added to the sales order" — the order had already been
// created locally with a product that Zoho had since discontinued, and
// there was no way to fix it short of abandoning the order entirely.
// "Retry Zoho Sync" just resends the exact same (broken) line items, so it
// can never recover on its own from a bad item — only replacing the item
// does.
//
// Deliberately scoped to ONLY before a real Zoho Sales Order exists
// (order.zoho_so_id is still null). Once zoho_so_id is set, the Sales
// Order is a real record in Zoho — changing order_items here without also
// updating that Zoho record would silently desync the two, which is a
// different (harder, unsolved) problem than this endpoint is for. In
// practice that means this only ever helps while zoho_sync_status is
// 'failed' or 'pending' — exactly the case that motivated it.
//
// PATCH /api/orders/:id/items — body: { items: [{ product_id, quantity,
// rate?, discount?, tax_percent?, tax_label? }, ...] }. Re-validates and
// re-prices every line exactly like `create` above (same active-product
// check, same rate/discount/tax math), replaces order_items wholesale, and
// recomputes total_amount. Logs one ORDER_ITEMS_EDITED audit entry with a
// before/after summary so it's obvious from the trail alone what changed
// and why, without needing to diff raw item rows.
exports.updateItems = (req, res, next) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your order' } });
    }
    if (order.zoho_so_id) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_SYNCED',
          message: 'This order already has a Zoho Sales Order (' + (order.zoho_so_number || order.zoho_so_id) +
            ') — items can no longer be edited here, since Zoho\'s own record would then be out of date.'
        }
      });
    }
    if (order.status === 'cancelled') {
      return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Order is cancelled.' } });
    }

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'At least one order item is required' } });
    }

    // Same per-line validation/pricing as `create` above, kept in lockstep
    // deliberately (see that function's comments for why each piece exists)
    // — a product must still be active *right now*, so re-picking the exact
    // same now-inactive item is rejected here too, not just at Zoho's end.
    let total_amount = 0;
    const resolvedItems = [];
    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Each item needs product_id and quantity > 0' } });
      }
      // Sep 1, 2026 (7): tell the difference between "no such product" and
      // "that product is deactivated in Zoho". Both used to answer NOT_FOUND,
      // which was actively misleading now that the order form lists inactive
      // items — a MedRep would see the medicine on screen and be told it does
      // not exist. Zoho rejects an inactive item on a Sales Order
      // ("Inactive items cannot be added to the sales order"), so this is the
      // same refusal, just made early and in words that explain it.
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
      if (!product) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Product ${item.product_id} not found` } });
      if (!product.is_active) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PRODUCT_INACTIVE',
            message: `"${product.name}" is marked Inactive in Zoho and cannot be added to a Sales Order. Reactivate it in Zoho, run an inventory sync, then try again.`
          }
        });
      }

      const rate = (item.rate !== undefined && item.rate !== null && item.rate !== '')
        ? Math.max(0, Number(item.rate))
        : product.unit_price;
      const subtotal = rate * item.quantity;

      const discountAmount = Math.min(subtotal, Math.max(0, Number(item.discount) || 0));
      const taxPercent = Math.max(0, Number(item.tax_percent) || 0);
      const taxableBase = subtotal - discountAmount;
      const taxAmount = taxableBase * (taxPercent / 100);
      const lineTotal = taxableBase + taxAmount;

      total_amount += lineTotal;
      resolvedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: rate,
        subtotal,
        discount_amount: discountAmount,
        tax_percent: taxPercent,
        tax_label: (typeof item.tax_label === 'string' && item.tax_label.trim()) ? item.tax_label.trim() : null,
        line_total: lineTotal,
        name: product.name
      });
    }

    const oldItemsSummary = db.prepare(`
      SELECT oi.quantity, p.name FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id).map((r) => `${r.quantity}x ${r.name || 'Unknown product'}`).join(', ') || 'none';
    const newItemsSummary = resolvedItems.map((it) => `${it.quantity}x ${it.name}`).join(', ');

    const now = new Date().toISOString();
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, discount_amount, tax_percent, tax_label, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of resolvedItems) {
        insertItem.run(order.id, it.product_id, it.quantity, it.unit_price, it.subtotal, it.discount_amount, it.tax_percent, it.tax_label, it.line_total);
      }
      db.prepare('UPDATE orders SET total_amount = ?, updated_at = ? WHERE id = ?').run(total_amount, now, order.id);

      logEvent({
        orderId: order.id,
        eventType: 'ORDER_ITEMS_EDITED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: req.user?.id || null,
        actorName: req.user?.name || 'User',
        notes: `Order items changed before this order was sent to Zoho — was: ${oldItemsSummary}; now: ${newItemsSummary}. New total: ₱${total_amount.toFixed(2)}.`,
        metadata: { oldItemsSummary, newItemsSummary, total_amount }
      });
    });
    txn();

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const updatedItems = db.prepare(`
      SELECT oi.*, p.name as product_name, p.sku, p.unit
      FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id);

    res.json({ success: true, data: { order: updatedOrder, items: updatedItems } });
  } catch (err) { next(err); }
};
