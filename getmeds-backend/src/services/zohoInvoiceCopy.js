'use strict';

/**
 * A copy of Zoho's invoices and credit notes in our database (Oct 21, 2026, Aaron).
 *
 * Why: the Admin Overview asked Zoho for every invoice of the period on every open —
 * "Last month" is ~1,230 invoices, ~8 calls and ~12 seconds, close to Vercel's limit — and the
 * KPI Scorecard (IST, DSO, HRR, NZSD) would need far more. Reading a copy takes milliseconds and
 * makes no Zoho calls, however many people open the pages.
 *
 * How it stays fresh (all GET; Zoho is never written to):
 *   recent    — every 15 minutes (Supabase pg_cron calls /api/cron/zoho-invoice-copy): invoices
 *               and credit notes sorted by last_modified_time, newest first, stopping at the
 *               last change already copied (10 minutes of overlap). Usually 1–2 calls.
 *   reconcile — nightly, on the daily cron tick: every invoice and credit note dated this month
 *               and last month, so anything deleted in Zoho is marked deleted here.
 *   backfill  — once, month by month, from the start of the playbook year (Jan 2026), one month
 *               per call so each call stays well inside Vercel's time limit.
 *
 * The Overview reads the copy only when ZOHO_INVOICE_COPY_READ=true, the copy covers the
 * requested dates and the last successful sync is under an hour old; otherwise it reads Zoho
 * live exactly as before. The sync itself runs only when ZOHO_INVOICE_COPY_SYNC=true.
 */

const db = require('../db/database');
const zoho = require('../integrations/zoho');

const q = (sql, params) => db._rawQuery(sql, params);

const PER_PAGE = 200;
const RECENT_MAX_PAGES = 10; // at most 2,000 changes per run; the next run carries on
const RANGE_MAX_PAGES = 30; // 6,000 per month: far above a month's volume
const OVERLAP_MS = 10 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;

const KEY = {
  cursor: (kind) => `zoho_invoice_copy:${kind}_cursor`,
  coveredFrom: 'zoho_invoice_copy:covered_from',
  lastRun: 'zoho_invoice_copy:last_run',
};

const KINDS = {
  invoices: {
    path: '/invoices', listKey: 'invoices', table: 'zoho_invoices', id: 'invoice_id',
    cols: ['invoice_id', 'invoice_number', 'date', 'due_date', 'status', 'customer_id', 'customer_name', 'salesperson_id',
      'salesperson_name', 'reference_number', 'invoicing_from', 'source', 'total', 'balance', 'last_payment_date',
      'created_time', 'last_modified_time'],
    row: (i) => [i.invoice_id, i.invoice_number || null, dateOnly(i.date), i.due_date || null, i.status || null,
      i.customer_id || null, i.customer_name || null, i.salesperson_id || null, clean(i.salesperson_name),
      i.reference_number || null, i.cf_invoicing_from || null, i.cf_source || null, money(i.total), money(i.balance),
      i.last_payment_date || null, i.created_time || null, i.last_modified_time || null],
  },
  creditnotes: {
    path: '/creditnotes', listKey: 'creditnotes', table: 'zoho_credit_notes', id: 'creditnote_id',
    cols: ['creditnote_id', 'creditnote_number', 'date', 'status', 'customer_id', 'customer_name', 'salesperson_id',
      'salesperson_name', 'reference_number', 'total', 'balance', 'created_time', 'last_modified_time'],
    row: (c) => [c.creditnote_id, c.creditnote_number || null, dateOnly(c.date), c.status || null, c.customer_id || null,
      c.customer_name || null, c.salesperson_id || null, clean(c.salesperson_name), c.reference_number || null,
      money(c.total), money(c.balance), c.created_time || null, c.last_modified_time || null],
  },
};

function dateOnly(d) { return String(d || '').slice(0, 10); }
function clean(s) { const v = String(s || '').trim(); return v || null; }
function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
/** Zoho writes "2026-10-21T09:12:03+0800"; JavaScript wants "+08:00". */
function tsMs(s) { return s ? Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN; }

/** Manila today and the first day of this and last month, as YYYY-MM-DD. */
function manilaMonths(now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const [y, m] = today.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { today, thisMonth: today.slice(0, 7), lastMonth: prev };
}
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function liveAdapter() {
  const a = zoho.getZohoAdapter();
  if (typeof a._request !== 'function') throw new Error(`Zoho is in ${a.mode || 'mock'} mode, so there is nothing to copy.`);
  return a;
}

async function getState(key) {
  const r = await q('SELECT value FROM sync_state WHERE key = $1', [key]);
  return r.length ? r[0].value : null;
}
async function setState(key, value) {
  await q(`INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, iso_now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = iso_now()`, [key, value]);
}

