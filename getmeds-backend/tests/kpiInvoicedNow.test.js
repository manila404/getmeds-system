/**
 * Nov 13, 2026 (Aaron: "when the order is invoiced it should count as Sales"). GM-20261113-0056 was
 * invoiced at 3:16 PM but only counted at 3:30 PM, when the Zoho invoice copy (every 15 minutes)
 * caught up. An order now counts from the app's own record of a sent invoice right away; the copy
 * still rules once it has an invoice for that Sales Order, and a stale record never counts.
 */
const db = require('../src/db/database');
const { invoicedOrders } = require('../src/services/kpiService');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const ids = [];
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const client = { query: async (sql, params) => ({ rows: await db._rawQuery(sql, params) }) };

async function order(key, { eventAt = new Date().toISOString(), copy = null } = {}) {
  const c = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  const m = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  const ref = `GM-${stamp}-${key}`;
  const so = `SO-T${stamp}-${key}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, zoho_so_number, zoho_invoice_number)
     VALUES (?, ?, ?, 'tracking_shared', 'credit', 1120, 'x', ?, ?)`
  ).run(ref, c, m, so, `INV-T${stamp}-${key}`);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  ids.push({ id, so });
  await db.prepare("INSERT INTO order_events (order_id, event_type, actor_name, notes, created_at) VALUES (?, 'INVOICE_SENT', 'Dispatch', 'sent', ?)").run(id, eventAt);
  if (copy) {
    await db.prepare('INSERT INTO zoho_invoices (invoice_id, invoice_number, date, status, reference_number) VALUES (?, ?, ?, ?, ?)')
      .run(`ZI-${stamp}-${key}`, copy.number, copy.date, copy.status, so);
  }
  return ref;
}

afterAll(async () => {
  for (const { id, so } of ids) {
    await db.prepare('DELETE FROM zoho_invoices WHERE reference_number = ?').run(so);
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
});

test('an order invoiced in the app counts today, before the invoice copy has it', async () => {
  const ref = await order('now');
  const rows = await invoicedOrders(client, manilaToday(), manilaToday());
  expect(rows.map((r) => r.getmeds_order_id)).toContain(ref);
});

test('an old app record with nothing in the copy does not count (it may be stale)', async () => {
  const ref = await order('old', { eventAt: new Date(Date.now() - 3 * 86400 * 1000).toISOString() });
  const rows = await invoicedOrders(client, '2000-01-01', '2100-01-01');
  expect(rows.map((r) => r.getmeds_order_id)).not.toContain(ref);
});

test('once the copy has a void invoice for the Sales Order, it does not count', async () => {
  const ref = await order('void', { copy: { number: `GPI-T${stamp}`, date: manilaToday(), status: 'void' } });
  const rows = await invoicedOrders(client, manilaToday(), manilaToday());
  expect(rows.map((r) => r.getmeds_order_id)).not.toContain(ref);
});
