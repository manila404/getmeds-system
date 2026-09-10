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
// Sep 10, 2026 (2c): the raw event list turned into a ten-stage pipeline, with
// everything that is not a stage collapsed underneath the stage it follows.
// See services/orderTimelineService.js.
const { buildTimeline, tierOf } = require('../services/orderTimelineService');
// Sep 9, 2026: the bulk "pull every Sales Order Zoho has" import, and the
// per-order mirror of Zoho's own Comments & History log. See
// services/zohoOrderImportService.js for why the trail needs both halves.
const { importSalesOrders, ingestSalesOrderLogs, IMPORT_MAX } = require('../services/zohoOrderImportService');
const syncJobs = require('../services/syncJobs');
const { getSyncState } = require('../services/syncState');
// Sep 9, 2026: the Master Form collects a TIN, and Zoho refuses a Sales Order
// for a business-subtype contact without one — so a TIN typed here has to
// reach the contact, not just the order. Shared with the Clients page.
const { setCustomerTin } = require('../services/customerTinService');
// Sep 2, 2026: the MedRep -> Zoho Salesperson mapping ("<division> | <display
// name>", from sign-up) and the read-only check that Zoho actually knows that
// name. Zoho has Salesperson as a mandatory Sales Order field here.
const salespersonService = require('../services/salespersonService');
const { isTestModeEnabled } = require('../middleware/testMode');

// Sep 5, 2026 (3): mirrors auth.controller.js's SUB_DIVISIONS_BY_DIVISION
// exactly — see that file's comment for why only these four Divisions have
// a fixed Sub-division list. Needed here, separately from the account-level
// version, because Sub-division is now something the person RAISING the
// order can type/pick per order (see create() below) rather than only ever
// being read from the ordering MedRep's account — so a value submitted on
// an order has to be checked against the SAME list a moment before it goes
// to Zoho, not just once at sign-up/profile-save time.
const SUB_DIVISIONS_BY_DIVISION = {
  'B&B': ['CEBU', 'DAVAO', 'E. RODRIGUEZ', 'EAST AVE', 'NCL', 'SOUTH LUZON', 'TAFT'],
  HOS: [
    'GENSAN',
    'PALAWAN',
    'BAGUIO',
    'BICOL',
    'CABANATUAN',
    'CAMANAVA',
    'CAVITE',
    'CDO',
    'COMMONWEALTH',
    'DAVAO NORTH',
    'DAVAO SOUTH',
    'ILOILO',
    'LAGUNA',
    'LAS PINAS',
    'MANILA VACANT',
    'MARIKINA',
    'NORTH CEBU',
    'PAMPANGA',
    'PARANAQUE',
    'PASAY',
    'QUEZON PROVINCE',
    'SOUTH CEBU',
    'TUGUEGARAO',
    'ZAMBOANGA',
  ],
  STC: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
  URO: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
};

// Sep 5, 2026 (4): mirrors auth.controller.js's DIVISIONS exactly. Needed
// here, separately from the account-level version, for the same reason
// SUB_DIVISIONS_BY_DIVISION above is duplicated: Division can now also be
// typed manually ON AN ORDER — but only by Management (see create()'s
// effectiveDivision) — so a value submitted on an order has to be checked
// against the same 15-item list a moment before it goes to Zoho, not just
// once at sign-up/profile-save time.
// Sep 9, 2026: '2MG Incorporated', 'Office of the President', 'PCSO', 'DSWD'
// and 'GrabMart' removed at the user's request. Verified against the live
// database first: no user and no order carried any of the five, so nothing
// existing is stranded on a value this list no longer accepts.
//
// That check matters because `division` has no CHECK constraint — the column
// keeps whatever was written to it, and validation happens only on the way in
// (auth.controller.js at sign-up/profile, orders.controller.js at create and
// at PATCH /:id/details). A row already holding a removed value would keep
// working everywhere except the next save, which would then refuse it with
// "division must be one of ..." for a value the account already has.
// Sep 10, 2026: 'TeleSales', 'MD Telesales' and 'PS' added.
//
// Not new business units — they were already in use in Zoho and always had
// been. Found while auditing the 171 distinct Salesperson strings on the
// 60,817 imported Sales Orders: 'TeleSales | ...' accounts for 1,041 of them,
// 'MD Telesales l ...' for 26 and 'PS | ...' for 6. Reps in those divisions
// could sign up under no Division at all, or under a wrong one, which would
// then be the Division their orders carried to Zoho.
//
// Ordered after the ten that were already here rather than alphabetically, so
// the diff reads as "three added" rather than a reshuffle.
const DIVISIONS = [
  'B&B',
  'B2B',
  'B2C',
  'BID',
  'CLIDP',
  'HOS',
  'MSA',
  'STC',
  'TeleSales Anesthesia',
  'URO',
  'TeleSales',
  'MD Telesales',
  'PS',
];

/**
 * Which MedRep is this order actually FOR?
 *
 * Sep 2, 2026. Normally: whoever is logged in.
 *
 * Sep 5, 2026: Management role (production) can name a MedRep with
 * `medrep_id` in the body. In TEST_MODE, admin can also do this for
 * testing. Both require three conditions (in addition to the role check):
 *   - the id names a real, active user;
 *   - whose role is medrep;
 *   - valid format (not null, not empty string).
 *
 * For anyone else, `medrep_id` is IGNORED rather than refused — a stray
 * field from an old client must never silently move an order onto someone
 * else's name. A bad id from someone who IS allowed to use it is a 400,
 * because there the caller meant something specific and got it wrong.
 *
 * Sep 5, 2026 (4): the Sep 5 (2) requirement below — that Management MUST
 * name a MedRep — is REVERSED. Selecting one is optional again, same as
 * everyone else. When Management leaves it blank, `fallback` (below)
 * already attributes the order to the MANAGEMENT ACCOUNT ITSELF —
 * resolveActor only ever remaps an ADMIN's actor onto a seeded stand-in, so
 * for a Management user it just returns `user` unchanged. That used to be
 * exactly the silent mis-attribution this function guarded against; it no
 * longer is, because Division and Salesperson can now ALSO be typed
 * manually for that same case (see create()'s effectiveDivision /
 * effectiveSalesperson) — Management's own account becomes a legitimate,
 * visible owner of the order (with whatever Division/Salesperson they typed
 * on it) rather than an accidental one with someone else's values leaking
 * onto it.
 *
 * Returns { actor, onBehalf } or { error }.
 */