/** Insert or update one page of rows in a single statement. */
async function upsert(kind, items) {
  const k = KINDS[kind];
  const rows = items.filter((x) => x && x[k.id]).map(k.row);
  if (!rows.length) return 0;
  const n = k.cols.length;
  const values = rows.map((_, r) => `(${k.cols.map((__, c) => `$${r * n + c + 1}`).join(', ')}, NULL, iso_now())`).join(', ');
  const updates = k.cols.filter((c) => c !== k.id).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await q(
    `INSERT INTO ${k.table} (${k.cols.join(', ')}, deleted_at, synced_at) VALUES ${values}
     ON CONFLICT (${k.id}) DO UPDATE SET ${updates}, deleted_at = NULL, synced_at = iso_now()`,
    rows.flat()
  );
  return rows.length;
}

/**
 * Newest changes first, until we reach what the last run already copied.
 * Returns { copied, calls, cursor }.
 */
async function syncRecent(kind, { adapter = liveAdapter() } = {}) {
  const k = KINDS[kind];
  const stored = await getState(KEY.cursor(kind));
  if (!stored) return { copied: 0, calls: 0, skipped: 'no backfill yet' };
  const stopAt = Date.parse(stored) - OVERLAP_MS;
  let newest = Date.parse(stored);
  let copied = 0; let calls = 0;
  for (let page = 1; page <= RECENT_MAX_PAGES; page++) {
    const json = await adapter._request('GET', k.path, {
      query: { sort_column: 'last_modified_time', sort_order: 'D', page: String(page), per_page: String(PER_PAGE) },
    });
    calls += 1;
    const items = json[k.listKey] || [];
    const fresh = items.filter((x) => !(tsMs(x.last_modified_time) <= stopAt));
    copied += await upsert(kind, fresh);
    for (const x of fresh) { const t = tsMs(x.last_modified_time); if (t > newest) newest = t; }
    const reachedOld = items.some((x) => tsMs(x.last_modified_time) <= stopAt);
    if (reachedOld || !(json.page_context && json.page_context.has_more_page)) break;
  }
  const cursor = new Date(newest).toISOString();
  await setState(KEY.cursor(kind), cursor);
  return { copied, calls, cursor };
}

/**
 * Everything dated from..to, and anything in the copy for those dates that Zoho no longer has
 * is marked deleted. A list cut short by the page cap marks nothing deleted.
 */
async function syncRange(kind, from, to, { adapter = liveAdapter() } = {}) {
  const k = KINDS[kind];
  const seen = []; let calls = 0; let truncated = true; let copied = 0;
  for (let page = 1; page <= RANGE_MAX_PAGES; page++) {
    const json = await adapter._request('GET', k.path, {
      query: { date_start: from, date_end: to, sort_column: 'date', page: String(page), per_page: String(PER_PAGE) },
    });
    calls += 1;
    const items = (json[k.listKey] || []).filter((x) => { const d = dateOnly(x.date); return d >= from && d <= to; });
    copied += await upsert(kind, items);
    seen.push(...items.map((x) => String(x[k.id])));
    if (!(json.page_context && json.page_context.has_more_page)) { truncated = false; break; }
  }
  let markedDeleted = 0;
  if (!truncated) {
    const r = await q(
      `UPDATE ${k.table} SET deleted_at = iso_now()
        WHERE date >= $1 AND date <= $2 AND deleted_at IS NULL AND NOT (${k.id} = ANY($3::text[]))
        RETURNING ${k.id}`, [from, to, seen]);
    markedDeleted = r.length;
  }
  return { copied, calls, truncated, markedDeleted };
}

/** The 15-minute run: recent changes of both kinds. */
async function runRecent(opts = {}) {
  const invoices = await syncRecent('invoices', opts);
  const creditnotes = await syncRecent('creditnotes', opts);
  if (!invoices.skipped) await setState(KEY.lastRun, new Date().toISOString());
  return { invoices, creditnotes };
}

/** One month of history (YYYY-MM). The first backfill also starts the 15-minute cursor. */
async function backfillMonth(month, opts = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('month must look like 2026-01');
  const startedAt = new Date().toISOString();
  const from = `${month}-01`; const to = monthEnd(month);
  const invoices = await syncRange('invoices', from, to, opts);
  const creditnotes = await syncRange('creditnotes', from, to, opts);
  for (const kind of Object.keys(KINDS)) {
    if (!(await getState(KEY.cursor(kind)))) await setState(KEY.cursor(kind), startedAt);
  }
  const covered = await getState(KEY.coveredFrom);
  if (!covered || from < covered) await setState(KEY.coveredFrom, from);
  await setState(KEY.lastRun, new Date().toISOString());
  return { month, invoices, creditnotes };
}

