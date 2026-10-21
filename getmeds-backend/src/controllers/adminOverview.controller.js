'use strict';

/**
 * ADMIN OVERVIEW (try-out, Oct 14, 2026) — live numbers for the Admin Overview page
 * (getmeds-frontend/src/pages/admin/AdminOverviewMockPage.jsx).
 *
 * GET /api/admin-overview?from=YYYY-MM-DD&to=YYYY-MM-DD   (Admin only)
 *   Default period: the 1st of this month to today, Philippine time. At most 92 days.
 *
 * Strictly read-only: one READ ONLY transaction with a 10-second limit, plus GET
 * requests to Zoho for invoices and credit notes. Nothing is written anywhere.
 *
 * What the numbers mean (same rules as the KPI page / Finance sales summary):
 *   - Booked Sales  = orders Finance verified inside the period (their latest
 *                     FINANCE_VERIFIED event), not cancelled or deleted.
 *   - Orders        = orders raised in this app inside the period, excluding drafts,
 *                     cancelled, deleted and drafts Management cancelled. Orders
 *                     imported from Zoho history (ZOHO-…) are never counted.
 *   - Target        = the sum of the monthly targets set on the KPI page (kpi_targets)
 *                     for every month the period touches; null when none are set.
 *   - Total Sales   = (Oct 14, 2026) straight from Zoho, the same way Zoho's "Sales by
 *                     Salesperson" report adds it up: every invoice DATED in the period
 *                     (draft and void left out) minus every credit note dated in the
 *                     period, both WITH tax. Balance Due = what is still unpaid on those
 *                     invoices. Checked against that report for Oct 1–31, 2026: 532
 *                     invoices ₱20,676,080.93 − credit notes ₱201,343.50 = ₱20,474,737.43,
 *                     balance due ₱17,005,960.10 — exact.
 *
 * If the design is not approved, delete this file, routes/adminOverview.routes.js and
 * the line marked "ADMIN OVERVIEW" in app.js.
 */

const db = require('../db/database');
const { importedSql } = require('../services/orderOrigin');
const zoho = require('../integrations/zoho');
const invoiceCopy = require('../services/zohoInvoiceCopy');
const { withLock } = require('../services/cronLock');

const q = (sql, params) => db._rawQuery(sql, params);
const MAX_DAYS = 92;
const MAX_ROWS = 5000;

const bad = (res, message) => res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });

/** Today's date in Philippine time, as YYYY-MM-DD. */
function manilaToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-30
};
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** [fromUtc, toUtc) ISO strings for whole Philippine days from..to inclusive. */
const utcRange = (from, to) => [
  new Date(`${from}T00:00:00+08:00`).toISOString(),
  new Date(`${addDays(to, 1)}T00:00:00+08:00`).toISOString(),
];
/** Every YYYY-MM the period touches. */
function monthsIn(from, to) {
  const out = [];
  let m = from.slice(0, 7);
  while (m <= to.slice(0, 7)) {
    out.push(m);
    const [y, mm] = m.split('-').map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  }
  return out;
}

const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
const MANILA_DAY = (col) => `to_char((${col})::timestamptz AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD')`;

/* ───────── Zoho: invoices and credit notes (GET only) ───────── */
const ZOHO_CACHE_MS = 5 * 60 * 1000;
const ZOHO_MAX_PAGES = 30; // 6,000 invoices — far above a month's volume
const zohoCache = new Map(); // `${from}|${to}` -> { at, value }

