#!/usr/bin/env node
'use strict';

/**
 * First load of the Zoho invoice copy, month by month (Oct 21, 2026). See services/zohoInvoiceCopy.js.
 *
 *   node scripts/zoho-invoice-copy-backfill.js 2026-01 2026-10            local database only
 *   node scripts/zoho-invoice-copy-backfill.js 2026-01 2026-10 --live     the database in .env (live)
 *   ... --verify     afterwards, compare each month's totals with a live read from Zoho
 *
 * Reads Zoho only (GET). Writes only the zoho_invoices / zoho_credit_notes tables and the
 * zoho_invoice_copy:* rows of sync_state. Without --live it refuses any database except a
 * local one. Run the live load at a quiet hour.
 */

require('dotenv').config();

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const VERIFY = args.includes('--verify');
const [fromMonth, toMonth = fromMonth] = args.filter((a) => /^\d{4}-\d{2}$/.test(a));

const url = process.env.DATABASE_URL || '';
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (!fromMonth) { console.error('Usage: node scripts/zoho-invoice-copy-backfill.js 2026-01 2026-10 [--live] [--verify]'); process.exit(1); }
if (!local && !LIVE) { console.error('DATABASE_URL is not a local database. Add --live to load the live copy (quiet hour).'); process.exit(1); }

const copy = require('../src/services/zohoInvoiceCopy');
const { readZohoSales } = require('../src/controllers/adminOverview.controller');

const months = [];
for (let m = fromMonth; m <= toMonth;) {
  months.push(m);
  const [y, mm] = m.split('-').map(Number);
  m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
}
const monthEnd = (m) => { const [y, mm] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, '0')}`; };

(async () => {
  console.log(`Database: ${local ? 'local' : 'LIVE'} · months ${months[0]} to ${months[months.length - 1]}`);
  let calls = 0;
  for (const m of months) {
    const t = Date.now();
    const r = await copy.backfillMonth(m);
    calls += r.invoices.calls + r.creditnotes.calls;
    console.log(`${m}: ${r.invoices.copied} invoices, ${r.creditnotes.copied} credit notes, ${r.invoices.calls + r.creditnotes.calls} Zoho calls, ${((Date.now() - t) / 1000).toFixed(1)} s${r.invoices.truncated ? '  (CUT SHORT: more than the page cap)' : ''}`);
  }
  const t2 = Date.now();
  const open = await copy.syncOpen();
  calls += open.calls;
  console.log(`Unpaid invoices (any date, for DSO): ${open.copied} copied, ${open.settled} set to paid, ${open.calls} Zoho calls, ${((Date.now() - t2) / 1000).toFixed(1)} s${open.truncated ? '  (CUT SHORT)' : ''}`);
  console.log(`Total Zoho calls: ${calls}`);

  if (VERIFY) {
    const saved = process.env.ZOHO_INVOICE_COPY_READ;
    for (const m of months) {
      process.env.ZOHO_INVOICE_COPY_READ = 'true';
      const a = await copy.readSales(`${m}-01`, monthEnd(m));
      process.env.ZOHO_INVOICE_COPY_READ = 'false';
      const b = await readZohoSales(`${m}-01`, monthEnd(m), { fresh: true });
      const same = a && b.available && a.total_sales_with_tax === b.total_sales_with_tax && a.balance_due === b.balance_due
        && a.invoice_count === b.invoice_count && a.credit_note_count === b.credit_note_count;
      console.log(`${m} copy ${a ? a.total_sales_with_tax.toFixed(2) : '—'} (${a ? a.invoice_count : 0} inv) · Zoho ${b.available ? b.total_sales_with_tax.toFixed(2) : b.error} (${b.invoice_count || 0} inv) · balance ${a ? a.balance_due.toFixed(2) : '—'} vs ${b.available ? b.balance_due.toFixed(2) : '—'}  ${same ? 'MATCH' : 'DIFFERENT'}`);
    }
    process.env.ZOHO_INVOICE_COPY_READ = saved;
  }
  console.log('Status:', JSON.stringify(await copy.status()));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