/** Nightly: this month and last month in full. */
async function reconcile(opts = {}) {
  const { thisMonth, lastMonth } = manilaMonths();
  const out = {};
  for (const month of [lastMonth, thisMonth]) {
    out[month] = {
      invoices: await syncRange('invoices', `${month}-01`, monthEnd(month), opts),
      creditnotes: await syncRange('creditnotes', `${month}-01`, monthEnd(month), opts),
    };
  }
  await setState(KEY.lastRun, new Date().toISOString());
  return out;
}

async function status() {
  const [coveredFrom, lastRun, invCursor, cnCursor] = await Promise.all([
    getState(KEY.coveredFrom), getState(KEY.lastRun), getState(KEY.cursor('invoices')), getState(KEY.cursor('creditnotes')),
  ]);
  return { coveredFrom, lastRun, cursors: { invoices: invCursor, creditnotes: cnCursor } };
}

/**
 * The same shape the Overview's live Zoho read returns, from the copy — or null when the copy
 * doesn't cover the dates or hasn't synced within the hour (the caller then reads Zoho live).
 */
async function readSales(from, to, { now = Date.now() } = {}) {
  const st = await status();
  if (!st.coveredFrom || from < st.coveredFrom) return null;
  if (!st.lastRun || now - Date.parse(st.lastRun) > STALE_MS) return null;

  const counted = "deleted_at IS NULL AND lower(coalesce(status, '')) NOT IN ('draft', 'void')";
  const invRows = await q(
    `SELECT invoice_number AS number, date, coalesce(customer_name, '—') AS customer,
            coalesce(salesperson_name, 'No salesperson') AS salesperson, coalesce(reference_number, '') AS so_number,
            status, total, balance
       FROM zoho_invoices WHERE date >= $1 AND date <= $2 AND ${counted} ORDER BY date, invoice_number`, [from, to]);
  const cnRows = await q(
    `SELECT creditnote_number AS number, date, coalesce(customer_name, '—') AS customer,
            coalesce(salesperson_name, 'No salesperson') AS salesperson, coalesce(reference_number, '') AS reference,
            status, total
       FROM zoho_credit_notes WHERE date >= $1 AND date <= $2 AND ${counted} ORDER BY date, creditnote_number`, [from, to]);
  const inv = invRows.map((r) => ({ ...r, total: Number(r.total), balance: Number(r.balance) }));
  const cn = cnRows.map((r) => ({ ...r, total: Number(r.total) }));

  // Sums in centavos, so the totals match Zoho's report exactly.
  const cents = (n) => Math.round(n * 100);
  const sp = new Map();
  const row = (name) => {
    if (!sp.has(name)) sp.set(name, { name, invoices: 0, inv: 0, credit_notes: 0, cn: 0, bal: 0 });
    return sp.get(name);
  };
  inv.forEach((i) => { const r = row(i.salesperson); r.invoices += 1; r.inv += cents(i.total); r.bal += cents(i.balance); });
  cn.forEach((c) => { const r = row(c.salesperson); r.credit_notes += 1; r.cn += cents(c.total); });
  const bySalesperson = [...sp.values()].map((r) => ({
    name: r.name, invoices: r.invoices, invoice_total: r.inv / 100, credit_notes: r.credit_notes, credit_total: r.cn / 100,
    total: (r.inv - r.cn) / 100, balance: r.bal / 100,
  })).sort((a, b) => b.total - a.total);
  const invC = inv.reduce((a, i) => a + cents(i.total), 0);
  const cnC = cn.reduce((a, c) => a + cents(c.total), 0);
  return {
    available: true, source: 'copy',
    invoice_count: inv.length, invoice_total: invC / 100,
    credit_note_count: cn.length, credit_note_total: cnC / 100,
    total_sales_with_tax: (invC - cnC) / 100,
    balance_due: inv.reduce((a, i) => a + cents(i.balance), 0) / 100,
    by_salesperson: bySalesperson, invoices: inv, credit_notes: cn,
    warning: null, truncated: false, fetchedAt: st.lastRun, cached: false,
  };
}

const syncOn = () => process.env.ZOHO_INVOICE_COPY_SYNC === 'true';
const readOn = () => process.env.ZOHO_INVOICE_COPY_READ === 'true';

module.exports = {
  runRecent, backfillMonth, reconcile, readSales, status, syncRecent, syncRange, syncOn, readOn,
  _test: { tsMs, monthEnd, manilaMonths, KEY },
};