async function resolveOrderMedrep(user, requestedMedrepId) {
  const fallback = await resolveActor(user, 'medrep');
  const asked = requestedMedrepId !== undefined && requestedMedrepId !== null && requestedMedrepId !== '';

  const isAdmin = (user.role || '').toLowerCase() === 'admin';
  const isManagement = (user.role || '').toLowerCase() === 'management';

  if (!asked) return { actor: fallback, onBehalf: false };

  // Management can always select a medrep (production use for pilot).
  //
  // Sep 9, 2026: so can Admin, in normal mode — it used to be TEST_MODE only.
  // The restriction made sense while admin had no order form at all; now that
  // it does, an admin who cannot name the MedRep would raise every order
  // against their OWN account, which has no Division and no Salesperson, and
  // Zoho rejects a Sales Order with no Salesperson outright. So the form would
  // exist and produce nothing but failures.
  //
  // Anyone else: medrep_id is ignored, not refused — same belt-and-braces
  // reasoning as division/salesperson below.
  const canSelectMedrep = isManagement || isAdmin;
  if (!canSelectMedrep) return { actor: fallback, onBehalf: false };

  const target = await db
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
exports.getCustomers = async (req, res, next) => {
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
    const customers = await db
      .prepare(`SELECT * FROM customers ${whereSql} ORDER BY is_active DESC, name LIMIT ?`)
      .all(...params, limit);

    // So the UI can say "showing 25 of 1,240" rather than implying the list
    // is everything there is.
    const totalMatching = (await db
      .prepare(`SELECT COUNT(*) c FROM customers ${whereSql}`)
      .get(...params)).c;

    // How many the toggle would add, counted under the same gate so the
    // number always matches what turning it on actually shows.
    const inactiveWhere = ['is_active = 0'];
    if (testZohoIds.length) {
      inactiveWhere.push(`zoho_contact_id IN (${testZohoIds.map(() => '?').join(',')})`);
    }
    const inactiveCount = (await db
      .prepare(`SELECT COUNT(*) c FROM customers WHERE ${inactiveWhere.join(' AND ')}`)
      .get(...testZohoIds)).c;

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

exports.getProducts = async (req, res, next) => {
  try {
    // Sep 1, 2026 (7): inactive products are returned too, so the order form
    // can LABEL them rather than silently omitting them. They are not
    // selectable there (Zoho rejects an inactive item on a Sales Order — see
    // the validation in create/submit), but "this medicine exists and is
    // deactivated in Zoho" is far more useful to a MedRep than the product
    // not appearing at all and them assuming they mistyped the name.
    const products = await db.prepare('SELECT * FROM products ORDER BY is_active DESC, name').all();
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
 *
 * Sep 5, 2026 (4): also hands back `salespersons` — Zoho's own known
 * Salesperson names — for the same gated group. Management (or admin in
 * Test Mode) can now type a Division/Salesperson manually instead of
 * picking a MedRep (medrep_id is optional again — see resolveOrderMedrep),
 * and the only safe way to let them type a Salesperson is to suggest names
 * Zoho already recognizes (same reasoning as salespersonService's module
 * comment) — create() independently re-verifies whatever is actually
 * submitted, so this list is a UI convenience, not the enforcement point.
 */
exports.getMedreps = async (req, res, next) => {
  try {
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const isManagement = (req.user.role || '').toLowerCase() === 'management';
    // Sep 5, 2026: Management role (production) can pick a medrep.
    // Sep 9, 2026: so can Admin, in normal mode — see resolveOrderMedrep's
    // note for why the TEST_MODE-only restriction stopped making sense once
    // admin got the order form. Other roles: disabled.
    const enabled = isManagement || isAdmin;
    if (!enabled) {
      return res.json({ success: true, data: { enabled: false, medreps: [], salespersons: [] } });
    }
    const medreps = await db
      .prepare(
        `SELECT id, name, email, display_name, division, sub_division, salesperson
         FROM users
         WHERE LOWER(role) = 'medrep' AND is_active = 1
         ORDER BY COALESCE(NULLIF(TRIM(display_name), ''), name)`
      )
      .all();

    let salespersons = [];
    try {
      const names = await salespersonService.loadNames();
      salespersons = names.map((s) => s.salesperson_name).filter(Boolean);
    } catch (err) {
      // Zoho unreachable — ship an empty suggestions list rather than fail
      // the whole picker. Typing still works; create() just won't be able
      // to confirm it matches until Zoho answers again.
      salespersons = [];
    }

    res.json({ success: true, data: { enabled: true, medreps, salespersons } });
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

exports.getAll = async (req, res, next) => {
  try {
    const { status, customer_type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    let params = [];

    // Sep 5, 2026: MedReps only see their own orders. Management sees all.
    // Other roles (finance, dispatch, admin) already see all (no filter).
    if (req.user.role === 'medrep') {
      where.push('o.medrep_id = ?');
      params.push(req.user.id);
    }
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (customer_type) { where.push('o.customer_type = ?'); params.push(customer_type); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = await db.prepare(`
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

    const totalRow = await db.prepare(
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
    const loadOrder = async () => await db.prepare(`
      SELECT o.*, c.name as customer_name, c.contact_person, c.contact_number,
             u.name as medrep_name, u.email as medrep_email
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    let order = await loadOrder();

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });

    // Sep 5, 2026: MedReps can only see their own orders. Management can
    // see any medrep's order. Other roles can see all orders.
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
      if (await shouldRefreshOnOpen(order)) {
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
          reconcile.then(async () => await markRefreshed(order.id)).catch(() => {});
        } else {
          await markRefreshed(order.id);
        }
        order = (await loadOrder()) || order;
      }
    } catch (err) {
      console.warn(`[ORDER_OPEN] Zoho refresh for order ${order.id} failed (order still served): ${err.message}`);
    }

    const items = await db.prepare(`
      SELECT oi.*, p.name as product_name, p.sku, p.unit
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(order.id);

    const payment = await db.prepare(`
      SELECT p.*, u.name as verified_by_name
      FROM payments p
      LEFT JOIN users u ON p.verified_by = u.id
      WHERE p.order_id = ?
    `).get(order.id);

    const dispatch = await db.prepare(`
      SELECT d.*, u.name as dispatched_by_name
      FROM dispatch_records d
      LEFT JOIN users u ON d.dispatched_by = u.id
      WHERE d.order_id = ?
    `).get(order.id);

    const events = await db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC'
    ).all(order.id);

    // Sep 10, 2026 (2c): `events` is unchanged — anything already reading it
    // keeps working — and `timeline` is the derived pipeline view beside it.
    // Derived on read rather than stored, so re-tiering an event type later is
    // one edit to SPINE and every existing order re-reads correctly.
    res.json({
      success: true,
      data: {
        order,
        items,
        payment,
        dispatch,
        events: events.map((e) => ({ ...e, tier: tierOf(e.event_type) })),
        timeline: buildTimeline(order, events)
      }
    });
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
    const owner = await db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(req.params.id);
    if (!owner) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    // Sep 5, 2026: MedReps can sync only their own orders. Management can sync any.
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

    // Sep 9, 2026: also mirror Zoho's OWN history log for this Sales Order.
    //
    // The reconcile above is inference — it compares Zoho's current state
    // against the local row and records the differences, which gives the
    // milestones but never their timestamps or the people behind them (the
    // comment on this endpoint has said as much since Sep 1: "Zoho's API
    // doesn't expose *when* the SO was confirmed"). It does, in a different
    // endpoint: the Sales Order's Comments & History. This pulls it.
    //
    // Best-effort and idempotent by Zoho's comment id, so a failure here
    // never turns a successful sync into an error response, and pressing the
    // button repeatedly does not grow duplicate entries.
    const logsAdded = await ingestSalesOrderLogs({
      orderId: req.params.id,
      salesorderId: result.order?.zoho_so_id,
      source: 'manual_reconcile'
    });
    // Sep 10, 2026: this now writes CLASSIFIED milestones with Zoho's own
    // timestamps and the real person's name, rather than a generic copy of
    // every line — see services/zohoHistoryService.js.

    // Re-read only when the log actually added something — the events array
    // reconcileOrder already returned is otherwise still current.
    const events = logsAdded
      ? await db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC').all(req.params.id)
      : result.events;

    res.json({
      success: true,
      data: {
        action: result.action,
        zoho_status: result.zohoStatus,
        order: result.order,
        events,
        zoho_log_entries_added: logsAdded || 0
      }
    });
  } catch (err) { next(err); }
};

// ─── BULK IMPORT: every Sales Order that exists in Zoho ───────────────────────
//
// Sep 9, 2026. The reconcile above answers "is this order up to date with
// Zoho". These two answer the bigger question behind it: can this app show
// EVERY order, including the ones raised directly in Zoho, with the history
// Zoho has for each. See services/zohoOrderImportService.js.
//
// Read-only toward Zoho — three GETs (list, detail, comments) and no write of
// any kind, same as every other pull in this app.

/**
 * POST /api/orders/import-from-zoho/start?mode=quick|full
 *
 * Starts the import in the background and returns a job id immediately (202),
 * exactly like the Clients Directory and Inventory pulls — poll progress at
 * GET /api/sync-jobs/:jobId. Blocking the request was never an option here:
 * one order costs two Zoho round trips plus the local writes, so even a
 * few hundred of them runs for minutes.
 */
exports.startImportJob = async (req, res) => {
  const mode = String(req.query.mode || '').toLowerCase();
  if (mode !== 'quick' && mode !== 'full') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_MODE', message: 'Query param "mode" must be "quick" or "full".' }
    });
  }

  const job = syncJobs.createJob({ type: 'salesorders', mode });

  // No `total` estimate seeded from the previous run, unlike the customers
  // job — deliberately, and it is worth saying why, because copying that
  // pattern here produces a visibly wrong bar.
  //
  // There, every contact fetched is a contact written, so the count found by
  // the walk IS the total. Here it is not: the walk finds however many Sales
  // Orders the org has, and only the first IMPORT_MAX of them are processed.
  // An org with 5,000 Sales Orders and a 500 cap would seed a total from the
  // fetched count and then pin the bar at 99% for the entire run.
  //
  // So the two phases are reported differently instead of being forced onto
  // one scale: the walk has no total and shows an indeterminate "N found so
  // far" (see SyncProgressIndicator), and the real total is set once the
  // number actually being processed is known.
  res.status(202).json({ success: true, data: { job_id: job.id, mode } });

  // Fire-and-forget — the response above has already gone out. Everything
  // below only updates the in-memory job and the local database.
  (async () => {
    try {
      const result = await importSalesOrders({
        mode,
        // Phase 1, the list walk: a running count, no total.
        onFetched: (n) => syncJobs.updateProgress(job.id, { processed: n }),
        // Phase 2: the count that matters is now known, so this is a real
        // percentage of real work rather than a fraction of an estimate.
        onProgress: (done, total) => syncJobs.updateProgress(job.id, { processed: done, total })
      });
      syncJobs.finishJob(job.id, result);
    } catch (err) {
      console.error('[ORDERS] Zoho Sales Order import job failed:', err);
      syncJobs.failJob(job.id, err);
    }
  })();
};

/**
 * GET /api/orders/import-from-zoho/status
 *
 * What the last import did, so the button can say when it last ran and how
 * much of the Orders list came from Zoho rather than from this app. Pure
 * local read — makes no Zoho calls at all, so it is free to poll.
 */
exports.getImportStatus = async (req, res, next) => {
  try {
    const adopted = await db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE getmeds_order_id LIKE 'ZOHO-%'").get();
    // Sep 10, 2026: counted by ORIGIN, not by event type. Zoho history entries
    // used to all be a generic 'ZOHO_LOG'; they are now classified into the
    // same milestone types the reconcile writes (see zohoHistoryService), so
    // the only thing that distinguishes one is that it came from a Zoho
    // comment — which is exactly what zohoCommentId records.
    const logged = await db
      .prepare(`SELECT COUNT(*) AS c FROM order_events WHERE metadata LIKE '%"zohoCommentId"%'`).get();
    // The two-tier import's backlog: orders that are here and correct, but so
    // far only from Zoho's list summary — no line items, no history yet. Not
    // an error state; see schema.pg.sql's zoho_detail_synced_at comment.
    const awaiting = await db
      .prepare('SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id IS NOT NULL AND zoho_detail_synced_at IS NULL')
      .get();

    res.json({
      success: true,
      data: {
        imported_orders: adopted?.c || 0,
        zoho_log_entries: logged?.c || 0,
        awaiting_detail: awaiting?.c || 0,
        last_full_import_at: await getSyncState('salesorders_last_full_sync_at'),
        last_full_import_total: parseInt(await getSyncState('salesorders_last_full_total'), 10) || null,
        per_run_limit: IMPORT_MAX,
        zoho_mode: zoho.mode
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
    const order = await db.prepare(`
      SELECT o.*, c.name as customer_name, u.name as medrep_name, u.email as medrep_email, u.id as medrep_user_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    // Sep 5, 2026: MedReps can retry only their own orders. Management can retry any.
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
    const row = await db.prepare(`
      SELECT * FROM zoho_sync_queue WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(order.id);

    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_QUEUED', message: 'No Zoho sync record was found queued for this order.' }
      });
    }

    const result = await zohoRetryService.processOne(row);
    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

    res.json({ success: true, data: { order: updatedOrder, result } });
  } catch (err) { next(err); }
};

exports.getEvents = async (req, res, next) => {
  try {
    const events = await db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC'
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
      // Sep 4, 2026: why this order has no proof of payment. The order form
      // requires one of these OR a staged file before it will submit; this
      // endpoint does not, because the proof uploads AFTER create (it needs
      // the order id for its storage path) so requiring it here would reject
      // every order that is about to get one. The CHECK constraint still
      // rejects a value that is not one of the four.
      no_payment_proof_reason, no_payment_proof_note,
      // Aug 30, 2026 (2): Payment Terms — mirrors the same-named field on
      // Zoho's own Sales Order screen (Net 15 / 30 days / 45 Day /
      // BPO WALLET / 60 Day / DSWD/PCSO, or a custom typed value). Same
      // "optional, free text, not wired into the Zoho payload yet" pattern
      // as delivery_method/terms above.
      payment_terms,
      // Sep 5, 2026 (3): Sub-division is now editable AT ORDER CREATION,
      // by whoever is raising the order (medrep or management) — see
      // SUB_DIVISIONS_BY_DIVISION above. Optional: omitted, it falls back
      // to the ordering MedRep's own account default exactly as it always
      // has (see medrepProfile below), so an older client that never sends
      // this field behaves unchanged.
      sub_division,
      // Sep 5, 2026 (4): Division and Salesperson, manually typed — see
      // effectiveDivision/effectiveSalesperson below. Honored ONLY when
      // req.user is Management (checked there, not here) — for a MedRep,
      // these are ignored exactly like medrep_id is for a non-privileged
      // caller: a stray field from an old client must never silently
      // override values that already come from the ordering MedRep's own
      // account.
      division, salesperson,
      // ── Sep 9, 2026: the "Master Form" fields ────────────────────────────
      //
      // All optional here, like every intake_* field before them, even though
      // the form marks most of them required. That is a client-side UX
      // guarantee; making it a server-side one would reject every other
      // caller of this endpoint, including the tests and any older client.
      // Values that ARE supplied still have to be valid — see the checks
      // below — because a bad enum reaching a CHECK constraint fails as a
      // database error rather than a message anyone can act on.
      expected_shipment_date, gl_number, receiver_type, is_doctor,
      // The customer's TIN. Written through to the customer record (and to
      // Zoho's cf_tin, best-effort) rather than only onto the order, because
      // the contact is what Zoho validates against.
      customer_tin,
      // Sep 2, 2026: TEST_MODE + admin only — raise this order for a named
      // MedRep instead of the seeded stand-in. See resolveOrderMedrep above
      // for the four conditions and why it is ignored rather than refused
      // everywhere else.
      medrep_id
    } = req.body;
    const clean = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    const medrepChoice = await resolveOrderMedrep(req.user, medrep_id);
    if (medrepChoice.error) {
      return res.status(400).json({ success: false, error: medrepChoice.error });
    }
    const effectiveActor = medrepChoice.actor;
    const onBehalfOf = medrepChoice.onBehalf;
    // Salesperson + Division + Sub-division, from the MedRep the order is
    // FOR (not whoever is clicking) — one read, so they cannot disagree.
    const medrepProfile = await salespersonService.profileForUser(effectiveActor.id);

    // Sep 9, 2026: renamed from isBackOfficeOrder and widened to include
    // admin. It gates the two manual overrides below, and an admin needs both
    // for the same reason management does: their own account has no Division
    // and no Salesperson to fall back to, and Zoho rejects a Sales Order
    // without a Salesperson. Naming it after the ROLE was always slightly
    // wrong — what it actually means is "raised from the back office, not by
    // the MedRep whose account the order belongs to".
    const isBackOfficeOrder = ['management', 'admin'].includes((req.user.role || '').toLowerCase());

    // Sep 5, 2026 (4): Division — normally always the ordering MedRep's own
    // account value (medrepProfile.division), because it also drives their
    // Salesperson. The ONE exception is Management: they can now type a
    // Division manually for THIS order, since a Management account
    // typically has no Division of its own to fall back to (see
    // resolveOrderMedrep's Sep 5 (4) note — medrep_id is optional again).
    // Strict against the same 15-entry list DIVISIONS validates at
    // sign-up/Profile Settings — a BRAND NEW order has no "legacy value" to
    // protect, same reasoning as Sub-division below.
    const cleanDivision = (typeof division === 'string' && division.trim()) ? division.trim() : null;
    let effectiveDivision = medrepProfile.division;
    if (isBackOfficeOrder && cleanDivision !== null) {
      if (!DIVISIONS.includes(cleanDivision)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `division must be one of: ${DIVISIONS.join(', ')}` }
        });
      }
      effectiveDivision = cleanDivision;
    }

    // Sep 5, 2026 (4): Salesperson — same exception, same reason. Unlike
    // Division, this is checked against Zoho's LIVE Salesperson list rather
    // than a fixed local one, because Zoho is the one that will reject an
    // unrecognized name outright (see salespersonService's module comment
    // and the Sep 2 incident it documents) — a typo here must be caught
    // before it reaches Zoho, not after. Fails OPEN when Zoho itself can't
    // be reached (verification.checked === false): we cannot confirm the
    // name either way, and blocking order creation on a Zoho outage would
    // be worse than letting a possibly-bad name through to the same
    // fail-safe retry queue every other Zoho call here already has.
    const cleanSalesperson = (typeof salesperson === 'string' && salesperson.trim()) ? salesperson.trim() : null;
    let effectiveSalesperson = medrepProfile.salesperson;
    if (isBackOfficeOrder && cleanSalesperson !== null) {
      const verification = await salespersonService.verify(cleanSalesperson);
      if (verification.checked && !verification.exists) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `"${cleanSalesperson}" is not a Salesperson Zoho recognizes. Pick one from the suggestions list.`
          }
        });
      }
      // Send Zoho's own canonical spelling when a match was found (the
      // comparison is case/whitespace-insensitive — see verify()'s comment)
      // so what actually reaches Zoho always exactly matches what it has.
      effectiveSalesperson = (verification.checked && verification.matchedName) ? verification.matchedName : cleanSalesperson;
    }

    // Sep 5, 2026 (3): resolve the Sub-division that will actually be used
    // on THIS order.
    //
    // Sep 9, 2026: no longer validated against SUB_DIVISIONS_BY_DIVISION.
    // Sub-division is free text now, and may name more than one, matching the
    // change made at sign-up and in Profile Settings (see
    // auth.controller.js's register for the reasoning).
    //
    // Relaxing it HERE as well is not optional — leaving this strict while the
    // account is free text produces the worst possible split: an account whose
    // sub-division is "GENSAN, BAGUIO" would have every order it raises
    // rejected for a value the account is required to hold. The two have to
    // agree, and free text is the side that reflects how reps actually work.
    //
    // Sent to Zoho's cf_sub_division as typed — a plain text custom field, so
    // several comma-separated names are as valid there as one.
    const cleanSubDivision = (typeof sub_division === 'string' && sub_division.trim()) ? sub_division.trim() : null;
    // Not sent — fall back to the ordering account's own value, exactly the
    // behavior this endpoint had before Sub-division became editable here.
    const effectiveSubDivision = cleanSubDivision !== null ? cleanSubDivision : medrepProfile.sub_division;

    const ALLOWED_INVOICING_FROM = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

    // Validation
    if (!customer_id) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'customer_id is required' } });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'At least one order item is required' } });
    if (!delivery_address) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'delivery_address is required' } });
    // Sep 9, 2026: the two new enums. Checked here so a bad value comes back
    // as a VALIDATION_ERROR naming the allowed set, rather than as a Postgres
    // CHECK violation surfacing through the 500 handler.
    const ALLOWED_RECEIVER_TYPES = ['patient', 'representative'];
    const cleanReceiverType = clean(receiver_type) ? clean(receiver_type).toLowerCase() : null;
    if (cleanReceiverType && !ALLOWED_RECEIVER_TYPES.includes(cleanReceiverType)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `receiver_type must be one of: ${ALLOWED_RECEIVER_TYPES.join(', ')}`
        }
      });
    }

    // Accepts a real boolean, and the strings a form or query string produces.
    // Anything else is left NULL ("not answered") rather than being coerced —
    // `Boolean('false')` is true, and silently recording the opposite of what
    // someone said is worse than recording nothing.
    let cleanIsDoctor = null;
    if (is_doctor === true || is_doctor === 1 || is_doctor === 'true' || is_doctor === '1') cleanIsDoctor = 1;
    else if (is_doctor === false || is_doctor === 0 || is_doctor === 'false' || is_doctor === '0') cleanIsDoctor = 0;

    // 'YYYY-MM-DD' — the shape <input type="date"> produces and the shape Zoho
    // wants for shipment_date. Rejected rather than passed through, since Zoho
    // refuses the whole Sales Order over a malformed date and the error it
    // gives back names neither the field nor the value.
    const cleanTin = clean(customer_tin);
    const cleanShipmentDate = clean(expected_shipment_date);
    if (cleanShipmentDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanShipmentDate)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'expected_shipment_date must be YYYY-MM-DD' }
      });
    }

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
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_active = 1').get(customer_id);
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
      const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
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
    const getmedsOrderId = await generateOrderId();
    const isDraft = requestedStatus === 'draft';
    // Sep 7, 2026: THIS single call is the entire "Create New Order" flow —
    // the frontend never calls a separate submit() (see that function's own
    // header comment below for why, and why its own copy of this same gate
    // is effectively unreachable from the app). So the MedRep-approval gate
    // ("the order will not sync to zoho unless management checks it") has
    // to live HERE too, or every MedRep order keeps reaching Zoho
    // immediately through this path exactly as it always did — which is
    // exactly the bug this line fixes. Management/admin — including an
    // admin raising an order "on behalf of" a MedRep in TEST_MODE, where
    // req.user is still admin — is unaffected: this checks req.user's OWN
    // role, not the order's medrep_id/effectiveActor.
    const isMedRepDirectSubmit = !isDraft && (req.user.role || '').toLowerCase() === 'medrep';
    // Sep 8, 2026 (3): widened per Faith's request — the management-review
    // gate now also fires for ANY B2B order, not only ones a MedRep submits
    // directly. isMedRepDirectSubmit keeps its original narrow meaning
    // (whether req.user themselves is a medrep); requiresManagementApproval
    // is what everything below actually gates on, so a Management-raised
    // B2B order now also waits for a (different) Management approval before
    // it reaches Zoho, same as a MedRep's own order always has.
    const requiresManagementApproval = isMedRepDirectSubmit || (!isDraft && effectiveDivision === 'B2B');
    const isCredit = resolvedCustomerType === 'credit';
    // Sep 1, 2026: same change as submit() below — a credit order stops at
    // 'so_created' until Zoho confirms the Sales Order, instead of landing
    // in the Dispatch queue while the SO is still an unconfirmed Draft. This
    // path (create-and-submit in one call) had its own copy of the rule, so
    // it had to be fixed in both places or the two entry points would
    // disagree about where a credit order starts.
    const finalStatus = isDraft
      ? 'draft'
      : (requiresManagementApproval ? 'pending_management_approval' : (isCredit ? 'so_created' : 'ready_for_draft_invoice'));
    const now = new Date().toISOString();
    // "Sales Order Date (Automatic Today)" on the form — always set here,
    // server-side, to today's date. There is no client override; a
    // sales_order_date sent in the request body (there isn't one — the
    // frontend never sends it) would be ignored regardless.
    const salesOrderDate = now.slice(0, 10);

    // Sep 8, 2026 (3): the order form's "Admin" field shows whoever is
    // logged in creating this order, explicitly labeled "not sent to
    // Zoho" — until now. Per the user's request, that identity now goes to
    // Zoho's "GM Lead ID" custom field (cf_gm_lead_id, confirmed live on
    // this org — see LiveZohoAdapter.js). Only set when the creator is NOT
    // the order's own MedRep: a MedRep creating their own order has no
    // separate "admin" to report (the form doesn't even show that field
    // then — see OrderForm.jsx's canPickMedrep-gated "Admin" pill); their
    // identity is already the Salesperson. Persisted on the order (below)
    // so submit()/zohoPayloadBuilder.js's retry rebuild send the same
    // value later, rather than re-deriving it from whoever happens to be
    // submitting or retrying at that later moment.
    const gmLeadId = (req.user.role || '').toLowerCase() !== 'medrep' ? req.user.name : null;

    // Sep 9, 2026: the TIN, written to the CONTACT before the Sales Order is
    // created — and that order matters.
    //
    // Zoho refuses to create a Sales Order for a "business" sub-type contact
    // whose cf_tin is empty (see ZohoAdapter.updateContactTin, added Sep 8 for
    // exactly this). So a MedRep who supplies the missing TIN on the order
    // form has to have it reach the contact BEFORE the createSalesOrder call
    // below, or the order they just fixed still fails on the same complaint.
    //
    // Soft-gated, like every other Zoho write in this app: setCustomerTin
    // never throws, a Zoho-side failure leaves the local value saved, and
    // nothing here can stop the order being raised. It is also a no-op when
    // the value is unchanged, which is the common case — the form sends back
    // whatever it was shown.
    let tinResult = null;
    if (cleanTin) {
      tinResult = await setCustomerTin(customer.id, cleanTin);
      if (tinResult?.zohoError) {
        console.warn(`[ORDERS] TIN for customer ${customer.id} saved locally but not pushed to Zoho: ${tinResult.zohoError}`);
      }
    }

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
      //
      // Sep 5, 2026 (4): sends `effectiveSalesperson`, not
      // `medrepProfile.salesperson` directly — the two only differ when
      // Management typed a Salesperson manually for this order (see above).
      salesperson_name: effectiveSalesperson,
      // Sep 2, 2026: Division / Sub-division — this org's own Sales Order
      // custom fields (cf_division / cf_sub_division), read from the same
      // user row as the Salesperson above so all three agree.
      //
      // Sep 5, 2026 (3): Sub-division sends `effectiveSubDivision` (this
      // order's own value, whether typed on the form or defaulted from the
      // account above) rather than the account's value directly, since it
      // can legitimately differ from `medrepProfile.sub_division` for this
      // one order.
      //
      // Sep 5, 2026 (4): Division now works the same way — sends
      // `effectiveDivision`, which is `medrepProfile.division` unless
      // Management typed a different one for this order (see above). Only
      // Management can make the two disagree; a MedRep's own Division still
      // always comes straight from their account.
      division: effectiveDivision,
      sub_division: effectiveSubDivision,
      // Sep 8, 2026: Delivery Method and Terms — collected on the form and
      // stored locally (intake_delivery_method/intake_terms) since Aug 30,
      // but never forwarded to Zoho until now. Both are plain top-level
      // fields on Zoho's own Sales Order (confirmed against the live Sales
      // Order field list, and already read back the same way by
      // zohoEditDiffService.js's TRACKED_FIELDS for the edit trail) — no
      // custom-field mapping needed, unlike Doctor Name/Source/Invoicing
      // From above.
      delivery_method: clean(delivery_method),
      terms: clean(terms),
      // Sep 8, 2026 (2): Payment Terms. Confirmed live on SO-67174 (created
      // with this field unwired, then hand-edited in Zoho) that Zoho's real
      // Sales Order shape is `payment_terms` (day-count integer) PLUS
      // `payment_terms_label` (display string) together — that edit came
      // back as payment_terms:30, payment_terms_label:"30 days". Sending
      // just the raw local string here; LiveZohoAdapter.js does the
      // label -> {payment_terms, payment_terms_label} split, same division
      // of labor as Salesperson (name resolved to an id at the adapter
      // layer, not here).
      payment_terms: clean(payment_terms),
      // Sep 9, 2026: Expected Shipment Date -> Zoho's own `shipment_date`.
      // A plain top-level field on the Sales Order, like delivery_method and
      // terms above — no custom-field mapping, and no invented
      // customfield_id, which is what makes it the only one of the five new
      // Master Form fields that goes to Zoho at all. GL Number, Receiver
      // Type and Is-Doctor have no field on this org's Sales Order, so they
      // stay local; the TIN goes on the CONTACT, not the order.
      expected_shipment_date: cleanShipmentDate,
      // Sep 8, 2026 (3): see the gmLeadId note above — wired to Zoho's
      // "GM Lead ID" custom field.
      gm_lead_id: gmLeadId
    };
    // Aug 30, 2026: each line's discount/tax are still not added to this
    // payload. See ZOHO_SALES_ORDER_FIELD_MAPPING.md for exactly which Zoho
    // Sales Order field each remaining one is meant to land on.
    //
    // Only ever creates the Zoho Sales Order (as a plain Draft — nothing
    // here confirms it). Confirming, invoicing, and recording payment all
    // happen directly in Zoho by Finance now, never through this app.
    //
    // Sep 7, 2026: skipped entirely when requiresManagementApproval — nothing
    // reaches Zoho until Management approves it (see approve() in
    // syncOrderToZohoAndFinalize's section below, which makes this exact
    // call later). zohoResult stays null and zohoSyncStatus stays 'pending',
    // which is the correct, honest state for "not sent yet". (Sep 8, 2026
    // (3): this now also covers a Management-raised B2B order, not only a
    // MedRep's own submission — see requiresManagementApproval above.)
    if (!isDraft && !requiresManagementApproval) {
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

    const createOrderTxn = db.transaction(async () => {
      const result = await db.prepare(`
        INSERT INTO orders (
          getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
          delivery_address, delivery_notes,
          intake_courier, intake_doctor, intake_hospital, intake_patient, intake_mop,
          intake_receiver, intake_contact_no, intake_source, intake_pls_give,
          sales_order_date, intake_delivery_method, intake_terms, intake_payment_terms, invoicing_from,
          no_payment_proof_reason, no_payment_proof_note, sub_division,
          division, salesperson, gm_lead_id,
          -- Sep 9, 2026: the Master Form fields. See schema.pg.sql.
          intake_expected_shipment_date, intake_gl_number, intake_receiver_type,
          intake_is_doctor, intake_tin,
          zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status,
          created_at, submitted_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        clean(no_payment_proof_reason),
        clean(no_payment_proof_note),
        effectiveSubDivision,
        effectiveDivision,
        effectiveSalesperson,
        clean(gmLeadId),
        cleanShipmentDate,
        clean(gl_number),
        cleanReceiverType,
        cleanIsDoctor,
        cleanTin,
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
        await insItem.run(
          orderId, ri.product_id, ri.quantity, ri.unit_price, ri.subtotal,
          ri.discount_amount, ri.tax_percent, ri.tax_label, ri.line_total
        );
      }

      // 2. Evaluate Workflow Gate & Create Child Records
      if (isDraft) {
        await logEvent({
          orderId,
          eventType: 'ORDER_CREATED',
          newStatus: 'draft',
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          // Sep 7, 2026 (3): Management raising an order for a named MedRep
          // (the normal, production "Create this order for" picker — not
          // just the admin/TEST_MODE case below) gets its own plain-English
          // line instead of the TEST_MODE-flavored one, since it happens
          // every day in production and "(admin, Test Mode)" is simply
          // wrong for it.
          notes: onBehalfOf
            ? (isBackOfficeOrder
                ? `${req.user.name} created an order for ${effectiveActor.name}.`
                : `Draft order created — raised by ${req.user.name} (admin, Test Mode) on behalf of ${effectiveActor.name}`)
            : 'Draft order created',
          metadata: onBehalfOf
            ? { onBehalfOf: true, raisedByUserId: req.user.id, raisedByName: req.user.name }
            : undefined
        });
      } else if (requiresManagementApproval) {
        // Sep 7, 2026: stops here — no child record, no Zoho retry queueing
        // (nothing was sent), no ORDER_SUBMITTED. Those all happen later,
        // inside syncOrderToZohoAndFinalize(), when Management approves.
        // Sep 8, 2026 (3): notes text no longer hardcodes "MedRep" — this
        // branch is now also reached by a Management user raising a B2B
        // order themselves, where "submitted by MedRep" would be wrong.
        await logEvent({
          orderId,
          eventType: 'STATUS_CHANGE',
          oldStatus: 'draft',
          newStatus: 'pending_management_approval',
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          notes: isMedRepDirectSubmit
            ? 'Submitted by MedRep — waiting for Management approval before syncing to Zoho.'
            : `Submitted by ${req.user.name} — B2B order, waiting for Management approval before syncing to Zoho.`
        });
      } else {
        if (isCredit) {
          await db.prepare("INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'queued', datetime('now'))").run(orderId);
        } else {
          await db.prepare("INSERT INTO payments (order_id, status, created_at) VALUES (?, 'pending', datetime('now'))").run(orderId);
        }

        // 3. Trigger Audit Trail (ORDER_SUBMITTED in the same transaction)
        await logEvent({
          orderId,
          eventType: 'ORDER_SUBMITTED',
          oldStatus: 'draft',
          newStatus: finalStatus,
          actorId: effectiveActor.id,
          actorName: effectiveActor.name,
          // Sep 2, 2026: an order raised by an admin FOR a MedRep is
          // attributed to that MedRep everywhere else, which is what makes
          // the Zoho Salesperson right — so the trail has to say who
          // actually clicked, or the attribution becomes untraceable.
          //
          // Sep 7, 2026 (3): Management doing this in production (the
          // normal "Create this order for" picker) gets a plain
          // "[Manager] created an order for [MedRep]" line instead of the
          // "(admin, Test Mode)" phrasing, which only actually applies to
          // the admin/TEST_MODE case.
          notes: onBehalfOf
            ? (isBackOfficeOrder
                ? `${req.user.name} created an order for ${effectiveActor.name} — ${customer.name} (${isCredit ? 'Credit Fast-Track' : 'Direct Patient Payment Queue'}).`
                : `Order submitted for ${customer.name} (${isCredit ? 'Credit Fast-Track' : 'Direct Patient Payment Queue'}) — raised by ${req.user.name} (admin, Test Mode) on behalf of ${effectiveActor.name}`)
            : `Order submitted for ${customer.name} (${isCredit ? 'Credit Fast-Track' : 'Direct Patient Payment Queue'})`,
          metadata: onBehalfOf
            ? { onBehalfOf: true, raisedByUserId: req.user.id, raisedByName: req.user.name }
            : undefined
        });

        if (zohoSyncStatus === 'failed') {
          await zohoRetryService.enqueue({ orderId, payload: zohoPayload, error: zohoError });
          await logEvent({
            orderId,
            eventType: 'ZOHO_SYNC_FAILED',
            oldStatus: finalStatus,
            newStatus: finalStatus,
            actorName: 'System',
            notes: `Zoho sync failed, order proceeds normally and sync is queued for automatic retry: ${zohoError}`
          });
        }
      }

      return { orderId, getmedsOrderId, finalStatus, isCredit, zohoResult };
    });

    const { orderId } = await createOrderTxn();

    // Trigger Notifications outside transaction
    if (requiresManagementApproval) {
      const orderDataForNotif = {
        getmeds_order_id: getmedsOrderId,
        customer_name: customer.name,
        status: finalStatus,
        medrep_email: req.user.email
      };

      await notify({
        orderId,
        recipientIds: [effectiveActor.id],
        message: `Your order ${getmedsOrderId} for ${customer.name} has been submitted and is waiting for Management approval before it syncs to Zoho.`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      const managementIds = await getUserIdsByRole('management');
      await notify({
        orderId,
        recipientIds: managementIds,
        message: `Order ${getmedsOrderId} from ${effectiveActor.name} needs your approval before it syncs to Zoho.`,
        eventType: 'MANAGEMENT_APPROVAL_REQUIRED',
        orderData: orderDataForNotif
      });
    } else if (!isDraft) {
      const orderDataForNotif = {
        getmeds_order_id: getmedsOrderId,
        customer_name: customer.name,
        status: finalStatus,
        medrep_email: req.user.email
      };

      await notify({
        orderId,
        recipientIds: [req.user.id],
        message: `Your order ${getmedsOrderId} for ${customer.name} has been submitted (${isCredit ? 'Sales Order drafted in Zoho — awaiting confirmation' : 'Waiting for Finance Payment Verification'}).`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      if (!isCredit) {
        const financeIds = await getUserIdsByRole('finance');
        await notify({ orderId, recipientIds: financeIds, message: `New direct patient order ${getmedsOrderId} requires payment verification.`, eventType: 'PAYMENT_VERIFICATION_REQUIRED', orderData: orderDataForNotif });
      } else {
        const dispatchIds = await getUserIdsByRole('dispatch');
        await notify({ orderId, recipientIds: dispatchIds, message: `New credit order ${getmedsOrderId} is ready for dispatch.`, eventType: 'ORDER_READY_FOR_DISPATCH', orderData: orderDataForNotif });
      }
    }

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    res.status(201).json({ success: true, data: { order } });
  } catch (err) { next(err); }
};

// ─── SUBMIT ───────────────────────────────────────────────────────────────────

// ─── Shared: push an order's Sales Order to Zoho and finalize its status ──
//
// Sep 7, 2026: extracted out of submit() (unchanged below) so the exact same
// Zoho-sync + finalize logic can be reused by approve() further down. A
// MedRep-submitted order no longer runs this at submit() time — it waits at
// 'pending_management_approval' until Management approves it (see the gate
// inside submit()), and only then does this run — exactly as it always ran
// immediately for a Management/admin submission. Nothing about what this
// does changed in this split, only who calls it and when.
//
// `pipelineActor` is who the audit-trail STATUS_CHANGE hops (submitted ->
// validating -> so_pending -> so_created/ready_for_draft_invoice) are
// attributed to. `notifyRecipientId` is who gets the "your order was
// submitted" notification. For a direct Management/admin submission these
// are both the submitting user (unchanged behavior). For an approve() call
// they are instead the order's own MedRep — those hops represent that
// MedRep's original submission, now released, not the Management user who
// happened to click Approve (that action is logged separately, see
// approve() below).
async function syncOrderToZohoAndFinalize({ order, items, getmedsOrderId, pipelineActor, notifyRecipientId }) {
  const now = new Date().toISOString();
  // If the order already has a submitted_at (set when it entered
  // 'pending_management_approval' at the original MedRep submit), keep it —
  // that is the real submission moment. Otherwise (a direct Management/
  // admin submission, which never visits that gate) this is the first time
  // submitted_at is set, exactly as before this split.
  const submittedAt = order.submitted_at || now;

  // Create Zoho SO. Done *before* opening the DB transaction below for the
  // same reason as in `create` above — better-sqlite3 transactions can't
  // contain an `await`, and this call is async (mock, http-mock, or live
  // depending on ZOHO_MODE).
  //
  // Fail-safe, not fail-closed: a Zoho rejection here does not abort the
  // submission or leave the order stuck — it still advances through the
  // state machine with zoho_sync_status='failed' and gets queued for
  // automatic background retry (see zohoRetryService).
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
    // order was created from rather than req.body, since this acts
    // on an already-stored draft.
    doctor_name: order.intake_doctor,
    order_source: order.intake_source,
    invoicing_from: order.invoicing_from,
    // Sep 2, 2026: the Salesperson of the MedRep the ORDER belongs to
    // (order.medrep_id), not whoever is submitting/approving it — an admin
    // or Management user acting on someone's behalf must not have the
    // Sales Order attributed to them. Comes from the users join in the
    // caller's query.
    //
    // Sep 5, 2026 (4): `order.salesperson`/`order.division` (this draft
    // row's own columns) win when set — set only when Management typed a
    // manual override at create() (see effectiveDivision/
    // effectiveSalesperson there) — falling back to the account join
    // otherwise, same pattern as sub_division just below. A draft from
    // before this column existed has it NULL, so it falls through to the
    // account join exactly as it always did.
    salesperson_name: order.salesperson || order.medrep_salesperson || null,
    division: order.division || order.medrep_division || null,
    // Sep 5, 2026 (3): Sub-division now comes from the DRAFT ROW
    // (`order.sub_division`, set at create() — see the long note there),
    // not from the account join, because create() already resolved
    // whatever was typed/picked on the form (or the account default) into
    // that column, and this must send exactly what was decided then.
    // Falls back to the account join only for a draft that predates this
    // column (`order.sub_division` is NULL on any row from before the
    // migration that added it).
    sub_division: order.sub_division || order.medrep_sub_division || null,
    // Sep 8, 2026: same wiring as `create` above — pulled from the draft
    // row's own intake columns, since this acts on an already-stored draft.
    delivery_method: order.intake_delivery_method || null,
    terms: order.intake_terms || null,
    // Sep 8, 2026 (2): Payment Terms — see the matching note in `create`
    // above for why this is the raw local string, translated at the
    // LiveZohoAdapter layer rather than here.
    payment_terms: order.intake_payment_terms || null,
    // Sep 9, 2026: Expected Shipment Date -> Zoho's `shipment_date`. Present
    // in all three places a payload is built (here, create() above, and
    // services/zohoPayloadBuilder.js for retries) — a field wired into only
    // some of them silently disappears depending on which path sent the order.
    expected_shipment_date: order.intake_expected_shipment_date || null,
    // Sep 8, 2026 (3): GM Lead ID — set once at create() time (see the
    // gmLeadId note there) and simply carried through here, not
    // re-derived from whoever is submitting/approving now.
    gm_lead_id: order.gm_lead_id || null
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

  const submitTxn = db.transaction(async () => {
    // Determine next status based on customer type.
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

    await db.prepare(`
      UPDATE orders SET
        getmeds_order_id = ?, customer_type = ?, status = ?, submitted_at = ?, updated_at = ?,
        zoho_so_id = ?, zoho_so_number = ?, zoho_so_status = ?, zoho_sync_status = ?
      WHERE id = ?
    `).run(getmedsOrderId, isCredit ? 'credit' : 'direct', finalStatus, submittedAt, now,
      zohoResult ? zohoResult.salesorder.salesorder_id : null,
      zohoResult ? zohoResult.salesorder.salesorder_number : null,
      initialZohoStatus,
      zohoSyncStatus,
      order.id);

    if (zohoSyncStatus === 'failed') {
      await zohoRetryService.enqueue({ orderId: order.id, payload: zohoPayload, error: zohoError });
    }

    // If direct patient, create payment record for Finance queue
    if (!isCredit) {
      await db.prepare(`
        INSERT INTO payments (order_id, status, created_at)
        VALUES (?, 'pending', datetime('now'))
      `).run(order.id);
    }

    // If credit customer, create dispatch record immediately
    if (isCredit) {
      await db.prepare(`
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

    // Sep 7, 2026: the hop BEFORE this one is either 'draft' (a direct
    // Management/admin submission) or 'pending_management_approval' (a
    // MedRep order Management just approved) — logEvent's oldStatus on the
    // first hop should say which actually happened, not always claim 'draft'.
    let prev = order.status;
    for (const s of statusPath) {
      await logEvent({ orderId: order.id, eventType: 'STATUS_CHANGE', oldStatus: prev, newStatus: s, actorId: pipelineActor.id, actorName: pipelineActor.name,
        notes: s === 'so_created'
          ? (zohoResult ? `Zoho SO created: ${zohoResult.salesorder.salesorder_number}` : `Zoho sync failed, queued for automatic retry: ${zohoError}`)
          : undefined });
      prev = s;
    }

    // Notify
    const orderDataForNotif = { getmeds_order_id: getmedsOrderId, customer_name: order.customer_name, status: finalStatus, medrep_email: order.medrep_email };

    // Notify the order's MedRep
    await notify({
      orderId: order.id,
      recipientIds: [notifyRecipientId],
      message: `Your order ${getmedsOrderId} for ${order.customer_name} has been submitted (${isCredit ? 'Sales Order drafted in Zoho — awaiting confirmation' : 'Waiting for Finance Payment Verification'}).`,
      eventType: 'ORDER_SUBMITTED',
      orderData: orderDataForNotif
    });

    // Route notification based on customer type
    if (order.customer_type === 'direct') {
      const financeIds = await getUserIdsByRole('finance');
      await notify({ orderId: order.id, recipientIds: financeIds, message: `New direct patient order ${getmedsOrderId} requires payment verification.`, eventType: 'PAYMENT_VERIFICATION_REQUIRED', orderData: orderDataForNotif });
    } else {
      // Sep 1, 2026: Dispatch is told the order exists, not that it's
      // ready — it isn't until Zoho confirms the Sales Order. The
      // ORDER_READY_FOR_DISPATCH notification now fires from the
      // salesorder.confirmed webhook instead.
      const dispatchIds = await getUserIdsByRole('dispatch');
      await notify({ orderId: order.id, recipientIds: dispatchIds, message: `New credit order ${getmedsOrderId} drafted in Zoho — will reach dispatch once Finance confirms the Sales Order.`, eventType: 'ORDER_SUBMITTED', orderData: orderDataForNotif });
    }

    return { getmedsOrderId, finalStatus, zohoResult, zohoSyncStatus };
  });

  return await submitTxn();
}

exports.submit = async (req, res, next) => {
  try {
    const order = await db.prepare(`
      SELECT o.*, c.name as customer_name, c.type as customer_master_type, c.contact_number, c.zoho_contact_id as customer_zoho_contact_id, u.name as medrep_name, u.email as medrep_email, u.salesperson as medrep_salesperson, u.division as medrep_division, u.sub_division as medrep_sub_division
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    // Sep 5, 2026: MedReps can submit only their own orders. Management can submit any.
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your order' } });
    }
    if (order.status !== 'draft') {
      return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: `Order is already ${order.status}, cannot submit` } });
    }
    const gateError = checkTestCustomerGate({ name: order.customer_name, zoho_contact_id: order.customer_zoho_contact_id });
    if (gateError) return res.status(403).json({ success: false, error: gateError });

    // ─── Sep 7, 2026: MedRep orders wait for Management approval ──────────
    //
    // "When medrep creates an order, the order will not sync to zoho unless
    // the management checks it." Applies to every order a MedRep submits —
    // credit and direct patient alike. It does NOT apply here: when
    // Management (or admin) submits — their own order, or one raised on a
    // MedRep's behalf via medrep_id at create() — nothing changes, the order
    // still syncs to Zoho immediately below, exactly as it always has.
    //
    // Sep 8, 2026 (3): widened, same as create()'s requiresManagementApproval
    // above — ANY B2B order also waits for Management approval here, even
    // one Management raised and is submitting themselves. order.division is
    // this order's own resolved value (set at create() — see the Sep 5 (4)
    // divisions doc); order.medrep_division is the fallback for a draft that
    // predates that column.
    //
    // The order gets its real getmeds_order_id now, at this gate, not later
    // at approval — so it is identifiable in the Management approval queue
    // (GET /api/management/orders?status=pending_management_approval)
    // immediately. See approve()/reject() further down for what happens
    // next.
    const effectiveDivisionForApprovalGate = order.division || order.medrep_division;
    const requiresManagementApproval = req.user.role === 'medrep' || effectiveDivisionForApprovalGate === 'B2B';
    if (requiresManagementApproval) {
      // Sep 7, 2026 (2): a draft already has a getmeds_order_id — create()
      // assigns one immediately, even to a draft (see the top of create()
      // above). Reuse it here instead of minting a second one: without this,
      // a resubmit after Management's Send Back (pending_management_approval
      // -> draft -> back through this same branch) would silently orphan
      // the order's original id from the approval-queue/audit-trail history
      // it already accumulated under that id.
      const getmedsOrderId = order.getmeds_order_id || await generateOrderId();
      const now = new Date().toISOString();

      await db.prepare(`
        UPDATE orders SET getmeds_order_id = ?, status = ?, submitted_at = ?, updated_at = ? WHERE id = ?
      `).run(getmedsOrderId, 'pending_management_approval', now, now, order.id);

      await logEvent({
        orderId: order.id,
        eventType: 'STATUS_CHANGE',
        oldStatus: 'draft',
        newStatus: 'pending_management_approval',
        actorId: req.user.id,
        actorName: req.user.name,
        notes: req.user.role === 'medrep'
          ? 'Submitted by MedRep — waiting for Management approval before syncing to Zoho.'
          : `Submitted by ${req.user.name} — B2B order, waiting for Management approval before syncing to Zoho.`
      });

      const orderDataForNotif = { getmeds_order_id: getmedsOrderId, customer_name: order.customer_name, status: 'pending_management_approval', medrep_email: order.medrep_email };

      await notify({
        orderId: order.id,
        recipientIds: [req.user.id],
        message: `Your order ${getmedsOrderId} for ${order.customer_name} has been submitted and is waiting for Management approval before it syncs to Zoho.`,
        eventType: 'ORDER_SUBMITTED',
        orderData: orderDataForNotif
      });

      const managementIds = await getUserIdsByRole('management');
      await notify({
        orderId: order.id,
        recipientIds: managementIds,
        message: `Order ${getmedsOrderId} from ${order.medrep_name} needs your approval before it syncs to Zoho.`,
        eventType: 'MANAGEMENT_APPROVAL_REQUIRED',
        orderData: orderDataForNotif
      });

      const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      return res.json({
        success: true,
        data: { order: updatedOrder, zoho: null, zoho_sync_status: 'pending', pending_management_approval: true }
      });
    }

    // Management / admin submitting: unchanged from before this gate existed.
    const items = await db.prepare(`
      SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id);
    const getmedsOrderId = await generateOrderId();
    const effectiveActor = await resolveActor(req.user, 'medrep');

    const result = await syncOrderToZohoAndFinalize({
      order, items, getmedsOrderId,
      pipelineActor: effectiveActor,
      notifyRecipientId: effectiveActor.id
    });

    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
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

// ─── MANAGEMENT APPROVAL (Sep 7, 2026) ─────────────────────────────────────
//
// "New update: When medrep creates an order, the order will not sync to
// zoho unless the management checks it." A MedRep-submitted order stops at
// 'pending_management_approval' (see the gate inside submit() above)
// instead of reaching Zoho immediately. Management (or admin) approves or
// rejects it here — mirrors finance.controller.js's verifyAccount exactly:
// an explicit decision, with a reason required on rejection, so the trail
// names who decided and why. Orders Management/admin submitted themselves
// never reach this status, so these two actions only ever act on a
// MedRep-raised order.
exports.approve = async (req, res, next) => {
  try {
    const order = await db.prepare(`
      SELECT o.*, c.name as customer_name, c.type as customer_master_type, c.contact_number, c.zoho_contact_id as customer_zoho_contact_id, u.name as medrep_name, u.email as medrep_email, u.salesperson as medrep_salesperson, u.division as medrep_division, u.sub_division as medrep_sub_division
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });

    if (order.status !== 'pending_management_approval') {
      return res.status(409).json({
        success: false,
        error: { code: 'NOT_AWAITING_APPROVAL', message: `This order is at "${order.status}", not awaiting Management approval.` }
      });
    }

    const items = await db.prepare(`
      SELECT oi.*, p.name as name, p.sku, p.zoho_item_id, p.unit FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id);

    const approver = await resolveActor(req.user, 'management');

    // Logged BEFORE the Zoho-sync pipeline runs, and separately from its own
    // STATUS_CHANGE hops — this is the record of WHO approved it, distinct
    // from the pipeline hops that follow (attributed to the order's own
    // MedRep, since those represent the original submission being released,
    // not this approval action itself).
    await logEvent({
      orderId: order.id,
      eventType: 'MANAGEMENT_APPROVED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: approver.id,
      actorName: approver.name,
      notes: 'Approved by Management — syncing to Zoho.'
    });

    const pipelineActor = { id: order.medrep_id, name: order.medrep_name };
    const result = await syncOrderToZohoAndFinalize({
      order, items,
      getmedsOrderId: order.getmeds_order_id,
      pipelineActor,
      notifyRecipientId: order.medrep_id
    });

    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
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

exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    // A rejection without a reason is useless to the MedRep who has to act
    // on it — same rule as Finance's verifyAccount.
    if (!String(reason || '').trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'A reason is required when rejecting — it is what the MedRep acts on.' }
      });
    }

    const order = await db.prepare(`
      SELECT o.*, u.name as medrep_name, u.email as medrep_email
      FROM orders o
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });

    if (order.status !== 'pending_management_approval') {
      return res.status(409).json({
        success: false,
        error: { code: 'NOT_AWAITING_APPROVAL', message: `This order is at "${order.status}", not awaiting Management approval.` }
      });
    }

    const target = 'on_hold';
    if (!stateMachine.canTransition(order.status, target)) {
      return res.status(409).json({
        success: false,
        error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${order.status} to ${target}` }
      });
    }

    const rejecter = await resolveActor(req.user, 'management');
    const now = new Date().toISOString();
    let newStatus = order.status;

    await db.transaction(async () => {
      const moved = await setOrderStatus(order.id, order.status, target, now);
      newStatus = moved.status;

      await db.prepare('UPDATE orders SET exception_reason = ?, updated_at = ? WHERE id = ?')
        .run(String(reason).trim(), now, order.id);

      await logEvent({
        orderId: order.id,
        eventType: 'MANAGEMENT_REJECTED',
        oldStatus: order.status,
        newStatus,
        actorId: rejecter.id,
        actorName: rejecter.name,
        notes: `Rejected by Management: ${String(reason).trim()}`,
        metadata: { reason: String(reason).trim() }
      });

      await notify({
        orderId: order.id,
        recipientIds: [order.medrep_id].filter(Boolean),
        message: `Order ${order.getmeds_order_id} was rejected by Management: ${String(reason).trim()}`,
        eventType: 'MANAGEMENT_REJECTED',
        orderData: { getmeds_order_id: order.getmeds_order_id, customer_name: order.customer_name, status: newStatus, medrep_email: order.medrep_email }
      });
    })();

    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: { order: updatedOrder, status: newStatus } });
  } catch (err) { next(err); }
};

// ─── SEND BACK FOR RESUBMISSION (Sep 7, 2026) ──────────────────────────────
//
// A third outcome alongside approve()/reject() above: the order isn't wrong
// enough to reject outright, it just needs a fix (wrong division, a typo'd
// address, a bad line item) — so instead of putting it on hold indefinitely,
// Management sends it back to 'draft'. The order keeps its
// getmeds_order_id; the MedRep (or Management, via updateDetails/updateItems
// below) edits it and resubmits, which runs it through this exact approval
// gate again from the top. Reason is required for the same reason it's
// required on reject() — it's what the MedRep acts on.
exports.sendBack = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!String(reason || '').trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'A reason is required — it tells the MedRep what to fix.' }
      });
    }

    const order = await db.prepare(`
      SELECT o.*, u.name as medrep_name, u.email as medrep_email
      FROM orders o
      LEFT JOIN users u ON o.medrep_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });

    if (order.status !== 'pending_management_approval') {
      return res.status(409).json({
        success: false,
        error: { code: 'NOT_AWAITING_APPROVAL', message: `This order is at "${order.status}", not awaiting Management approval.` }
      });
    }

    const target = 'draft';
    if (!stateMachine.canTransition(order.status, target)) {
      return res.status(409).json({
        success: false,
        error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${order.status} to ${target}` }
      });
    }

    const sender = await resolveActor(req.user, 'management');
    const now = new Date().toISOString();
    let newStatus = order.status;

    await db.transaction(async () => {
      const moved = await setOrderStatus(order.id, order.status, target, now);
      newStatus = moved.status;

      // Sep 7, 2026: reuses exception_reason as the "what needs fixing" note
      // — same column reject() writes to, same reasoning: one obvious place
      // to look on the order for why it isn't moving forward. Cleared
      // automatically the next time this order is submitted (see submit()'s
      // gate and create()'s isMedRepDirectSubmit branch — neither writes
      // exception_reason, so a resubmit doesn't carry a stale reason
      // forward once Management approves it).
      await db.prepare('UPDATE orders SET exception_reason = ?, updated_at = ? WHERE id = ?')
        .run(String(reason).trim(), now, order.id);

      await logEvent({
        orderId: order.id,
        eventType: 'MANAGEMENT_SENT_BACK',
        oldStatus: order.status,
        newStatus,
        actorId: sender.id,
        actorName: sender.name,
        notes: `Sent back for resubmission by Management: ${String(reason).trim()}`,
        metadata: { reason: String(reason).trim() }
      });

      await notify({
        orderId: order.id,
        recipientIds: [order.medrep_id].filter(Boolean),
        message: `Order ${order.getmeds_order_id} was sent back by Management for changes: ${String(reason).trim()}`,
        eventType: 'MANAGEMENT_SENT_BACK',
        orderData: { getmeds_order_id: order.getmeds_order_id, customer_name: order.customer_name, status: newStatus, medrep_email: order.medrep_email }
      });
    })();

    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: { order: updatedOrder, status: newStatus } });
  } catch (err) { next(err); }
};

// ─── EDIT ORDER DETAILS (Sep 7, 2026) ──────────────────────────────────────
//
// updateItems() above already lets the line items be corrected before Zoho
// exists for an order — this is the same idea for everything else on the
// order: delivery/intake fields, Division, Sub-division, Salesperson.
// Same precondition (order.zoho_so_id must still be null — once a real Zoho
// Sales Order exists, editing here would silently desync from it) and same
// ownership rule as updateItems (a MedRep may edit only their own order;
// Management/admin may edit any). Scoped to 'draft' and
// 'pending_management_approval' — editing an order already past the gate
// makes no sense since Zoho already has (or is about to have) the record.
//
// Deliberately does NOT allow changing customer_id, medrep_id, or
// customer_type here — each has its own cascading implications (Zoho
// contact id, Salesperson/Division resolution, the whole payment-vs-dispatch
// branch) that this endpoint isn't the place to re-derive. Those need a
// fresh order (cancel and recreate), not an edit.
//
// PATCH /api/orders/:id/details — body: any subset of the editable fields
// below. Only fields actually present in the body are validated and
// changed; omitted fields are left alone (partial update, not a full
// replace) — a caller that only wants to fix the Division doesn't have to
// resend everything else.
exports.updateDetails = async (req, res, next) => {
  try {
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    // Sep 7, 2026: same ownership rule as updateItems.
    if (req.user.role === 'medrep' && order.medrep_id !== req.user.id) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not your order' } });
    }
    if (order.zoho_so_id) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_SYNCED',
          message: 'This order already has a Zoho Sales Order (' + (order.zoho_so_number || order.zoho_so_id) +
            ') — details can no longer be edited here, since Zoho\'s own record would then be out of date.'
        }
      });
    }
    if (!['draft', 'pending_management_approval'].includes(order.status)) {
      return res.status(409).json({
        success: false,
        error: { code: 'CONFLICT', message: `Order is at "${order.status}" — details can only be edited while draft or awaiting Management approval.` }
      });
    }

    const clean = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    const isManagement = ['management', 'admin'].includes((req.user.role || '').toLowerCase());
    const ALLOWED_INVOICING_FROM = ['2mg Incorporated', 'Getmeds Philippines Inc.'];
    const body = req.body || {};

    // Column name -> [request field name, validator-or-null]. Only fields
    // actually present in the request body are touched.
    const EDITABLE = {
      delivery_address: 'delivery_address',
      delivery_notes: 'delivery_notes',
      intake_doctor: 'doctor_name',
      intake_receiver: 'receiver_name',
      intake_contact_no: 'receiver_contact_no',
      intake_source: 'order_source',
      intake_delivery_method: 'delivery_method',
      intake_terms: 'terms',
      intake_payment_terms: 'payment_terms',
      invoicing_from: 'invoicing_from',
      sub_division: 'sub_division',
      // Sep 9, 2026: the Master Form fields are editable here too. They have
      // to be: this endpoint is what the send-back flow relies on
      // (Management returns an order to draft, the MedRep fixes it and
      // resubmits — see sendBack), and a GL Number or shipment date that
      // could be entered but never corrected would make that flow useless for
      // exactly the fields most likely to be wrong. Still gated by the same
      // two conditions as everything else here: no Zoho Sales Order yet, and
      // the order is draft or awaiting approval.
      //
      // intake_is_doctor is NOT in this map — it is an integer, and the loop
      // below runs clean() over every value, which would turn 0 into null.
      // It is handled on its own further down.
      intake_expected_shipment_date: 'expected_shipment_date',
      intake_gl_number: 'gl_number',
      intake_receiver_type: 'receiver_type',
      intake_tin: 'customer_tin'
    };

    const updates = {};
    const changedSummary = [];

    if (Object.prototype.hasOwnProperty.call(body, 'delivery_address') && !clean(body.delivery_address)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'delivery_address cannot be blank' } });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'invoicing_from') && clean(body.invoicing_from) && !ALLOWED_INVOICING_FROM.includes(clean(body.invoicing_from))) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `invoicing_from must be one of: ${ALLOWED_INVOICING_FROM.join(', ')}` }
      });
    }

    // Sep 9, 2026: same two enums create() validates, checked the same way and
    // for the same reason — a bad value reaching the CHECK constraint fails as
    // a database error rather than a message anyone can act on.
    if (Object.prototype.hasOwnProperty.call(body, 'receiver_type') && clean(body.receiver_type)) {
      const rt = clean(body.receiver_type).toLowerCase();
      if (!['patient', 'representative'].includes(rt)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'receiver_type must be one of: patient, representative' }
        });
      }
      body.receiver_type = rt;
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'expected_shipment_date') &&
      clean(body.expected_shipment_date) &&
      !/^\d{4}-\d{2}-\d{2}$/.test(clean(body.expected_shipment_date))
    ) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'expected_shipment_date must be YYYY-MM-DD' }
      });
    }

    // Sep 5, 2026 (4)'s rule, unchanged here: Division/Salesperson are only
    // ever settable by Management — a MedRep's own account still drives
    // theirs, exactly like at create(). A MedRep sending these fields is
    // silently ignored rather than refused, same belt-and-braces reasoning
    // create() already uses for medrep_id/division/salesperson.
    let effectiveDivisionForSubDivision = order.division;
    if (isManagement && Object.prototype.hasOwnProperty.call(body, 'division')) {
      const cleanDivision = clean(body.division);
      if (cleanDivision !== null) {
        if (!DIVISIONS.includes(cleanDivision)) {
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: `division must be one of: ${DIVISIONS.join(', ')}` }
          });
        }
        updates.division = cleanDivision;
        effectiveDivisionForSubDivision = cleanDivision;
        changedSummary.push(`Division: ${order.division || '(none)'} → ${cleanDivision}`);
      }
    }

    if (isManagement && Object.prototype.hasOwnProperty.call(body, 'salesperson')) {
      const cleanSalesperson = clean(body.salesperson);
      if (cleanSalesperson !== null) {
        const verification = await salespersonService.verify(cleanSalesperson);
        if (verification.checked && !verification.exists) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `"${cleanSalesperson}" is not a Salesperson Zoho recognizes. Pick one from the suggestions list.`
            }
          });
        }
        const resolvedSalesperson = (verification.checked && verification.matchedName) ? verification.matchedName : cleanSalesperson;
        updates.salesperson = resolvedSalesperson;
        changedSummary.push(`Salesperson: ${order.salesperson || '(none)'} → ${resolvedSalesperson}`);
      }
    }

    // Sep 9, 2026: free text, like create() and the account fields — see the
    // note on cleanSubDivision in create() for why all four sites had to move
    // together rather than one at a time.
    if (Object.prototype.hasOwnProperty.call(body, 'sub_division')) {
      const cleanSub = clean(body.sub_division);
      if (cleanSub !== null) {
        updates.sub_division = cleanSub;
        changedSummary.push(`Sub-division: ${order.sub_division || '(none)'} → ${cleanSub}`);
      }
    }

    for (const [column, field] of Object.entries(EDITABLE)) {
      if (column === 'invoicing_from' || column === 'sub_division') continue; // handled above
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const value = clean(body[field]);
      updates[column] = value;
      changedSummary.push(`${field}: ${order[column] || '(none)'} → ${value || '(none)'}`);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'invoicing_from')) {
      const value = clean(body.invoicing_from);
      updates.invoicing_from = value;
      changedSummary.push(`invoicing_from: ${order.invoicing_from || '(none)'} → ${value || '(none)'}`);
    }

    // Sep 9, 2026: is_doctor, on its own because it is an integer. The loop
    // above runs clean() over every value, and clean(0) is null — so routing
    // this through the map would record "not answered" every time somebody
    // answered No.
    if (Object.prototype.hasOwnProperty.call(body, 'is_doctor')) {
      const raw = body.is_doctor;
      let value = null;
      if (raw === true || raw === 1 || raw === 'true' || raw === '1') value = 1;
      else if (raw === false || raw === 0 || raw === 'false' || raw === '0') value = 0;
      updates.intake_is_doctor = value;
      const label = (v) => (v === 1 ? 'Yes' : v === 0 ? 'No' : '(none)');
      changedSummary.push(`is_doctor: ${label(order.intake_is_doctor)} → ${label(value)}`);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No editable fields were sent' } });
    }

    const now = new Date().toISOString();
    const effectiveActor = await resolveActor(req.user, req.user.role === 'medrep' ? 'medrep' : 'management');

    await db.transaction(async () => {
      const setClause = Object.keys(updates).map((col) => `${col} = ?`).join(', ');
      await db.prepare(`UPDATE orders SET ${setClause}, updated_at = ? WHERE id = ?`)
        .run(...Object.values(updates), now, order.id);

      await logEvent({
        orderId: order.id,
        eventType: 'ORDER_DETAILS_EDITED',
        oldStatus: order.status,
        newStatus: order.status,
        actorId: effectiveActor.id,
        actorName: effectiveActor.name,
        notes: `Order details changed before this order was sent to Zoho — ${changedSummary.join('; ')}.`,
        metadata: { changes: updates }
      });
    })();

    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    res.json({ success: true, data: { order: updatedOrder } });
  } catch (err) { next(err); }
};

// ─── EXCEPTION / ON HOLD ──────────────────────────────────────────────────────

exports.setException = async (req, res, next) => {
  try {
    const { reason, status } = req.body;
    const targetStatus = status === 'on_hold' ? 'on_hold' : 'exception';
    const effectiveActor = await resolveActor(req.user, 'management');

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    if (!stateMachine.canTransition(order.status, targetStatus)) {
      return res.status(409).json({ success: false, error: { code: 'INVALID_TRANSITION', message: `Cannot move from ${order.status} to ${targetStatus}` } });
    }

    const txn = db.transaction(async () => {
      await db.prepare('UPDATE orders SET status = ?, exception_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(targetStatus, reason || null, order.id);

      await logEvent({ orderId: order.id, eventType: 'EXCEPTION_SET', oldStatus: order.status, newStatus: targetStatus, actorId: effectiveActor.id, actorName: effectiveActor.name, notes: reason });
    });
    await txn();

    const medrepIds = [order.medrep_id];
    const mgmtIds = await getUserIdsByRole('management');
    await notify({ orderId: order.id, recipientIds: [...medrepIds, ...mgmtIds], message: `Order ${order.getmeds_order_id} is now ${targetStatus}. Reason: ${reason || 'None provided'}`, eventType: 'ORDER_EXCEPTION', orderData: order });

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
exports.updateItems = async (req, res, next) => {
  try {
    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    // Sep 5, 2026: MedReps can edit only their own orders. Management can edit any.
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
      const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
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

    const oldItemsSummary = (await db.prepare(`
      SELECT oi.quantity, p.name FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id)).map((r) => `${r.quantity}x ${r.name || 'Unknown product'}`).join(', ') || 'none';
    const newItemsSummary = resolvedItems.map((it) => `${it.quantity}x ${it.name}`).join(', ');

    const now = new Date().toISOString();
    const txn = db.transaction(async () => {
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, discount_amount, tax_percent, tax_label, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of resolvedItems) {
        await insertItem.run(order.id, it.product_id, it.quantity, it.unit_price, it.subtotal, it.discount_amount, it.tax_percent, it.tax_label, it.line_total);
      }
      await db.prepare('UPDATE orders SET total_amount = ?, updated_at = ? WHERE id = ?').run(total_amount, now, order.id);

      await logEvent({
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
    await txn();

    const updatedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const updatedItems = await db.prepare(`
      SELECT oi.*, p.name as product_name, p.sku, p.unit
      FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?
    `).all(order.id);

    res.json({ success: true, data: { order: updatedOrder, items: updatedItems } });
  } catch (err) { next(err); }
};
