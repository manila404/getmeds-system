const db = require('../db/database');
const { loadScope, scopeSql } = require('../services/orderScopeService');
const { importedSql, originSql } = require('../services/orderOrigin');
const { isWorkflowV2Enabled } = require('../services/workflowFlags');
const workflow = require('../services/workflowV2Service');
const { workflowAction } = require('./workflowAction');
const { logEvent, resolveActor } = require('../services/auditService');
const notificationService = require('../services/notificationService');

// ─── Confirmed for delivery (Sep 15, 2026) ─────────────────────────────────
// Dispatch prints the delivery slip, checks the address, and confirms the
// order is going out to it. Confirmed with the business: it RECORDS that and
// nothing else — no status change, nothing sent to Zoho; packing and shipping
// carry on exactly as before.
//
// Kept as an order event rather than a column, so it needs no migration and
// the timeline shows it for free. The address confirmed goes in the event's
// metadata: an address edited afterwards shows as "changed since confirmed"
// instead of a stale tick.

// Finance has confirmed these and the parcel has not left: the orders
// Dispatch can confirm for delivery, and the "Confirmed by Finance" list.
const FINANCE_CONFIRMED = ['ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing'];

// The latest confirmation for each order row.
const CONFIRMATION_JOIN = `
      LEFT JOIN LATERAL (
        SELECT e.actor_name AS delivery_confirmed_by, e.created_at AS delivery_confirmed_at,
               e.metadata AS delivery_confirmed_meta
          FROM order_events e
         WHERE e.order_id = o.id AND e.event_type = 'DELIVERY_CONFIRMED'
         ORDER BY e.id DESC LIMIT 1
      ) dc ON TRUE`;

// ─── Tracking number on hold (Sep 15, 2026) ────────────────────────────────
// Confirmed for delivery, but the tracking number is not there yet — waiting
// for the waybill, say. Dispatch records the reason so the MedRep (notified)
// and everyone else can see why, instead of chasing a number nobody has.
// Record-only like the confirmation: no status change, nothing sent to Zoho.
// Lifted by "Tracking ready", and treated as lifted the moment the order has
// a tracking number, however it got one (this app's Ship, or Zoho's webhook).
const TRACKING_HOLDABLE = [...FINANCE_CONFIRMED, 'dispatched'];
// Sep 15, 2026: a tracking number can be added or corrected a little longer
// than it can be held — an order Zoho already marked "tracking shared" or
// complete can still be missing the number (GM-20260914-0020: Lalamove, no
// number), and Dispatch is who has it.
const TRACKING_EDITABLE = [...TRACKING_HOLDABLE, 'tracking_shared', 'completed'];

// The latest hold-related entry decides whether the tracking is on hold: a
// hold, its release, or Dispatch adding the number (which ends a hold). And,
// separately, the latest tracking number Dispatch added (Sep 15, 2026).
const TRACKING_HOLD_JOIN = `
      LEFT JOIN LATERAL (
        SELECT th.event_type AS tracking_hold_event, th.actor_name AS tracking_hold_by,
               th.created_at AS tracking_hold_at, th.metadata AS tracking_hold_meta
          FROM order_events th
         WHERE th.order_id = o.id
           AND th.event_type IN ('TRACKING_ON_HOLD', 'TRACKING_HOLD_RELEASED', 'DISPATCH_TRACKING_ADDED')
         ORDER BY th.id DESC LIMIT 1
      ) th ON TRUE
      LEFT JOIN LATERAL (
        SELECT et.actor_name AS entered_tracking_by, et.created_at AS entered_tracking_at,
               et.metadata AS entered_tracking_meta
          FROM order_events et
         WHERE et.order_id = o.id AND et.event_type = 'DISPATCH_TRACKING_ADDED'
         ORDER BY et.id DESC LIMIT 1
      ) et ON TRUE`;
const TRACKING_HOLD_COLUMNS =
  'th.tracking_hold_event, th.tracking_hold_by, th.tracking_hold_at, th.tracking_hold_meta, ' +
  'et.entered_tracking_by, et.entered_tracking_at, et.entered_tracking_meta';