/** Every page of a Zoho list. Uses the app's existing Zoho connection (and its org allowlist). */
async function zohoList(adapter, path, key, query) {
  const rows = [];
  for (let page = 1; page <= ZOHO_MAX_PAGES; page++) {
    const json = await adapter._request('GET', path, { query: { ...query, page: String(page), per_page: '200' } });
    rows.push(...(json[key] || []));
    if (!(json.page_context && json.page_context.has_more_page)) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function readZohoSales(from, to, { fresh = false } = {}) {
  // Oct 21, 2026: read the copy of Zoho's invoices kept in our database (services/zohoInvoiceCopy.js)
  // when it is switched on, covers these dates and synced within the hour; otherwise Zoho live, as before.
  // Refresh asks for the newest changes first, at most once a minute.
  if (invoiceCopy.readOn()) {
    try {
      if (fresh && invoiceCopy.syncOn()) {
        const st = await invoiceCopy.status();
        if (!st.lastRun || Date.now() - Date.parse(st.lastRun) > 60 * 1000) {
          await withLock('zoho_invoice_copy', 4 * 60 * 1000, async () => await invoiceCopy.runRecent());
        }
      }
      const fromCopy = await invoiceCopy.readSales(from, to);
      if (fromCopy) return fromCopy;
    } catch (err) {
      console.error('[OVERVIEW] invoice copy unavailable, reading Zoho live:', err.message);
    }
  }
  return readZohoSalesLive(from, to, { fresh });
}

async function readZohoSalesLive(from, to, { fresh = false } = {}) {
  const cacheKey = `${from}|${to}`;
  const hit = zohoCache.get(cacheKey);
  if (!fresh && hit && Date.now() - hit.at < ZOHO_CACHE_MS) return { ...hit.value, cached: true };

  let adapter;
  try { adapter = zoho.getZohoAdapter(); } catch (err) {
    return { available: false, error: `Zoho is not set up here: ${err.message}` };
  }
  if (typeof adapter._request !== 'function') {
    return { available: false, error: `Zoho is in ${adapter.mode || 'mock'} mode, so there are no real invoices to read.` };
  }

  const query = { date_start: from, date_end: to, sort_column: 'date' };
  let invoices; let creditNotes; let creditError = null; let truncated = false;
  try {
    const r = await zohoList(adapter, '/invoices', 'invoices', query);
    invoices = r.rows; truncated = r.truncated;
  } catch (err) {
    return { available: false, error: `Could not read invoices from Zoho: ${err.message}` };
  }
  try {
    const r = await zohoList(adapter, '/creditnotes', 'creditnotes', query);
    creditNotes = r.rows; truncated = truncated || r.truncated;
  } catch (err) {
    creditNotes = []; creditError = `Could not read credit notes from Zoho (${err.message}), so none were taken off.`;
  }

  const inRange = (d) => typeof d === 'string' && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const counted = (x) => !['draft', 'void'].includes(String(x.status || '').toLowerCase());
  const inv = invoices.filter((i) => counted(i) && inRange(i.date)).map((i) => ({
    number: i.invoice_number, date: i.date, customer: i.customer_name || '—',
    salesperson: String(i.salesperson_name || '').trim() || 'No salesperson', so_number: i.reference_number || '',
    status: i.status, total: num(i.total), balance: num(i.balance),
  }));
  const cn = creditNotes.filter((c) => counted(c) && inRange(c.date)).map((c) => ({
    number: c.creditnote_number, date: c.date, customer: c.customer_name || '—',
    salesperson: String(c.salesperson_name || '').trim() || 'No salesperson', reference: c.reference_number || '',
    status: c.status, total: num(c.total),
  }));

  const sp = new Map();
  const row = (name) => {
    if (!sp.has(name)) sp.set(name, { name, invoices: 0, invoice_total: 0, credit_notes: 0, credit_total: 0, total: 0, balance: 0 });
    return sp.get(name);
  };
  inv.forEach((i) => { const r = row(i.salesperson); r.invoices += 1; r.invoice_total += i.total; r.balance += i.balance; });
  cn.forEach((c) => { const r = row(c.salesperson); r.credit_notes += 1; r.credit_total += c.total; });
  const bySalesperson = [...sp.values()].map((r) => ({
    ...r, invoice_total: num(r.invoice_total), credit_total: num(r.credit_total),
    total: num(r.invoice_total - r.credit_total), balance: num(r.balance),
  })).sort((a, b) => b.total - a.total);

  const invoiceTotal = num(inv.reduce((a, i) => a + i.total, 0));
  const creditTotal = num(cn.reduce((a, c) => a + c.total, 0));
  const value = {
    available: true,
    invoice_count: inv.length, invoice_total: invoiceTotal,
    credit_note_count: cn.length, credit_note_total: creditTotal,
    total_sales_with_tax: num(invoiceTotal - creditTotal),
    balance_due: num(inv.reduce((a, i) => a + i.balance, 0)),
    by_salesperson: bySalesperson, invoices: inv, credit_notes: cn,
    warning: creditError, truncated, fetchedAt: new Date().toISOString(), cached: false, source: 'zoho',
  };
  zohoCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function getOverview(req, res, next) {
  try {
    const today = manilaToday();
    const from = req.query.from ? String(req.query.from) : `${today.slice(0, 7)}-01`;
    const to = req.query.to ? String(req.query.to) : today;
    if (!isDate(from) || !isDate(to)) return bad(res, 'from and to must look like 2026-10-01');
    if (from > to) return bad(res, 'from must be on or before to');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > MAX_DAYS) return bad(res, `Pick ${MAX_DAYS} days or fewer`);

    const [fromUtc, toUtc] = utcRange(from, to);
    const notImported = `NOT (${importedSql('o')})`;
    const months = monthsIn(from, to);

    const zohoPromise = readZohoSales(from, to, { fresh: req.query.fresh === '1' })
      .catch((err) => ({ available: false, error: `Could not read from Zoho: ${err.message}` }));

    const result = await db.transaction(async () => {
      await q('SET TRANSACTION READ ONLY');
      await q('SET LOCAL statement_timeout = 10000');

      const orders = await q(
        `SELECT o.id, o.getmeds_order_id AS ref, o.zoho_so_number AS so_number,
                ${MANILA_DAY('o.created_at')} AS date,
                c.name AS customer, u.name AS owner, o.salesperson AS zoho_salesperson,
                o.division, o.status, o.total_amount AS amount
           FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN users u ON u.id = o.medrep_id
          WHERE o.created_at >= $1 AND o.created_at < $2 AND ${notImported}
            AND o.status NOT IN ('draft', 'cancelled', 'deleted')
            AND o.draft_cancelled_at IS NULL
          ORDER BY o.created_at, o.id
          LIMIT ${MAX_ROWS + 1}`,
        [fromUtc, toUtc]
      );

      // Same rule as services/kpiService.js (booked = Finance verified in the period).
      const booked = await q(
        `SELECT b.id, b.ref, b.so_number, ${MANILA_DAY('b.verified_at')} AS date,
                b.customer, b.owner, b.zoho_salesperson, b.division, b.status, b.amount
           FROM (
             SELECT DISTINCT ON (o.id) o.id, o.getmeds_order_id AS ref, o.zoho_so_number AS so_number,
                    fe.created_at AS verified_at, c.name AS customer, u.name AS owner,
                    o.salesperson AS zoho_salesperson, o.division, o.status, o.total_amount AS amount
               FROM order_events fe
               JOIN orders o ON o.id = fe.order_id
               LEFT JOIN customers c ON c.id = o.customer_id
               LEFT JOIN users u ON u.id = o.medrep_id
              WHERE fe.event_type = 'FINANCE_VERIFIED' AND ${notImported}
                AND o.status NOT IN ('cancelled', 'deleted')
                AND fe.created_at >= $1 AND fe.created_at < $2
              ORDER BY o.id, fe.created_at DESC
           ) b
          ORDER BY b.verified_at, b.id
          LIMIT ${MAX_ROWS + 1}`,
        [fromUtc, toUtc]
      );

      const hasTargets = (await q(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'kpi_targets'"
      )).length > 0;
      // Oct 21, 2026: the targets of territories nobody holds (vacant, or no account yet)
      // belong in the company and channel targets too. A row counts while its territory is
      // flagged vacant (even if a lead covers it as a secondary salesperson: that is not
      // their own target) or no account holds it; once the territory is no longer vacant and
      // someone holds it, the target is theirs (kpi_targets), so it is not counted twice.
      const hasTerritoryTargets = (await q(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'territory_targets'"
      )).length > 0;
      const vacantTargets = hasTerritoryTargets ? await q(
        `SELECT tt.label, tt.month, tt.target_php, t.zoho_salesperson, t.manager_id
           FROM territory_targets tt LEFT JOIN sales_territories t ON t.id = tt.territory_id
          WHERE tt.month = ANY($1)
            AND (tt.territory_id IS NULL OR t.is_vacant OR NOT EXISTS (
                  SELECT 1 FROM user_salespersons us
                   WHERE LOWER(TRIM(us.salesperson)) IN (LOWER(TRIM(t.zoho_salesperson)), LOWER(TRIM(COALESCE(t.zoho_alias, ''))))))`,
        [months]
      ) : [];
      const vacantTotal = num(vacantTargets.reduce((a, r) => a + (Number(r.target_php) || 0), 0));
      let target = null;
      let targetPeople = 0;
      if (hasTargets) {
        const row = (await q(
          'SELECT COUNT(*)::int AS n, SUM(target_php) AS total FROM kpi_targets WHERE month = ANY($1)',
          [months]
        ))[0];
        if (row && row.n > 0) { target = num(Number(row.total) + vacantTotal); targetPeople = row.n; }
      }
      // Sales KPIs (Oct 14, 2026): who each Zoho salesperson is, and each person's target.
      // Only for a period that starts on the 1st and stays inside one month.
      let kpiInput = null;
      if (hasTargets && months.length === 1 && from === `${months[0]}-01`) {
        const titled = (await q(
          "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'sales_title'"
        )).length > 0;
        kpiInput = {
          users: await q(`SELECT id, name, role, is_active, team_lead_id${titled ? ', sales_title' : ''} FROM users`),
          accts: await q('SELECT user_id, salesperson, is_primary FROM user_salespersons'),
          terrs: await q('SELECT zoho_salesperson, zoho_alias, manager_id FROM sales_territories'),
          // Oct 15, 2026: the sales channels, for Target Performance by channel
          managers: await q('SELECT id, channel_id FROM sales_managers'),
          channels: await q('SELECT id, name, sort_order FROM sales_channels ORDER BY sort_order, id'),
          targets: await q('SELECT user_id, target_php FROM kpi_targets WHERE month = $1', [months[0]]),
          vacantTargets,
          // Sales Order number -> the order's owner, for orders raised from 60 days before the
          // period to its end (an invoice can come weeks after its order). Split Sales Orders
          // too. Uses the created_at index; the window keeps it small.
          soOwners: await q(
            `SELECT o.zoho_so_number AS so, o.medrep_id AS user_id FROM orders o
              WHERE o.created_at >= $1 AND o.created_at < $2 AND o.zoho_so_number IS NOT NULL AND o.medrep_id IS NOT NULL
             UNION ALL
             SELECT s.zoho_so_number, o.medrep_id FROM orders o JOIN order_split_sales_orders s ON s.order_id = o.id
              WHERE o.created_at >= $1 AND o.created_at < $2 AND s.zoho_so_number IS NOT NULL AND o.medrep_id IS NOT NULL`,
            [new Date(Date.parse(fromUtc) - 60 * 86400000).toISOString(), toUtc]
          ),
        };
      }
      return { orders, booked, target, targetPeople, vacantTotal, vacantCount: vacantTargets.length, kpiInput };
    })();

    const shape = (r) => ({
      id: r.id,
      ref: r.so_number || r.ref,
      date: r.date,
      customer: r.customer || '—',
      salesperson: r.owner || r.zoho_salesperson || '—',
      division: r.division || 'No division',
      status: r.status,
      amount: num(r.amount),
    });
    const truncated = result.orders.length > MAX_ROWS || result.booked.length > MAX_ROWS;
    const zohoSales = await zohoPromise;

    res.json({
      success: true,
      data: {
        from, to, today, months,
        orders: result.orders.slice(0, MAX_ROWS).map(shape),
        booked: result.booked.slice(0, MAX_ROWS).map(shape),
        target_php: result.target,
        target_people: result.targetPeople,
        target_vacant_php: result.vacantTotal,
        truncated,
        zoho: zohoSales,
        sales_kpi: buildSalesKpis({ ...(result.kpiInput || {}), zoho: zohoSales, from, to, month: months.length === 1 ? months[0] : null }),
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
}

/* ───────── Sales KPIs: Zoho Total Sales with Tax vs the monthly targets ─────────
 * Oct 14, 2026 (Aaron): the monthly target is measured against Zoho's "Total Sales with
 * Tax" (invoices minus credit notes), not the app's booked orders.
 *
 * Each invoice is credited to ONE person, the same owner the KPI page credits:
 *   1. its Sales Order number -> the app order -> that order's owner (medrep_id);
 *   2. else (raised directly in Zoho, or the order is older than the window) the account
 *      whose Salesperson the invoice carries (user_salespersons), matched directly or
 *      through the territory's Zoho alias. When several accounts share it, the one marked
 *      primary for it; when that is not exactly one, nobody.
 * Credit notes carry no Sales Order, so they use rule 2. Whatever no rule places stays
 * "not linked to a person", never guessed, and keeps the totals adding up to Zoho's.
 *
 * Pace: the share of the month that has passed by the period's last day (Oct 14 of 31
 * = 45%). On target = at or above pace; At risk = at least 80% of pace; Behind = below.
 */
const AT_RISK_SHARE = 0.8;
const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const statusFor = (actual, target, pace) => {
  if (!target) return null;
  const share = actual / target;
  if (share >= pace) return 'on';
  return share >= pace * AT_RISK_SHARE ? 'risk' : 'behind';
};
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const key = (s) => String(s || '').toLowerCase().trim();
const NO_CHANNEL = 'No channel yet';

function buildSalesKpis({ zoho, from, to, month, users, accts, terrs, targets, vacantTargets = [], soOwners = [], managers = [], channels = [] }) {
  if (!month || from !== `${month}-01`) {
    return { available: false, reason: 'Pick This month or Last month: targets are monthly.' };
  }
  if (!users) return { available: false, reason: 'No monthly targets are set up yet.' };
  if (!zoho || !zoho.available) {
    return { available: false, reason: `Waiting for Zoho: ${(zoho && zoho.error) || 'Total Sales with Tax could not be read.'}` };
  }

  const pace = Math.min(1, Number(to.slice(8, 10)) / daysInMonth(month));
  const byId = new Map(users.map((u) => [u.id, u]));
  const targetOf = new Map(targets.map((t) => [t.user_id, Number(t.target_php) || 0]));

  // Zoho salesperson name -> the account that owns it
  const spelled = new Map(); // any spelling (name or alias) -> the territory's app spelling
  for (const t of terrs) {
    if (t.zoho_salesperson) spelled.set(key(t.zoho_salesperson), key(t.zoho_salesperson));
    if (t.zoho_alias) spelled.set(key(t.zoho_alias), key(t.zoho_salesperson));
  }
  const holders = new Map(); // salesperson -> [{ user_id, is_primary }]
  for (const a of accts) {
    const k = key(a.salesperson);
    if (!holders.has(k)) holders.set(k, []);
    holders.get(k).push(a);
  }
  const ownerOf = (name) => {
    const list = holders.get(key(name)) || holders.get(spelled.get(key(name))) || [];
    if (list.length === 1) return list[0].user_id;
    const primary = list.filter((a) => a.is_primary);
    return primary.length === 1 ? primary[0].user_id : null;
  };

  // Oct 15, 2026 (Aaron): Target Performance by sales channel. A person's channel is the
  // channel of their primary Zoho salesperson's territory (as on the Sales KPIs page); sales
  // nobody owns go to the channel of the invoice's salesperson; the rest, "No channel yet".
  const chById = new Map(channels.map((c) => [c.id, c]));
  const mgrCh = new Map(managers.map((m) => [m.id, m.channel_id]));
  const terrByKey = new Map();
  for (const t of terrs) for (const n of [t.zoho_salesperson, t.zoho_alias]) if (n) terrByKey.set(key(n), t);
  const channelOfName = (name) => { const t = terrByKey.get(key(name)); const c = t && chById.get(mgrCh.get(t.manager_id)); return c ? c.name : null; };
  const personChannel = new Map();
  for (const a of [...accts].sort((x, y) => Number(y.is_primary) - Number(x.is_primary))) {
    if (personChannel.has(a.user_id)) continue;
    const ch = channelOfName(a.salesperson);
    if (ch) personChannel.set(a.user_id, ch);
  }

  const bySo = new Map(soOwners.map((r) => [key(r.so), r.user_id]));
  const sales = new Map(); // user_id -> Zoho total with tax
  const unlinkedBySp = new Map();
  const credit = (uid, salesperson, amount) => {
    if (uid && byId.has(uid)) sales.set(uid, (sales.get(uid) || 0) + amount);
    else unlinkedBySp.set(salesperson, (unlinkedBySp.get(salesperson) || 0) + amount);
  };
  let viaSo = 0;
  for (const i of zoho.invoices || []) {
    const uid = i.so_number ? bySo.get(key(i.so_number)) : null;
    if (uid) viaSo += 1;
    credit(uid || ownerOf(i.salesperson), i.salesperson, i.total);
  }
  for (const c of zoho.credit_notes || []) credit(ownerOf(c.salesperson), c.salesperson, -c.total);
  for (const [uid, v] of sales) sales.set(uid, num(v));
  const unlinked = [...unlinkedBySp].map(([salesperson, total]) => ({ salesperson, total: num(total) })).filter((r) => r.total !== 0);

  const people = users
    .filter((u) => targetOf.has(u.id) || sales.has(u.id))
    .map((u) => {
      const target = targetOf.get(u.id) || 0;
      const actual = sales.get(u.id) || 0;
      const lead = u.team_lead_id ? byId.get(u.team_lead_id) : null;
      return {
        user_id: u.id, name: u.name, role: u.role, title: u.sales_title || '', team_lead: lead ? lead.name : '',
        channel: personChannel.get(u.id) || NO_CHANNEL,
        target_php: target, sales_php: actual, pct_of_target: pctOf(actual, target), status: statusFor(actual, target, pace),
      };
    })
    .sort((a, b) => (b.pct_of_target ?? -1) - (a.pct_of_target ?? -1) || b.sales_php - a.sales_php);

  // Teams: a team lead plus everyone below them in the Team Lead chain (same rule as My Team KPI)
  const below = new Map();
  for (const u of users) if (u.team_lead_id) { if (!below.has(u.team_lead_id)) below.set(u.team_lead_id, []); below.get(u.team_lead_id).push(u.id); }
  const teamOf = (id) => {
    const seen = new Set([id]);
    let level = [...(below.get(id) || [])];
    for (let d = 0; d < 6 && level.length; d++) {
      const next = [];
      for (const x of level) { if (seen.has(x)) continue; seen.add(x); next.push(...(below.get(x) || [])); }
      level = next;
    }
    return [...seen];
  };
  const teams = users
    .filter((u) => u.role === 'team_lead' && below.has(u.id) && u.is_active)
    .map((lead) => {
      const ids = teamOf(lead.id);
      const target = num(ids.reduce((a, id) => a + (targetOf.get(id) || 0), 0));
      const actual = num(ids.reduce((a, id) => a + (sales.get(id) || 0), 0));
      const leadOf = lead.team_lead_id ? byId.get(lead.team_lead_id) : null;
      return {
        user_id: lead.id, name: lead.name, title: lead.sales_title || '', reports_to: leadOf ? leadOf.name : '', people: ids.length,
        target_php: target, sales_php: actual, pct_of_target: pctOf(actual, target), status: statusFor(actual, target, pace),
      };
    })
    .filter((t) => t.target_php > 0 || t.sales_php > 0)
    .sort((a, b) => (b.pct_of_target ?? -1) - (a.pct_of_target ?? -1));

  const chRows = new Map(); // channel -> { target, sales, people }
  const chRow = (name) => { if (!chRows.has(name)) chRows.set(name, { target: 0, sales: 0, people: 0, unlinked: 0, vacant: 0 }); return chRows.get(name); };
  for (const p of people) { const r = chRow(p.channel); r.target += p.target_php; r.sales += p.sales_php; r.people += 1; }
  for (const u of unlinked) { const r = chRow(channelOfName(u.salesperson) || NO_CHANNEL); r.sales += u.total; r.unlinked += u.total; }
  // Oct 21, 2026: a territory nobody holds still has a target; it goes to its channel's target.
  const vacantRows = vacantTargets.map((v) => {
    const ch = chById.get(mgrCh.get(v.manager_id));
    return { label: v.label, channel: ch ? ch.name : NO_CHANNEL, target_php: Number(v.target_php) || 0 };
  });
  for (const v of vacantRows) { const r = chRow(v.channel); r.target += v.target_php; r.vacant += v.target_php; }
  const order = [...channels.map((c) => c.name), NO_CHANNEL];
  const byChannel = [...chRows].map(([name, r]) => ({
    channel: name, people: r.people, target_php: num(r.target), sales_php: num(r.sales), not_linked_php: num(r.unlinked), vacant_target_php: num(r.vacant),
    pct_of_target: pctOf(r.sales, r.target), status: statusFor(r.sales, r.target, pace),
  })).filter((r) => r.target_php > 0 || r.sales_php !== 0)
    .sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel));

  const vacantTotal = num(vacantRows.reduce((a, v) => a + v.target_php, 0));
  const target = num(targets.reduce((a, t) => a + (Number(t.target_php) || 0), 0) + vacantTotal);
  const withTarget = people.filter((p) => p.target_php > 0);
  return {
    available: true, month, pace: Math.round(pace * 1000) / 10,
    total: { target_php: target, sales_php: zoho.total_sales_with_tax, pct_of_target: pctOf(zoho.total_sales_with_tax, target), status: statusFor(zoho.total_sales_with_tax, target, pace) },
    counts: {
      people_with_target: withTarget.length,
      on_pace: withTarget.filter((p) => p.status === 'on').length,
      at_risk: withTarget.filter((p) => p.status === 'risk').length,
      behind: withTarget.filter((p) => p.status === 'behind').length,
      zero_sales: withTarget.filter((p) => p.sales_php <= 0).length,
      teams_with_target: teams.filter((t) => t.target_php > 0).length,
      teams_on_pace: teams.filter((t) => t.status === 'on').length,
      channels_with_target: byChannel.filter((c) => c.target_php > 0).length,
      channels_on_pace: byChannel.filter((c) => c.status === 'on').length,
      invoices: (zoho.invoices || []).length, invoices_via_sales_order: viaSo,
    },
    people, teams, channels: byChannel,
    // Territories nobody holds: their targets are in the totals above and in each channel's.
    vacant: { territories: vacantRows.length, target_php: vacantTotal },
    unlinked: { total: num(unlinked.reduce((a, r) => a + r.total, 0)), rows: unlinked.sort((a, b) => b.total - a.total) },
  };
}

module.exports = { getOverview, readZohoSales, buildSalesKpis, manilaToday, monthsIn, utcRange, _zohoCache: zohoCache };
