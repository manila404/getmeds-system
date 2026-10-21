/**
 * The copy of Zoho's invoices and credit notes (Oct 21, 2026). A fake Zoho stands in for the real one.
 *
 *  - a month backfill copies every invoice and credit note, and starts the 15-minute cursor;
 *  - the 15-minute run copies only what changed since the cursor, newest first, and stops there;
 *  - the nightly range check marks invoices deleted in Zoho, and doesn't when the list was cut short;
 *  - the Overview total from the copy: invoices minus credit notes, draft/void/deleted left out,
 *    to the centavo; no answer (so the caller reads Zoho live) when the copy is stale or doesn't cover the dates.
 */
const db = require('../src/db/database');
const copy = require('../src/services/zohoInvoiceCopy');

const q = (sql, p) => db._rawQuery(sql, p);
const { KEY } = copy._test;

// A fake Zoho: lists filtered by date range, or sorted newest change first; 2 rows a page.
function fakeZoho(store) {
  const calls = [];
  return {
    calls,
    async _request(method, path, { query }) {
      expect(method).toBe('GET');
      calls.push({ path, query });
      const kind = path === '/invoices' ? 'invoices' : 'creditnotes';
      let rows = [...store[kind]];
      if (query.date_start) rows = rows.filter((r) => r.date >= query.date_start && r.date <= query.date_end);
      if (query.sort_column === 'last_modified_time') rows.sort((a, b) => b.last_modified_time.localeCompare(a.last_modified_time));
      const per = 2; const page = Number(query.page);
      return { [kind]: rows.slice((page - 1) * per, page * per), page_context: { has_more_page: rows.length > page * per } };
    },
  };
}
const inv = (id, date, total, extra = {}) => ({
  invoice_id: id, invoice_number: `INV-${id}`, date, status: 'sent', customer_name: `C${id}`, salesperson_name: 'HOS | TEST',
  reference_number: `SO-${id}`, total, balance: total, created_time: `${date}T09:00:00+0800`, last_modified_time: `${date}T09:00:00+0800`, ...extra,
});
const cn = (id, date, total) => ({ creditnote_id: id, creditnote_number: `CN-${id}`, date, status: 'open', salesperson_name: 'HOS | TEST', total, balance: 0, last_modified_time: `${date}T10:00:00+0800` });

async function clean() {
  await q("DELETE FROM zoho_invoices WHERE invoice_id LIKE 'T%'");
  await q("DELETE FROM zoho_credit_notes WHERE creditnote_id LIKE 'T%'");
  await q("DELETE FROM sync_state WHERE key LIKE 'zoho_invoice_copy:%'");
}
beforeEach(clean);
afterAll(clean);

test('a month backfill copies everything dated in it, and starts the cursor', async () => {
  const store = {
    invoices: [inv('T1', '2026-09-02', 1000.1), inv('T2', '2026-09-15', 2000.2), inv('T3', '2026-09-30', 300), inv('T4', '2026-10-01', 999)],
    creditnotes: [cn('T9', '2026-09-20', 100.05)],
  };
  const out = await copy.backfillMonth('2026-09', { adapter: fakeZoho(store) });
  expect(out.invoices).toMatchObject({ copied: 3, truncated: false });
  expect(out.creditnotes.copied).toBe(1);
  const st = await copy.status();
  expect(st.coveredFrom).toBe('2026-09-01');
  expect(st.cursors.invoices).toBeTruthy();
  const rows = await q("SELECT invoice_id, total FROM zoho_invoices WHERE invoice_id LIKE 'T%' ORDER BY invoice_id");
  expect(rows.map((r) => [r.invoice_id, Number(r.total)])).toEqual([['T1', 1000.1], ['T2', 2000.2], ['T3', 300]]);
});

