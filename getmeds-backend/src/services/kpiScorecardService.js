'use strict';

/**
 * KPI Scorecard: NZSD and HRR from the Zoho invoice copy (Oct 21, 2026, Aaron). Try-out.
 *
 * The Hospital CHC playbook KPIs, per Zoho salesperson (the CHC's territory, e.g. HOS | LAGUNA),
 * read from zoho_invoices (services/zohoInvoiceCopy.js). No Zoho calls. Rules Aaron picked for
 * this first version (easy to change, see kpi/kpi-zoho-report.html decisions):
 *
 *   NZSD % = working days with at least one invoice ÷ working days so far × 100
 *            day = the invoice's CREATION day in Manila (it can't be backdated);
 *            working days = Monday to Friday, no holidays yet; draft, void and deleted left out.
 *            95–100 → 15 · 90–94 → 12 · 80–89 → 9 · 70–79 → 6 · below 70 → 0
 *
 *   HRR %  = customers invoiced last month AND this month ÷ customers invoiced last month × 100
 *            all customers for now (hospitals are not tagged on customers yet);
 *            invoice DATE decides the month; draft, void and deleted left out.
 *            95–100 → 15 · 85–94 → 12 · 75–84 → 8 · below 75 → 0
 *
 *   DSO    = open AR ÷ (credit sales this month ÷ days so far)          (added Oct 21, 2026)
 *            open AR = unpaid balance on the salesperson's invoices, any date (draft, void, deleted left out);
 *            credit sales = invoices dated this month whose due date is AFTER the invoice date (Aaron:
 *            same-day-due invoices behave like cash); days so far = calendar days to today.
 *            Today's figure only: Zoho knows today's unpaid balance, not last month's.
 *            below 60 → 20 + bonus · 60–70 → 20 · 71–89 → 10 · 90 and above → 0
 *
 *   IST    = invoiced sales this month ÷ the person's monthly target × 100   (added Oct 21, 2026)
 *            per PERSON (Aaron): the target set on Sales KPIs (kpi_targets); invoiced = Zoho Total Sales
 *            with Tax (invoices minus credit notes), each invoice credited to the owner of its GetMeds
 *            order by Sales Order number, else to the account holding its Zoho salesperson — the same
 *            rule as the Overview and My KPIs (adminOverview.controller buildSalesKpis).
 *            The running month is scored on the month-end projection (IST so far × days in month ÷ days so far).
 *            above 90% → 50 (above 110% + bonus) · 81–90 → 40 · 71–80 → 30 · 61–70 → 20 · 60% and below → 0,
 *            and 0 points on IST caps the whole month's scorecard at 40.
 *
 * The pure functions take plain rows so they can be tested without a database.
 */

const db = require('../db/database');

const q = (sql, params) => db._rawQuery(sql, params);
const COUNTED = "deleted_at IS NULL AND lower(coalesce(status, '')) NOT IN ('draft', 'void')";