const parseJson = (text) => {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
};

/**
 * The confirmation and the tracking hold as the page reads them — including
 * whether the address moved since it was confirmed.
 */
function withConfirmation(row) {
  const {
    delivery_confirmed_meta: meta,
    tracking_hold_event: holdEvent,
    tracking_hold_by: holdBy,
    tracking_hold_at: holdAt,
    tracking_hold_meta: holdMeta,
    entered_tracking_by: enteredBy,
    entered_tracking_at: enteredAt,
    entered_tracking_meta: enteredMeta,
    ...rest
  } = row;
  const confirmedAddress = parseJson(meta)?.delivery_address ?? null;
  const hold = parseJson(holdMeta) || {};
  const entered = parseJson(enteredMeta);
  return {
    // Sep 15, 2026: the tracking number Dispatch typed in (record-only — Zoho
    // still gets its shipment the way it does today).
    entered_tracking: entered
      ? { courier: entered.courier || null, tracking_number: entered.tracking_number || null, by: enteredBy, at: enteredAt }
      : null,
    ...rest,
    delivery_confirmed_address: confirmedAddress,
    delivery_address_changed:
      Boolean(row.delivery_confirmed_at) && confirmedAddress !== null &&
      String(confirmedAddress).trim() !== String(row.delivery_address || '').trim(),
    tracking_hold:
      holdEvent === 'TRACKING_ON_HOLD' && !row.tracking_number
        ? { reason: hold.reason || null, note: hold.note || null, by: holdBy, at: holdAt }
        : null
  };
}

// ─── Dispatch queue ────────────────────────────────────────────────────────
// Until Sep 12, 2026 this page was read-only: picking, packing, dispatch and
// tracking status came FROM Zoho Inventory (Package created → picking_packing,
// Shipment created → dispatched → tracking_shared — see webhook.controller.js)
// and nobody pressed anything here.
//
// With GETMEDS_WORKFLOW_V2 on, Dispatch does that work here instead — create
// and send the invoice, mark packed, ship, mark delivered — and each button
// makes the matching change in Zoho (services/workflowV2Service.js). The
// webhooks still run, and recognise those changes as already recorded.
// With the switch off, this is exactly the read-only queue it was.

// Where each v2 step starts. The page groups rows by these.
const V2_STEPS = {
  needs_invoice: ['ready_for_draft_invoice', 'ready_for_invoice_sent'],
  ready_to_pack: ['ready_for_dispatch'],
  ready_to_ship: ['picking_packing'],
  // 'completed' too: shipped AND already paid closes the order the moment it
  // ships, but the parcel is still on the road. Only orders shipped from this
  // app qualify (the query requires the Zoho shipment id Ship records) — every
  // order completed before the switch has no delivery to mark.
  awaiting_delivery: ['dispatched', 'tracking_shared', 'completed']
};
const V2_STATUSES = Object.values(V2_STEPS).flat().filter((s) => s !== 'completed');

