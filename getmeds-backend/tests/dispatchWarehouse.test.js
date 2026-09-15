/**
 * Sep 15, 2026 — the Dispatch page filtered by warehouse.
 *
 * Confirmed with the business: the three warehouses are sorted by the order's
 * Division (services/dispatchWarehouses.js) —
 *   Bidding CLIDP Medrep   BID, CLIDP, HOS, STC, URO, B&B, MSA
 *   RX(Patients) B2C       B2C, PS
 *   B2B Telesales PAPS     B2B, TeleSales, MD Telesales, TeleSales Anesthesia
 * and everything else is Unassigned.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { warehouseOf } = require('../src/services/dispatchWarehouses');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}

describe('Dispatch: filter by warehouse', () => {
  let token;
  let medrepId;
  let customerId;
  const created = [];
  const tag = `WH${Date.now()}`;
  const byDivision = {};

  beforeAll(async () => {
    token = await loginAs('dispatch@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    // One order per case, at a queue status and a Finance-confirmed status.
    for (const [division, status] of [
      ['BID', 'ready_for_dispatch'], ['HOS', 'ready_for_draft_invoice'], ['B2C', 'ready_for_dispatch'],
      ['B2B', 'picking_packing'], ['TeleSales', 'ready_for_draft_invoice'], [null, 'ready_for_dispatch'],
      ['Management', 'ready_for_draft_invoice']
    ]) {
      const ref = `GM-${tag}-${division || 'NONE'}`;
      await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                               delivery_address, division, zoho_so_id)
           VALUES (?, ?, ?, ?, 'credit', 100, '1 WH St', ?, ?)`
        )
        .run(ref, customerId, medrepId, status, division, `ZSO-${ref}`);
      const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
      created.push(row.id);
      byDivision[division || 'NONE'] = row.id;
    }
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const queueIds = async (warehouse) =>
    (await request(app).get('/api/dispatch/queue').query({ search: tag, warehouse, limit: 100 }).set(auth()))
      .body.data.orders.map((o) => o.id).sort();
  const recent = async (warehouse) =>
    (await request(app).get('/api/dispatch/recent').query({ warehouse }).set(auth())).body.data;
  const ids = (...divisions) => divisions.map((d) => byDivision[d]).sort();

  test('each division lands in its warehouse', () => {
    expect(warehouseOf('CLIDP').label).toBe('Bidding CLIDP Medrep');
    expect(warehouseOf('HOS').label).toBe('Bidding CLIDP Medrep');
    expect(warehouseOf('B2C').label).toBe('RX(Patients) B2C');
    expect(warehouseOf('MD Telesales').label).toBe('B2B Telesales PAPS');
    expect(warehouseOf(null).key).toBe('unassigned');
    expect(warehouseOf('Management').key).toBe('unassigned');
  });

  test('the queue filters by warehouse (queue statuses only)', async () => {
    expect(await queueIds('bidding')).toEqual(ids('BID'));
    expect(await queueIds('rx')).toEqual(ids('B2C'));
    expect(await queueIds('b2b')).toEqual(ids('B2B'));
    expect(await queueIds('unassigned')).toEqual(ids('NONE'));
    expect(await queueIds(undefined)).toEqual(ids('BID', 'B2C', 'B2B', 'NONE'));
  });

  test('"Confirmed by Finance" filters by warehouse too, and each row says which it is', async () => {
    const mine = (list) => list.filter((o) => created.includes(o.id)).map((o) => o.id).sort();
    expect(mine((await recent('bidding')).finance_confirmed)).toEqual(ids('BID', 'HOS'));
    expect(mine((await recent('b2b')).finance_confirmed)).toEqual(ids('B2B', 'TeleSales'));
    expect(mine((await recent('unassigned')).finance_confirmed)).toEqual(ids('NONE', 'Management'));
    const row = (await recent('rx')).finance_confirmed.find((o) => o.id === byDivision.B2C);
    expect(row.warehouse).toEqual({ key: 'rx', label: 'RX(Patients) B2C' });
  });
});
