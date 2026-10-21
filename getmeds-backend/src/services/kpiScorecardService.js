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
 * The pure functions take plain rows so they can be tested without a database.
 */

const db = require('../db/database');

const q = (sql, params) => db._rawQuery(sql, params);
const COUNTED = "deleted_at IS NULL AND lower(coalesce(status, '')) NOT IN ('draft', 'void')";

const nzsdPts = (p) => (p >= 95 ? 15 : p >= 90 ? 12 : p >= 80 ? 9 : p >= 70 ? 6 : 0);
const hrrPts = (p) => (p >= 95 ? 15 : p >= 85 ? 12 : p >= 75 ? 8 : 0);
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

module.exports = { nzsd, hrr, computeNzsd, computeHrr, _test: { workingDays, manilaDay, nzsdPts, hrrPts, prevMonth } };