exports.getQueue = async (req, res, next) => {
  try {
    // Sep 11, 2026 (Phase C): narrowed to the viewer's divisions.
    //
    // This queue is open to `management` as well as its own role, so without
    // this a division-scoped manager would see every order in it — the same
    // leak the orders list has, on a page nobody thinks of as an orders list.
    // loadScope returns full scope for Dispatch users themselves, so their queue is
    // unchanged.
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    const v2 = isWorkflowV2Enabled();

    const select = `
      SELECT o.*, c.name as customer_name, c.contact_number,
             u.name as medrep_name,
             d.status as dispatch_status, d.courier, d.tracking_number, d.created_at as dispatch_created_at,
             d.zoho_package_number, d.zoho_shipment_number, d.delivered_at,
             dc.delivery_confirmed_by, dc.delivery_confirmed_at, dc.delivery_confirmed_meta,
             ${TRACKING_HOLD_COLUMNS}
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.medrep_id = u.id
      LEFT JOIN dispatch_records d ON o.id = d.order_id${CONFIRMATION_JOIN}${TRACKING_HOLD_JOIN}`;

    // Sep 15, 2026: paged (25 by default) and searchable. Unpaged, the
    // read-only list answered with every order at these statuses — 10,108 in
    // production, nearly all history imported from Zoho — in one response.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const requestedPage = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const search = String(req.query.search || '').trim().slice(0, 100);
    // 'all' by default here, so the list shows what it always has; the page
    // offers "raised in GetMeds" / "imported from Zoho" to narrow it.
    const origin = ['getmeds', 'zoho', 'all'].includes(req.query.origin) ? req.query.origin : 'all';
    const step = v2 && Object.prototype.hasOwnProperty.call(V2_STEPS, req.query.step) ? req.query.step : null;

    const where = [];
    const params = [];
    if (v2) {
      // Dispatch's work now starts at "needs invoice" and ends when the parcel
      // arrives, so a shipped order stays here until someone marks it
      // delivered. Imported Zoho orders are left out: they are history, and
      // pressing a button on one would write to a Sales Order someone finished
      // in Zoho long ago.
      where.push(
        "(o.status = ANY(?) OR (o.status = 'completed' AND d.zoho_shipment_id IS NOT NULL))",
        'd.delivered_at IS NULL',
        `NOT (${importedSql('o')})`
      );
      params.push(V2_STATUSES);
    } else {
      // Sep 1, 2026 (5): 'ready_for_dispatch' now MEANS "the invoice has been
      // issued, this is yours to pack" — it used to mean "the Sales Order is
      // confirmed". That rename is exactly what this queue wanted: the
      // warehouse sees an order at the point Finance is done with it, and the
      // two finance stages ahead of it (ready_for_draft_invoice,
      // ready_for_invoice_sent) correctly stay out of this list.
      where.push("o.status IN ('ready_for_dispatch', 'picking_packing', 'dispatched')");
      const originClause = originSql(origin, 'o');
      if (originClause) where.push(originClause);
    }
    if (scopeClause) {
      where.push(scopeClause);
      params.push(...scopeParams);
    }
    if (search) {
      // % and _ are matched as themselves, not as wildcards.
      const like = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      // The tracking number is either Zoho's (dispatch_records) or one
      // Dispatch typed in (a DISPATCH_TRACKING_ADDED event). The events are
      // matched once, as a set, rather than probed for every one of the
      // ~10,000 rows — per-row, a search took 4.4 s against production.
      where.push(`(o.getmeds_order_id ILIKE ? OR o.zoho_so_number ILIKE ? OR c.name ILIKE ? OR u.name ILIKE ?
                   OR d.tracking_number ILIKE ?
                   OR o.id IN (SELECT te.order_id FROM order_events te
                                WHERE te.event_type = 'DISPATCH_TRACKING_ADDED' AND te.metadata ILIKE ?))`);
      params.push(like, like, like, like, like, like);
    }
    const whereSql = where.join(' AND ');

    // Per-status totals over everything that matches — the page's count, and
    // the v2 step tabs' counts — without fetching the rows themselves.
    const counted = await db.prepare(`
      SELECT o.status, COUNT(*) AS n
        FROM orders o
        LEFT JOIN customers c ON o.customer_id = c.id
        LEFT JOIN users u ON o.medrep_id = u.id
        LEFT JOIN dispatch_records d ON o.id = d.order_id
       WHERE ${whereSql}
       GROUP BY o.status
    `).all([...params]);
    const statusCounts = Object.fromEntries(counted.map((r) => [r.status, Number(r.n)]));

    const pageWhere = [whereSql];
    const pageParams = [...params];
    if (step) {
      pageWhere.push('o.status = ANY(?)');
      pageParams.push(V2_STEPS[step]);
    }
    const total = Object.entries(statusCounts)
      .filter(([status]) => !step || V2_STEPS[step].includes(status))
      .reduce((n, [, c]) => n + c, 0);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, pages);

    // v2 is a work queue, oldest first. The read-only mirror is mostly history,
    // so the newest come first there.
    const orders = await db.prepare(`${select}
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY o.updated_at ${v2 ? 'ASC' : 'DESC'}, o.id DESC
       LIMIT ? OFFSET ?
    `).all([...pageParams, limit, (page - 1) * limit]);

    res.json({
      success: true,
      data: {
        orders: orders.map(withConfirmation),
        workflow_v2: v2,
        steps: v2 ? V2_STEPS : null,
        pagination: { page, limit, total, pages },
        status_counts: statusCounts,
        origin: v2 ? null : origin
      }
    });
  } catch (err) { next(err); }
};