const nzsdPts = (p) => (p >= 95 ? 15 : p >= 90 ? 12 : p >= 80 ? 9 : p >= 70 ? 6 : 0);
const hrrPts = (p) => (p >= 95 ? 15 : p >= 85 ? 12 : p >= 75 ? 8 : 0);
const istPts = (p) => (p == null ? 0 : p > 90 ? 50 : p > 80 ? 40 : p > 70 ? 30 : p > 60 ? 20 : 0);
const dsoPts = (d) => (d == null ? 0 : d <= 70 ? 20 : d < 90 ? 10 : 0);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function prevMonth(month) { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; }
function manilaToday(now = new Date()) { return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

/** The Manila calendar day of a Zoho timestamp like "2026-10-21T09:12:03+0800". */
function manilaDay(ts) {
  if (!ts) return null;
  const ms = Date.parse(String(ts).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(ms) ? null : new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Monday–Friday dates of the month up to `upTo` (inclusive). */
function workingDays(month, upTo) {
  const out = [];
  for (let d = 1; d <= daysInMonth(month); d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (upTo && iso > upTo) break;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(iso);
  }
  return out;
}

/**
 * rows: [{ salesperson, created_time }] for invoices created in the month.
 * Returns one row per salesperson with the days they invoiced and their zero-sales days.
 */
function computeNzsd(rows, month, { today = manilaToday() } = {}) {
  const upTo = today.slice(0, 7) === month ? today : null;
  const days = workingDays(month, upTo);
  const daySet = new Set(days);
  const by = new Map();
  for (const r of rows) {
    const sp = r.salesperson || 'No salesperson';
    if (!by.has(sp)) by.set(sp, new Set());
    const d = manilaDay(r.created_time);
    if (d && d.slice(0, 7) === month) by.get(sp).add(d);
  }
  const people = [...by.entries()].map(([salesperson, set]) => {
    const sold = days.filter((d) => set.has(d));
    const nz = pct(sold.length, days.length);
    return {
      salesperson, working_days: days.length, days_with_sales: sold.length,
      zero_days: days.filter((d) => !set.has(d)), weekend_sales_days: [...set].filter((d) => !daySet.has(d)).sort(),
      sold_days: sold, nzsd_pct: nz, points: nz == null ? 0 : nzsdPts(nz),
    };
  }).sort((a, b) => (b.nzsd_pct ?? -1) - (a.nzsd_pct ?? -1) || a.salesperson.localeCompare(b.salesperson));
  return { month, working_days: days, partial: !!upTo, people };
}

/**
 * last / current: [{ salesperson, customer_id, customer_name, total }] invoices dated last month / this month.
 * A customer counts for the salesperson on the invoice. Returns HRR per salesperson and the lapsed list.
 */
function computeHrr(last, current, month) {
  const key = (r) => r.customer_id || r.customer_name || '?';
  const lastBy = new Map();
  for (const r of last) {
    const sp = r.salesperson || 'No salesperson';
    if (!lastBy.has(sp)) lastBy.set(sp, new Map());
    const m = lastBy.get(sp);
    const k = key(r);
    const c = m.get(k) || { customer: r.customer_name || '—', sales: 0 };
    c.sales += Number(r.total) || 0;
    m.set(k, c);
  }
  const curBy = new Map();
  for (const r of current) {
    const sp = r.salesperson || 'No salesperson';
    if (!curBy.has(sp)) curBy.set(sp, new Set());
    curBy.get(sp).add(key(r));
  }
  const lapsed = [];
  const people = [...lastBy.entries()].map(([salesperson, customers]) => {
    const now = curBy.get(salesperson) || new Set();
    let kept = 0;
    for (const [k, c] of customers) {
      if (now.has(k)) kept += 1;
      else lapsed.push({ salesperson, customer: c.customer, last_month_sales: Math.round(c.sales * 100) / 100 });
    }
    const hrr = pct(kept, customers.size);
    return { salesperson, last_month_customers: customers.size, kept, lapsed: customers.size - kept, hrr_pct: hrr, points: hrrPts(hrr ?? 0) };
  }).sort((a, b) => (b.hrr_pct ?? -1) - (a.hrr_pct ?? -1) || a.salesperson.localeCompare(b.salesperson));
  const totLast = people.reduce((a, p) => a + p.last_month_customers, 0);
  const totKept = people.reduce((a, p) => a + p.kept, 0);
  lapsed.sort((a, b) => b.last_month_sales - a.last_month_sales);
  return { month, previous_month: prevMonth(month), total: { last_month_customers: totLast, kept: totKept, hrr_pct: pct(totKept, totLast) }, people, lapsed };
}

/**
 * open: [{ salesperson, customer_name, date, balance }] every unpaid invoice;
 * credit: [{ salesperson, total }] this month's invoices due after their invoice date.
 */
function computeDso(open, credit, today) {
  const days = Number(today.slice(8, 10));
  const age = (d) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000);
  const bucket = (a) => (a <= 30 ? 0 : a <= 60 ? 1 : a <= 90 ? 2 : 3);
  const by = new Map();
  const row = (sp) => {
    if (!by.has(sp)) by.set(sp, { salesperson: sp, open_ar: 0, credit_sales: 0, aging: [0, 0, 0, 0], open_invoices: 0, oldest_days: 0 });
    return by.get(sp);
  };
  for (const r of open) {
    const p = row(r.salesperson || 'No salesperson');
    const b = Number(r.balance) || 0;
    const a = age(r.date);
    p.open_ar += b; p.aging[bucket(a)] += b; p.open_invoices += 1; p.oldest_days = Math.max(p.oldest_days, a);
  }
  for (const r of credit) row(r.salesperson || 'No salesperson').credit_sales += Number(r.total) || 0;
  const r2 = (n) => Math.round(n * 100) / 100;
  const people = [...by.values()].map((p) => {
    const perDay = p.credit_sales / days;
    const dso = perDay > 0 ? Math.round(p.open_ar / perDay) : null;
    return { ...p, open_ar: r2(p.open_ar), credit_sales: r2(p.credit_sales), aging: p.aging.map(r2), dso_days: dso, points: dsoPts(dso), bonus: dso != null && dso < 60 };
  }).filter((p) => p.open_ar > 0 || p.credit_sales > 0)
    .sort((a, b) => (a.dso_days ?? 1e9) - (b.dso_days ?? 1e9) || b.open_ar - a.open_ar);
  const ar = people.reduce((a, p) => a + p.open_ar, 0);
  const cs = people.reduce((a, p) => a + p.credit_sales, 0);
  return {
    today, days_so_far: days,
    total: { open_ar: r2(ar), credit_sales: r2(cs), dso_days: cs > 0 ? Math.round(ar / (cs / days)) : null, aging: [0, 1, 2, 3].map((i) => r2(people.reduce((a, p) => a + p.aging[i], 0))) },
    people,
    monday_call: people.filter((p) => p.dso_days == null ? p.open_ar > 0 : p.dso_days > 70)
      .map((p) => ({ salesperson: p.salesperson, dso_days: p.dso_days, open_ar: p.open_ar, oldest_days: p.oldest_days })),
  };
}

/** Optional filter: salespersons whose Zoho name starts with a division, e.g. "HOS". */
const prefixSql = (prefix, idx) => (prefix ? ` AND upper(salesperson_name) LIKE $${idx}` : '');
const prefixParam = (prefix) => (prefix ? [`${String(prefix).toUpperCase()}%`] : []);

async function nzsd(month, { prefix } = {}) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  // created_time is Manila-local text; a day of slack on each side, then the exact day is checked in JS
  const rows = await q(
    `SELECT coalesce(salesperson_name, 'No salesperson') AS salesperson, created_time
       FROM zoho_invoices
      WHERE ${COUNTED} AND created_time >= $1 AND created_time < $2${prefixSql(prefix, 3)}`,
    [`${prevMonth(month)}-28`, `${next}-02`, ...prefixParam(prefix)]);
  return computeNzsd(rows, month);
}

async function hrr(month, { prefix } = {}) {
  const read = (mm) => q(
    `SELECT coalesce(salesperson_name, 'No salesperson') AS salesperson, customer_id, customer_name, total
       FROM zoho_invoices
      WHERE ${COUNTED} AND date >= $1 AND date <= $2${prefixSql(prefix, 3)}`,
    [`${mm}-01`, `${mm}-${String(daysInMonth(mm)).padStart(2, '0')}`, ...prefixParam(prefix)]);
  const [last, current] = await Promise.all([read(prevMonth(month)), read(month)]);
  return computeHrr(last, current, month);
}

/**
 * people: buildSalesKpis people rows ({ user_id, name, title, team_lead, channel, target_php, sales_php }).
 * Adds IST %, the month-end projection, points and the cap flag.
 */
function computeIst(people, month, today = manilaToday()) {
  const total = daysInMonth(month);
  const running = today.slice(0, 7) === month;
  const daysSoFar = running ? Number(today.slice(8, 10)) : total;
  const r1 = (n) => Math.round(n * 10) / 10;
  const rows = people.map((p) => {
    const now = p.target_php > 0 ? r1((p.sales_php / p.target_php) * 100) : null;
    const projected = now == null ? null : r1((now * total) / daysSoFar);
    const scored = running ? projected : now;
    const points = p.target_php > 0 ? istPts(scored) : null;
    return {
      user_id: p.user_id, name: p.name, title: p.title || '', team_lead: p.team_lead || '', channel: p.channel || '',
      target_php: p.target_php, invoiced_php: p.sales_php, balance_php: Math.round((p.target_php - p.sales_php) * 100) / 100,
      ist_now_pct: now, ist_projected_pct: projected, points, bonus: scored != null && scored > 110, caps_month: points === 0,
    };
  }).sort((a, b) => (b.ist_projected_pct ?? -1) - (a.ist_projected_pct ?? -1) || b.invoiced_php - a.invoiced_php);
  const withTarget = rows.filter((r) => r.target_php > 0);
  const target = withTarget.reduce((a, r) => a + r.target_php, 0);
  const invoiced = withTarget.reduce((a, r) => a + r.invoiced_php, 0);
  const nowPct = target ? r1((invoiced / target) * 100) : null;
  return {
    month, today, running, days_so_far: daysSoFar, days_in_month: total, pace_pct: r1((daysSoFar / total) * 100),
    total: { target_php: Math.round(target * 100) / 100, invoiced_php: Math.round(invoiced * 100) / 100, ist_now_pct: nowPct,
      ist_projected_pct: nowPct == null ? null : r1((nowPct * total) / daysSoFar), people_with_target: withTarget.length,
      at_zero: withTarget.filter((r) => r.points === 0).length, at_full: withTarget.filter((r) => r.points === 50).length },
    people: rows,
  };
}

// The Division filter on the page names Zoho prefixes; IST rows are people, so it maps to their channel.
const CHANNEL_OF_PREFIX = { HOS: 'HOSP', STC: 'RX · STC', 'B&B': 'RX · B&B', URO: 'RX · URO', B2C: 'RX · B2C', TELESALES: 'TELESALES', B2B: 'B2B', BID: 'BID', CLIDP: 'CLIDP', MT: 'MT' };

async function ist(month, { prefix, today = manilaToday() } = {}) {
  const { buildSalesKpis } = require('../controllers/adminOverview.controller');
  const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const to = today.slice(0, 7) === month ? today : last;
  const counted = COUNTED;
  const [invoices, creditNotes] = await Promise.all([
    q(`SELECT coalesce(salesperson_name, 'No salesperson') AS salesperson, coalesce(reference_number, '') AS so_number, total
         FROM zoho_invoices WHERE ${counted} AND date >= $1 AND date <= $2`, [`${month}-01`, to]),
    q(`SELECT coalesce(salesperson_name, 'No salesperson') AS salesperson, total
         FROM zoho_credit_notes WHERE ${counted} AND date >= $1 AND date <= $2`, [`${month}-01`, to]),
  ]);
  const inv = invoices.map((r) => ({ ...r, total: Number(r.total) }));
  const cn = creditNotes.map((r) => ({ ...r, total: Number(r.total) }));
  const cents = (n) => Math.round(n * 100);
  const totalWithTax = (inv.reduce((a, r) => a + cents(r.total), 0) - cn.reduce((a, r) => a + cents(r.total), 0)) / 100;
  const titled = (await q("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'sales_title'")).length > 0;
  const startUtc = new Date(`${month}-01T00:00:00+08:00`).getTime();
  const [users, accts, terrs, managers, channels, targets, soOwners] = await Promise.all([
    q(`SELECT id, name, role, is_active, team_lead_id${titled ? ', sales_title' : ''} FROM users`),
    q('SELECT user_id, salesperson, is_primary FROM user_salespersons'),
    q('SELECT zoho_salesperson, zoho_alias, manager_id FROM sales_territories'),
    q('SELECT id, channel_id FROM sales_managers'),
    q('SELECT id, name, sort_order FROM sales_channels ORDER BY sort_order, id'),
    q('SELECT user_id, target_php FROM kpi_targets WHERE month = $1', [month]),
    q(`SELECT o.zoho_so_number AS so, o.medrep_id AS user_id FROM orders o
        WHERE o.created_at >= $1 AND o.created_at < $2 AND o.zoho_so_number IS NOT NULL AND o.medrep_id IS NOT NULL
       UNION ALL
       SELECT s.zoho_so_number, o.medrep_id FROM orders o JOIN order_split_sales_orders s ON s.order_id = o.id
        WHERE o.created_at >= $1 AND o.created_at < $2 AND s.zoho_so_number IS NOT NULL AND o.medrep_id IS NOT NULL`,
    [new Date(startUtc - 60 * 86400000).toISOString(), new Date(`${to}T23:59:59+08:00`).toISOString()]),
  ]);
  const k = buildSalesKpis({
    zoho: { available: true, total_sales_with_tax: totalWithTax, invoices: inv, credit_notes: cn },
    from: `${month}-01`, to, month, users, accts, terrs, targets, soOwners, managers, channels,
  });
  if (!k.available) return { month, available: false, reason: k.reason };
  let people = k.people;
  const ch = prefix ? CHANNEL_OF_PREFIX[String(prefix).toUpperCase()] : null;
  if (prefix) people = people.filter((p) => p.channel === ch);
  return { ...computeIst(people, month, today), not_linked_php: prefix ? null : k.unlinked.total, zoho_total_php: totalWithTax };
}

async function dso({ prefix, today = manilaToday() } = {}) {
  const month = today.slice(0, 7);
  const open = await q(
    `SELECT coalesce(salesperson_name, 'No salesperson') AS salesperson, customer_name, date, balance
       FROM zoho_invoices WHERE ${COUNTED} AND balance > 0${prefixSql(prefix, 1)}`, prefixParam(prefix));
  const credit = await q(
    `SELECT coalesce(salesperson_name, 'No salesperson') AS salesperson, total
       FROM zoho_invoices
      WHERE ${COUNTED} AND date >= $1 AND date <= $2 AND due_date IS NOT NULL AND due_date > date${prefixSql(prefix, 3)}`,
    [`${month}-01`, today, ...prefixParam(prefix)]);
  return { month, ...computeDso(open, credit, today) };
}

module.exports = { nzsd, hrr, dso, ist, computeNzsd, computeHrr, computeDso, computeIst, _test: { workingDays, manilaDay, nzsdPts, hrrPts, dsoPts, istPts, prevMonth } };
