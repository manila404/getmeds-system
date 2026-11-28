#!/usr/bin/env node
'use strict';

/**
 * Correct invoices the Hub made before 4948870 (Nov 28, 2026).
 *
 * WHY: until 4948870 the Hub created invoices without the Sales Order's payment
 * terms, VAT setting or line taxes, so Zoho used the CUSTOMER's defaults. Invoices
 * came out "Paid" or "net 60" whatever the SO said, and some had 12% VAT added on
 * top of VAT-inclusive prices. See src/integrations/zoho/invoiceFromSalesOrder.js.
 *
 * WHICH INVOICES: every invoice the Hub created (order_events ZOHO_INVOICE_SENT
 * "Zoho Invoice ... created & marked Sent"), read from the live database.
 *
 * THIS VERSION ONLY READS. For each invoice: GET the invoice, GET its Sales Order,
 * compare, and write the plan to a CSV. Nothing in Zoho is changed.
 *
 *   ZOHO_SHARED_TOKEN=off node scripts/fix-invoice-terms-from-so.js --env .env.live.local
 *   ... --limit 5            just the first 5
 *   ... --pause-ms 700       between Zoho calls (2 calls per invoice)
 */
const path = require('path');
const fs = require('fs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const ENV_FILE = arg('--env', '.env');
require('dotenv').config({ path: path.join(__dirname, '..', ENV_FILE) });
process.env.ZOHO_SHARED_TOKEN = 'off';

const { Client } = require('pg');
const zoho = require('../src/integrations/zoho');

const LIMIT = Number(arg('--limit', 0)) || Infinity;
const PAUSE_MS = Number(arg('--pause-ms', 700));
const OUT = arg('--out', path.join(__dirname, '..', '..', '..', 'getmeds-documents', 'Invoice_Terms_Fix_Plan_2026-11-28.csv'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (v) => v !== undefined && v !== null && v !== '';

async function hubInvoices() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const r = await c.query(`
      WITH hub AS (
        SELECT DISTINCT ON (inv_no) o.getmeds_order_id, substring(e.notes from 'Zoho Invoice (\\S+) created') AS inv_no, e.created_at
          FROM order_events e JOIN orders o ON o.id = e.order_id
         WHERE e.event_type = 'ZOHO_INVOICE_SENT' AND e.notes LIKE 'Zoho Invoice % created & marked Sent%'
         ORDER BY inv_no, e.created_at)
      SELECT hub.*, zi.invoice_id
        FROM hub LEFT JOIN zoho_invoices zi ON zi.invoice_number = hub.inv_no AND zi.deleted_at IS NULL
       ORDER BY hub.created_at`);
    return r.rows;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

function compare(inv, so) {
  const diffs = [];
  const soDays = Number(so.payment_terms || 0);
  if (Number(inv.payment_terms || 0) !== soDays || String(inv.payment_terms_label || '') !== String(so.payment_terms_label || '')) {
    diffs.push('terms');
  }
  if (typeof so.is_inclusive_tax === 'boolean' && inv.is_inclusive_tax !== so.is_inclusive_tax) diffs.push('vat_setting');
  const soLines = new Map((so.line_items || []).map((l) => [String(l.line_item_id), l]));
  const taxOff = (inv.line_items || []).filter((l) => {
    const s = soLines.get(String(l.salesorder_item_id));
    return s && has(s.tax_id) && String(s.tax_id) !== String(l.tax_id || '');
  });
  if (taxOff.length) diffs.push('line_tax');
  if (has(so.terms) && String(inv.terms || '') !== String(so.terms)) diffs.push('terms_text');
  return diffs;
}

function decide(inv, so, diffs) {
  const status = String(inv.status || '').toLowerCase();
  // Money is judged by the total, not the flags: on No-Tax lines the VAT
  // setting changes nothing. An invoice covers its whole SO (the Hub makes
  // one SO per invoicing entity), so the totals should match.
  const amountChanges = Math.abs(Number(inv.total || 0) - Number(so.total || 0)) > 0.5;
  if (amountChanges && !diffs.includes('vat_setting') && !diffs.includes('line_tax')) diffs.push('total_other');
  const paidSomething = Number(inv.payment_made || 0) > 0 || Number(inv.credits_applied || 0) > 0 || ['paid', 'partially_paid'].includes(status);
  if (!diffs.length) return 'ok';
  if (status === 'void') return 'skip_void';
  if (amountChanges && paidSomething) return 'finance_amount_paid';
  if (paidSomething) return 'fix_terms_only_paid';
  return amountChanges ? 'fix_terms_and_amount' : 'fix_terms_only';
}

const csv = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ─── --apply ────────────────────────────────────────────────────────────────
//
// Reads the plan CSV (the dry run's output), and for each invoice in the chosen
// groups: GET the invoice and its SO fresh, PUT only the fields that differ,
// GET the invoice again and check. The lines (item, quantity, rate, warehouse,
// batches) must come back exactly as they were — if not, it stops at once.
// Progress is saved after every invoice; a rerun skips the ones already done.
//
//   ... --apply --groups fix_terms_only --only INV-12844316     one invoice
//   ... --apply --groups fix_terms_only,fix_terms_and_amount,fix_terms_only_paid

const APPLY = process.argv.includes('--apply');
const GROUPS = String(arg('--groups', '')).split(',').filter(Boolean);
const ONLY = new Set(String(arg('--only', '')).split(',').filter(Boolean));
const PLAN = arg('--plan', path.join(__dirname, '..', '..', '..', 'getmeds-documents', 'Invoice_Terms_Fix_Plan_2026-11-28.csv'));
const RESULTS = arg('--results', path.join(__dirname, '..', '..', '..', 'getmeds-documents', 'Invoice_Terms_Fix_Results_2026-11-28.csv'));
const PROGRESS = path.join(__dirname, 'fix-invoice-terms-progress.json');

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    rows.push(out);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const lineKey = (l) => JSON.stringify({
  id: String(l.line_item_id), item: String(l.item_id || ''), qty: Number(l.quantity), rate: Number(l.rate),
  wh: String(l.warehouse_id || ''),
  batches: (l.batches || []).map((b) => [String(b.batch_id || ''), String(b.batch_number || ''), Number(b.out_quantity || b.quantity || 0)])
});

function correctionBody(inv, so) {
  const body = {};
  const soDays = Number(so.payment_terms || 0);
  if (Number(inv.payment_terms || 0) !== soDays || String(inv.payment_terms_label || '') !== String(so.payment_terms_label || '')) {
    body.payment_terms = soDays;
    body.payment_terms_label = so.payment_terms_label;
  }
  if (typeof so.is_inclusive_tax === 'boolean' && inv.is_inclusive_tax !== so.is_inclusive_tax) body.is_inclusive_tax = so.is_inclusive_tax;
  if (has(so.terms) && String(inv.terms || '') !== String(so.terms)) body.terms = so.terms;
  return body;
}

async function applyPlan(adapter) {
  if (!GROUPS.length) throw new Error('--apply needs --groups (e.g. fix_terms_only)');
  process.env.ZOHO_ALLOW_INVOICE_CORRECTION = '1';
  const progress = fs.existsSync(PROGRESS) ? JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) : { done: {} };
  const plan = parseCsv(fs.readFileSync(PLAN, 'utf8'))
    .filter((r) => GROUPS.includes(r.action) && r.invoice_id && !progress.done[r.invoice_id])
    .filter((r) => !ONLY.size || ONLY.has(r.invoice))
    .slice(0, LIMIT);
  console.log(`${plan.length} invoices to correct (groups: ${GROUPS.join(', ')})`);

  const cols = ['when', 'invoice', 'so', 'customer', 'group', 'result', 'changed', 'terms_before', 'terms_after', 'total_before', 'total_after', 'so_total', 'balance_after', 'note'];
  if (!fs.existsSync(RESULTS)) fs.writeFileSync(RESULTS, cols.join(',') + '\r\n');
  const record = (o) => fs.appendFileSync(RESULTS, cols.map((c) => csv(o[c])).join(',') + '\r\n');

  let errorsInRow = 0;
  const tally = {};
  for (const r of plan) {
    const base = { when: new Date().toISOString(), invoice: r.invoice, so: r.so, customer: r.customer, group: r.action };
    try {
      const { invoice: inv } = await adapter._request('GET', `/invoices/${r.invoice_id}`);
      await sleep(PAUSE_MS);
      const { salesorder: so } = await adapter._request('GET', `/salesorders/${inv.salesorder_id}`);
      await sleep(PAUSE_MS);
      const body = correctionBody(inv, so);
      if (!Object.keys(body).length) {
        record({ ...base, result: 'already_ok', total_before: inv.total, total_after: inv.total, so_total: so.total });
        progress.done[r.invoice_id] = 'already_ok';
        fs.writeFileSync(PROGRESS, JSON.stringify(progress));
        continue;
      }
      const linesBefore = (inv.line_items || []).map(lineKey).sort();

      // Zoho asks for a reason when a sent invoice is edited; it shows in the invoice's history.
      const reason = `Corrected to match Sales Order ${so.salesorder_number}: ${Object.keys(body).join(', ')} (GetMeds Hub invoicing fix, Nov 28 2026)`;
      await adapter._request('PUT', `/invoices/${r.invoice_id}`, { body: { ...body, reason } });
      await sleep(PAUSE_MS);

      const { invoice: after } = await adapter._request('GET', `/invoices/${r.invoice_id}`);
      await sleep(PAUSE_MS);
      const linesAfter = (after.line_items || []).map(lineKey).sort();
      const linesSame = JSON.stringify(linesBefore) === JSON.stringify(linesAfter);
      const termsOk = String(after.payment_terms_label || '') === String(so.payment_terms_label || '') && Number(after.payment_terms || 0) === Number(so.payment_terms || 0);
      const totalOk = Math.abs(Number(after.total) - Number(so.total)) <= 0.5;
      const result = !linesSame ? 'LINES_CHANGED' : (termsOk && totalOk ? 'fixed' : (termsOk ? 'fixed_terms_total_differs' : 'terms_not_applied'));
      record({
        ...base, result, changed: Object.keys(body).join(' '),
        terms_before: `${inv.payment_terms_label} (${inv.payment_terms}d)`, terms_after: `${after.payment_terms_label} (${after.payment_terms}d)`,
        total_before: inv.total, total_after: after.total, so_total: so.total, balance_after: after.balance,
        note: linesSame ? '' : `before ${linesBefore.join(' | ')} after ${linesAfter.join(' | ')}`
      });
      tally[result] = (tally[result] || 0) + 1;
      progress.done[r.invoice_id] = result;
      fs.writeFileSync(PROGRESS, JSON.stringify(progress));
      console.log(`${r.invoice}: ${result} (${Object.keys(body).join(', ')}) total ${inv.total} -> ${after.total} [SO ${so.total}]`);
      if (!linesSame) { console.error('Invoice lines changed — stopping. Check this invoice in Zoho.'); break; }
      // Groups A and C were chosen because their total is already right: it must not move.
      if (r.action !== 'fix_terms_and_amount' && Math.abs(Number(after.total) - Number(inv.total)) > 0.005) {
        console.error('Total changed on an invoice that should keep its total — stopping. Check this invoice in Zoho.');
        break;
      }
      errorsInRow = 0;
    } catch (err) {
      record({ ...base, result: 'error', note: err.message });
      tally.error = (tally.error || 0) + 1;
      console.error(`${r.invoice}: ERROR ${err.message}`);
      if (err.isRateLimit) { console.error('Zoho rate limit — stopping.'); break; }
      if (++errorsInRow >= 3) { console.error('3 errors in a row — stopping.'); break; }
    }
  }
  console.log('\nDone:', tally, `\nResults: ${RESULTS}`);
}

(async () => {
  const adapter = zoho.getZohoAdapter();
  if (adapter.mode !== 'live') throw new Error(`Zoho adapter is in "${adapter.mode}" mode — pass --env .env.live.local`);
  if (APPLY) return applyPlan(adapter);

  const rows = (await hubInvoices()).slice(0, LIMIT);
  console.log(`${rows.length} Hub-created invoices to check (${rows.length * 2} Zoho reads, ~${Math.ceil(rows.length * 2 * PAUSE_MS / 60000)} min)`);
  const out = [];
  let errorsInRow = 0;
  for (const [i, r] of rows.entries()) {
    try {
      let invoiceId = r.invoice_id;
      if (!invoiceId) {
        const found = await adapter._request('GET', '/invoices', { query: { invoice_number: r.inv_no } });
        invoiceId = (found.invoices || []).find((x) => x.invoice_number === r.inv_no)?.invoice_id;
        await sleep(PAUSE_MS);
        if (!invoiceId) throw new Error(`invoice ${r.inv_no} not found in Zoho`);
      }
      const { invoice: inv } = await adapter._request('GET', `/invoices/${invoiceId}`);
      await sleep(PAUSE_MS);
      const { salesorder: so } = await adapter._request('GET', `/salesorders/${inv.salesorder_id}`);
      await sleep(PAUSE_MS);
      const diffs = compare(inv, so);
      const action = decide(inv, so, diffs);
      out.push({
        invoice: inv.invoice_number, invoice_id: inv.invoice_id, so: so.salesorder_number, order: r.getmeds_order_id,
        customer: inv.customer_name, status: inv.status, action, problems: diffs.join(' '),
        so_terms: `${so.payment_terms_label} (${so.payment_terms}d)`, inv_terms: `${inv.payment_terms_label} (${inv.payment_terms}d)`,
        so_vat_inclusive: so.is_inclusive_tax, inv_vat_inclusive: inv.is_inclusive_tax,
        so_total: so.total, inv_total: inv.total, over_billed: (Number(inv.total) - Number(so.total)).toFixed(2),
        paid: inv.payment_made, balance: inv.balance
      });
      errorsInRow = 0;
    } catch (err) {
      out.push({ invoice: r.inv_no, order: r.getmeds_order_id, action: 'error', problems: err.message });
      if (err.isRateLimit) { console.error('Zoho rate limit — stopping.'); break; }
      if (++errorsInRow >= 3) { console.error('3 errors in a row — stopping.'); break; }
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${rows.length}`);
  }

  const cols = ['invoice', 'so', 'order', 'customer', 'status', 'action', 'problems', 'so_terms', 'inv_terms', 'so_vat_inclusive', 'inv_vat_inclusive', 'so_total', 'inv_total', 'over_billed', 'paid', 'balance', 'invoice_id'];
  fs.writeFileSync(OUT, [cols.join(','), ...out.map((o) => cols.map((c) => csv(o[c])).join(','))].join('\r\n'));

  const count = {};
  for (const o of out) count[o.action] = (count[o.action] || 0) + 1;
  console.log('\nPlan:', count);
  const over = out.filter((o) => Number(o.over_billed) > 0.5);
  console.log(`Invoices above their SO total: ${over.length}, by PHP ${over.reduce((s, o) => s + Number(o.over_billed), 0).toFixed(2)}`);
  console.log(`Written: ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