/**
 * GET /api/dispatch/recent — what is coming Dispatch's way.
 *
 * Sep 15, 2026. The queue above starts once an order is Dispatch's to work,
 * so the orders on their way were invisible here. Two lists, newest first:
 *   new_draft_sos      in Zoho as a draft Sales Order, waiting on Finance —
 *                      a heads-up only
 *   finance_confirmed  Finance has confirmed them and the parcel has not left
 *                      yet — these can be printed and confirmed for delivery
 * Imported Zoho history is left out, as in the queue.
 */
exports.getRecent = async (req, res, next) => {
  try {
    const scope = await loadScope(req.user);
    const { sql: scopeClause, params: scopeParams } = scopeSql(scope, 'o');
    const scopeAnd = scopeClause ? ` AND ${scopeClause}` : '';
    const columns = `
        o.id, o.getmeds_order_id, o.status, o.total_amount, o.delivery_address, o.delivery_notes,
        o.intake_receiver, o.intake_contact_no, o.intake_delivery_method,
        o.zoho_so_number, o.zoho_so_status, o.created_at, o.updated_at,
        c.name AS customer_name, c.contact_number, u.name AS medrep_name,
        dc.delivery_confirmed_by, dc.delivery_confirmed_at, dc.delivery_confirmed_meta,
        (SELECT dr.tracking_number FROM dispatch_records dr WHERE dr.order_id = o.id) AS tracking_number,
        ${TRACKING_HOLD_COLUMNS}`;
    const from = `
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users u ON u.id = o.medrep_id${CONFIRMATION_JOIN}${TRACKING_HOLD_JOIN}`;

    // One array argument each: see db/pg.js's flatten().
    const drafts = await db.prepare(`
      SELECT ${columns} ${from}
       WHERE o.status = 'ready_for_finance_verified' AND o.zoho_so_id IS NOT NULL
         AND NOT (${importedSql('o')})${scopeAnd}
       ORDER BY o.created_at DESC
       LIMIT 20
    `).all([...scopeParams]);

    const confirmed = await db.prepare(`
      SELECT ${columns}, fv.finance_confirmed_at, fv.finance_confirmed_by ${from}
      LEFT JOIN LATERAL (
        SELECT fe.created_at AS finance_confirmed_at, fe.actor_name AS finance_confirmed_by
          FROM order_events fe
         WHERE fe.order_id = o.id AND fe.event_type = 'FINANCE_VERIFIED'
         ORDER BY fe.id DESC LIMIT 1
      ) fv ON TRUE
       WHERE o.status = ANY(?)
         AND NOT (${importedSql('o')})${scopeAnd}
       ORDER BY COALESCE(fv.finance_confirmed_at, o.updated_at) DESC
       LIMIT 20
    `).all([FINANCE_CONFIRMED, ...scopeParams]);

    res.json({
      success: true,
      data: {
        new_draft_sos: drafts.map(withConfirmation),
        finance_confirmed: confirmed.map(withConfirmation)
      }
    });
  } catch (err) { next(err); }
};

/**
 * POST /api/dispatch/orders/:id/confirm-delivery — "this is going out, to
 * this address". Records who and when on the order's timeline; changes
 * nothing else. Confirming again (after the address was corrected, say) adds
 * a new entry and the latest one counts.
 */