test('the 15-minute run copies only what changed since the cursor, and stops there', async () => {
  const store = {
    invoices: [inv('T1', '2026-09-02', 100), inv('T2', '2026-09-03', 200), inv('T3', '2026-09-04', 300)],
    creditnotes: [],
  };
  await q("INSERT INTO sync_state (key, value) VALUES ($1, $2), ($3, $4)",
    [KEY.cursor('invoices'), '2026-10-20T00:00:00.000Z', KEY.cursor('creditnotes'), '2026-10-20T00:00:00.000Z']);
  // T2 was paid today: modified after the cursor. T5 is new. T1 and T3 are old.
  store.invoices[1] = { ...store.invoices[1], balance: 0, status: 'paid', last_modified_time: '2026-10-21T08:00:00+0800' };
  store.invoices.push(inv('T5', '2026-10-21', 500, { last_modified_time: '2026-10-21T09:00:00+0800' }));
  const z = fakeZoho(store);
  const out = await copy.runRecent({ adapter: z });
  expect(out.invoices.copied).toBe(2);
  // 2 rows a page: page 1 is the two new changes, page 2 reaches the old rows and the run stops there
  expect(z.calls.filter((c) => c.path === '/invoices')).toHaveLength(2);
  const rows = await q("SELECT invoice_id, status, balance FROM zoho_invoices WHERE invoice_id LIKE 'T%' ORDER BY invoice_id");
  expect(rows.map((r) => r.invoice_id)).toEqual(['T2', 'T5']);
  expect(rows[0]).toMatchObject({ status: 'paid' });
  expect(Date.parse((await copy.status()).cursors.invoices)).toBe(Date.parse('2026-10-21T01:00:00.000Z'));
});

test('the nightly check marks invoices deleted in Zoho, and keeps them out of the totals', async () => {
  const store = { invoices: [inv('T1', '2026-09-02', 100), inv('T2', '2026-09-03', 200), inv('T3', '2026-09-04', 300)], creditnotes: [] };
  await copy.backfillMonth('2026-09', { adapter: fakeZoho(store) });
  store.invoices = store.invoices.filter((i) => i.invoice_id !== 'T2'); // deleted in Zoho
  const r = await copy.syncRange('invoices', '2026-09-01', '2026-09-30', { adapter: fakeZoho(store) });
  expect(r.markedDeleted).toBe(1);
  const sales = await copy.readSales('2026-09-01', '2026-09-30');
  expect(sales.invoice_count).toBe(2);
  expect(sales.total_sales_with_tax).toBe(400);
});

test('totals from the copy: invoices minus credit notes, draft and void left out, to the centavo', async () => {
  const store = {
    invoices: [inv('T1', '2026-09-02', 1000.1), inv('T2', '2026-09-03', 0.2), inv('T3', '2026-09-04', 50, { status: 'draft' }), inv('T4', '2026-09-05', 70, { status: 'void' })],
    creditnotes: [cn('T9', '2026-09-10', 0.1)],
  };
  await copy.backfillMonth('2026-09', { adapter: fakeZoho(store) });
  const s = await copy.readSales('2026-09-01', '2026-09-30');
  expect(s).toMatchObject({ source: 'copy', invoice_count: 2, invoice_total: 1000.3, credit_note_total: 0.1, total_sales_with_tax: 1000.2, balance_due: 1000.3 });
  expect(s.by_salesperson[0]).toMatchObject({ name: 'HOS | TEST', invoices: 2, total: 1000.2 });
});

test('no answer when the copy does not cover the dates or is stale, so the Overview reads Zoho live', async () => {
  await copy.backfillMonth('2026-09', { adapter: fakeZoho({ invoices: [], creditnotes: [] }) });
  expect(await copy.readSales('2026-08-01', '2026-08-31')).toBeNull();
  expect(await copy.readSales('2026-09-01', '2026-09-30', { now: Date.now() + 2 * 3600 * 1000 })).toBeNull();
  expect(await copy.readSales('2026-09-01', '2026-09-30')).not.toBeNull();
});

test('a list cut short by the page cap marks nothing deleted', async () => {
  const many = Array.from({ length: 70 }, (_, i) => inv(`T${100 + i}`, '2026-09-10', 1));
  const r = await copy.syncRange('invoices', '2026-09-01', '2026-09-30', { adapter: fakeZoho({ invoices: many, creditnotes: [] }) });
  expect(r.truncated).toBe(true); // 30 pages x 2 rows < 70
  expect(r.markedDeleted).toBe(0);
});
