/**
 * Sync from Zoho must not copy vendor-only contacts in as customers.
 * Oct 2, 2026 (order GM-20261001-0044): Zoho refuses a Sales Order for a vendor.
 */
const db = require('../src/db/database');
const { __test__ } = require('../src/controllers/customers.controller');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ids = [`SYNC-CUST-${stamp}`, `SYNC-VEND-${stamp}`, `SYNC-UNTYPED-${stamp}`];

afterAll(async () => {
  for (const id of ids) await db.prepare('DELETE FROM customers WHERE zoho_contact_id = ?').run(id);
});

test('vendors are not added; customers and untyped contacts are', async () => {
  const result = await __test__.reconcileContacts([
    { contact_id: ids[0], contact_name: `Sync Customer ${stamp}`, contact_type: 'customer', status: 'active' },
    { contact_id: ids[1], contact_name: `Sync Vendor ${stamp}`, contact_type: 'vendor', status: 'active' },
    { contact_id: ids[2], contact_name: `Sync Untyped ${stamp}`, status: 'active' },
  ]);
  expect(result.created).toBe(2);
  expect(result.vendorsSkipped).toBe(1);
  const rows = await db.prepare('SELECT zoho_contact_id FROM customers WHERE zoho_contact_id = ANY(?)').all([ids]);
  expect(rows.map((r) => r.zoho_contact_id).sort()).toEqual([ids[0], ids[2]].sort());
});