exports.confirmDelivery = async (req, res, next) => {
  try {
    // Sep 15, 2026: in the same step, the tracking number — added now, or on
    // hold with a reason ("Waiting for waybill"). Optional here; the page asks
    // for one of the two. Checked before anything is written.
    const body = req.body || {};
    const bad = (message) => res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
    if (body.tracking != null && body.hold != null) return bad('Either add the tracking number or put it on hold, not both.');
    const tracking = body.tracking != null ? parseTracking(body.tracking) : null;
    if (tracking?.error) return bad(tracking.error);
    const trackingHold = body.hold != null ? parseHold(body.hold) : null;
    if (trackingHold?.error) return bad(trackingHold.error);

    const order = await db.prepare(`
      SELECT o.*, c.name AS customer_name
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ?
    `).get(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    if (!FINANCE_CONFIRMED.includes(order.status)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_CONFIRMABLE',
          message:
            'Only an order Finance has confirmed, and that has not shipped yet, can be confirmed for delivery. ' +
            `This one is at "${order.status}".`
        }
      });
    }
    const address = String(order.delivery_address || '').trim();
    if (!address) {
      return res.status(409).json({
        success: false,
        error: { code: 'NO_ADDRESS', message: 'This order has no delivery address to confirm. Ask the MedRep to add one.' }
      });
    }

    if (tracking || trackingHold) {
      const already = trackingAlready(await loadForTracking(order.id));
      if (already) return res.status(409).json({ success: false, error: { code: 'HAS_TRACKING', message: already } });
    }

    const actor = await resolveActor(req.user, 'dispatch');
    const receiver = [order.intake_receiver, order.intake_contact_no].filter(Boolean).join(', ');
    await logEvent({
      orderId: order.id,
      eventType: 'DELIVERY_CONFIRMED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: `Confirmed for delivery to: ${address}${receiver ? ` (receiver: ${receiver})` : ''}.`,
      metadata: {
        delivery_address: address,
        receiver: order.intake_receiver || null,
        contact_no: order.intake_contact_no || null
      }
    });
    if (tracking) await recordTracking(order, actor, tracking);
    if (trackingHold) await recordHold(order, actor, trackingHold);
    const trackingNow = await loadForTracking(order.id);

    const latest = await db.prepare(`
      SELECT actor_name, created_at FROM order_events
       WHERE order_id = ? AND event_type = 'DELIVERY_CONFIRMED'
       ORDER BY id DESC LIMIT 1
    `).get(order.id);
    res.json({
      success: true,
      data: {
        id: order.id,
        delivery_confirmed_by: latest?.actor_name || actor.name,
        delivery_confirmed_at: latest?.created_at || null,
        entered_tracking: trackingNow.entered,
        tracking_hold: trackingNow.hold,
        message:
          `${order.getmeds_order_id} confirmed for delivery to ${address}.` +
          (tracking ? ` Tracking ${tracking.trackingNumber} saved; the MedRep was told.` : '') +
          (trackingHold ? ` Tracking on hold — ${trackingHold.reason}; the MedRep was told.` : '')
      }
    });
  } catch (err) { next(err); }
};

/** The order with its tracking number and current hold, for the two actions below. */
async function loadForTracking(id) {
  const row = await db.prepare(`
    SELECT o.*, d.tracking_number, ${TRACKING_HOLD_COLUMNS}
      FROM orders o
      LEFT JOIN dispatch_records d ON d.order_id = o.id${TRACKING_HOLD_JOIN}
     WHERE o.id = ?
  `).get(id);
  if (!row) return null;
  const shaped = withConfirmation(row);
  return { raw: row, hold: shaped.tracking_hold, entered: shaped.entered_tracking };
}

/** Why a tracking number cannot be added or held any more, or null. */
function trackingAlready(loaded) {
  if (loaded.raw.tracking_number) return `This order already has tracking number ${loaded.raw.tracking_number} from Zoho.`;
  if (loaded.entered) return `Dispatch already added tracking number ${loaded.entered.tracking_number} to this order.`;
  return null;
}

function parseTracking(input) {
  const courier = String(input?.courier || '').trim();
  const trackingNumber = String(input?.tracking_number || '').trim();
  if (!courier || !trackingNumber) return { error: 'Enter the courier and the tracking number.' };
  if (courier.length > 100 || trackingNumber.length > 100) return { error: 'The courier or tracking number is too long.' };
  return { courier, trackingNumber };
}

function parseHold(input) {
  const reason = String(input?.reason || '').trim();
  const note = String(input?.note || '').trim();
  if (!reason) return { error: 'Give a reason, e.g. "Waiting for waybill".' };
  if (reason.length > 200 || note.length > 500) return { error: 'The reason or note is too long.' };
  return { reason, note };
}

/**
 * Sep 15, 2026: the tracking number, typed by Dispatch. Confirmed with the
 * business: saved on the order and sent to the MedRep, and nothing else — no
 * status change, nothing sent to Zoho, whose shipment is still made there.
 * Its own event type, not TRACKING_ENTERED: that one means Zoho's shipment
 * reported a number, and the timeline reads it as the order having shipped.
 */
async function recordTracking(order, actor, { courier, trackingNumber }, previous = null) {
  // An update is another entry, and the latest one counts; the one it
  // replaces stays on the timeline, named in this one's note.
  const updating = Boolean(previous?.tracking_number);
  await logEvent({
    orderId: order.id,
    eventType: 'DISPATCH_TRACKING_ADDED',
    oldStatus: order.status,
    newStatus: order.status,
    actorId: actor.id,
    actorName: actor.name,
    notes: updating
      ? `Tracking number updated by Dispatch: ${courier} ${trackingNumber} (was ${previous.courier || ''} ${previous.tracking_number}).`
      : `Tracking number added by Dispatch: ${courier} ${trackingNumber}.`,
    metadata: {
      courier,
      tracking_number: trackingNumber,
      ...(updating ? { previous: { courier: previous.courier, tracking_number: previous.tracking_number } } : {})
    }
  });
  await tellMedrep(
    order,
    updating
      ? `Order ${order.getmeds_order_id}: tracking number updated to ${trackingNumber} (${courier}).`
      : `Order ${order.getmeds_order_id}: tracking number ${trackingNumber} (${courier}).`,
    'DISPATCH_TRACKING_ADDED'
  );
}

async function recordHold(order, actor, { reason, note }) {
  await logEvent({
    orderId: order.id,
    eventType: 'TRACKING_ON_HOLD',
    oldStatus: order.status,
    newStatus: order.status,
    actorId: actor.id,
    actorName: actor.name,
    notes: `Tracking number on hold: ${reason}${note ? ` — ${note}` : ''}.`,
    metadata: { reason, note: note || null }
  });
  await tellMedrep(order, `Order ${order.getmeds_order_id}: tracking number on hold — ${reason}.`, 'TRACKING_ON_HOLD');
}

async function tellMedrep(order, message, eventType) {
  // Best-effort: a notification that fails must not undo what was recorded.
  try {
    const recipients = Array.from(new Set([order.medrep_id, order.raised_by_id].filter(Boolean)));
    await notificationService.notify({ orderId: order.id, recipientIds: recipients, message, eventType, orderData: order });
  } catch (err) {
    console.warn(`[DISPATCH] could not notify for ${order.getmeds_order_id}:`, err.message);
  }
}

/**
 * POST /api/dispatch/orders/:id/tracking-hold { reason, note? } — the tracking
 * number is not ready yet, and why. See TRACKING_HOLDABLE above.
 */
exports.holdTracking = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Give a reason, e.g. "Waiting for waybill".' } });
    }
    if (reason.length > 200 || note.length > 500) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'The reason or note is too long.' } });
    }

    const loaded = await loadForTracking(req.params.id);
    if (!loaded) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    const order = loaded.raw;
    if (!TRACKING_HOLDABLE.includes(order.status)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_HOLDABLE',
          message: `Only an order on its way through Dispatch can have its tracking put on hold. This one is at "${order.status}".`
        }
      });
    }
    const already = trackingAlready(loaded);
    if (already) return res.status(409).json({ success: false, error: { code: 'HAS_TRACKING', message: already } });

    const actor = await resolveActor(req.user, 'dispatch');
    await recordHold(order, actor, { reason, note });

    const now = await loadForTracking(order.id);
    res.json({
      success: true,
      data: { id: order.id, tracking_hold: now.hold, message: `${order.getmeds_order_id}: tracking on hold — ${reason}.` }
    });
  } catch (err) { next(err); }
};

/**
 * POST /api/dispatch/orders/:id/tracking { courier, tracking_number } — the
 * number Dispatch has, typed in. Ends a hold. See recordTracking.
 */
exports.addTracking = async (req, res, next) => {
  try {
    const t = parseTracking(req.body);
    if (t.error) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: t.error } });

    const loaded = await loadForTracking(req.params.id);
    if (!loaded) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    const order = loaded.raw;
    if (!TRACKING_EDITABLE.includes(order.status)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NOT_HOLDABLE',
          message: `A tracking number can be added once Finance has confirmed the order. This one is at "${order.status}".`
        }
      });
    }
    // Zoho's own number (its shipment) is corrected in Zoho, not overlaid
    // here — two numbers for one parcel would leave the MedRep guessing.
    // One Dispatch typed in earlier CAN be corrected: that is "update".
    if (order.tracking_number) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'HAS_ZOHO_TRACKING',
          message: `This order has tracking number ${order.tracking_number} from its Zoho shipment. Change it in Zoho.`
        }
      });
    }

    const actor = await resolveActor(req.user, 'dispatch');
    await recordTracking(order, actor, t, loaded.entered);
    const now = await loadForTracking(order.id);
    res.json({
      success: true,
      data: {
        id: order.id,
        entered_tracking: now.entered,
        tracking_hold: now.hold,
        message: `${order.getmeds_order_id}: tracking ${t.trackingNumber} (${t.courier}) ${loaded.entered ? 'updated' : 'saved'} — the MedRep was told.`
      }
    });
  } catch (err) { next(err); }
};

/** POST /api/dispatch/orders/:id/tracking-hold/release — the tracking number is ready. */
exports.releaseTrackingHold = async (req, res, next) => {
  try {
    const loaded = await loadForTracking(req.params.id);
    if (!loaded) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    const order = loaded.raw;
    if (!loaded.hold) {
      return res.status(409).json({ success: false, error: { code: 'NOT_ON_HOLD', message: "This order's tracking is not on hold." } });
    }

    const actor = await resolveActor(req.user, 'dispatch');
    await logEvent({
      orderId: order.id,
      eventType: 'TRACKING_HOLD_RELEASED',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: `Tracking hold lifted (was: ${loaded.hold.reason}).`,
      metadata: { previous_reason: loaded.hold.reason }
    });
    await tellMedrep(order, `Order ${order.getmeds_order_id}: the tracking number is on its way — the hold is lifted.`, 'TRACKING_HOLD_RELEASED');

    res.json({ success: true, data: { id: order.id, tracking_hold: null, message: `${order.getmeds_order_id}: tracking hold lifted.` } });
  } catch (err) { next(err); }
};

/** GET /api/dispatch/orders/:id/slip — everything the printed delivery slip shows. */
exports.getSlip = async (req, res, next) => {
  try {
    const order = await db.prepare(`
      SELECT o.id, o.getmeds_order_id, o.status, o.zoho_so_number, o.delivery_address, o.delivery_notes,
             o.intake_receiver, o.intake_contact_no, o.intake_delivery_method, o.sales_order_date,
             o.created_at, o.total_amount,
             c.name AS customer_name, c.contact_number, u.name AS medrep_name,
             dc.delivery_confirmed_by, dc.delivery_confirmed_at, dc.delivery_confirmed_meta
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN users u ON u.id = o.medrep_id${CONFIRMATION_JOIN}
       WHERE o.id = ?
    `).get(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    const items = await db.prepare(`
      SELECT p.name, p.sku, oi.quantity
        FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id
    `).all(order.id);
    res.json({ success: true, data: { order: withConfirmation(order), items } });
  } catch (err) { next(err); }
};

exports.createInvoice = workflowAction((req) =>
  workflow.createInvoice({ orderId: req.params.id, user: req.user }));

exports.markPacked = workflowAction((req) =>
  workflow.markPacked({ orderId: req.params.id, user: req.user }));

exports.ship = workflowAction((req) =>
  workflow.ship({
    orderId: req.params.id,
    user: req.user,
    courier: req.body && req.body.courier,
    trackingNumber: req.body && req.body.trackingNumber
  }));

exports.markDelivered = workflowAction((req) =>
  workflow.markDelivered({ orderId: req.params.id, user: req.user }));
