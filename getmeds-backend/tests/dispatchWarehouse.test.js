/**
 * Sep 15, 2026 — the Dispatch page filtered by warehouse.
 *
 * Confirmed with the business (services/dispatchWarehouses.js):
 *   BID, CLIDP, B2B, B2C       their own division
 *   RX                         B&B, STC, HOS, MSA, URO
 *   Anesthesia Telesales       TeleSales Anesthesia
 *   MD Telesales               MD Telesales and plain TeleSales
 *   PAP                        Source PCSO / IAPF / DSWD / Office of the
 *                              President — whatever the division, and ONLY there
 *   Unassigned                 everything else (no division, PS, Management)
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
  const ids = {};

  beforeAll(async () => {
    token = await loginAs('dispatch@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    // [name, division, source, status]. ready_for_dispatch / picking_packing are
    // queue statuses; ready_for_draft_invoice shows only under Confirmed by Finance.
    const cases = [
      ['BID', 'BID', null, 'ready_for_dispatch'],
      ['CLIDP', 'CLIDP', null, 'ready_for_dispatch'],
      ['STC', 'STC', null, 'ready_for_dispatch'],
      ['HOS', 'HOS', null, 'ready_for_draft_invoice'],
      ['B2B', 'B2B', null, 'picking_packing'],
      ['ANES', 'TeleSales Anesthesia', null, 'ready_for_draft_invoice'],
      ['TELESALES', 'TeleSales', null, 'ready_for_dispatch'],
      ['B2C', 'B2C', null, 'ready_for_dispatch'],
      ['PAP', 'B2B', 'DSWD', 'ready_for_dispatch'],
      ['NONE', null, null, 'ready_for_dispatch'],
      ['PS', 'PS', null, 'ready_for_dispatch'],
      ['MGMT', 'Management', null, 'ready_for_draft_invoice']
    ];
    for (const [name, division, source, status] of cases) {
      const ref = `GM-${tag}-${name}`;
      await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                               delivery_address, division, intake_source, zoho_so_id)
           VALUES (?, ?, ?, ?, 'credit', 100, '1 WH St', ?, ?, ?)`
        )
        .run(ref, customerId, medrepId, status, division, source, `ZSO-${ref}`);
      const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
      created.push(row.id);
      ids[name] = row.id;
    }
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const queueIds = async (warehouse) =>
    (await request(app).get('/api/dispatch/queue').query({ search: tag, warehouse, limit: 100 }).set(auth()))
      .body.data.orders.map((o) => o.id).sort();
  const confirmedIds = async (warehouse) =>
    (await request(app).get('/api/dispatch/recent').query({ warehouse }).set(auth()))
      .body.data.finance_confirmed.filter((o) => created.includes(o.id)).map((o) => o.id).sort();
  const of = (...names) => names.map((n) => ids[n]).sort();

  test('each order lands in exactly one warehouse', () => {
    expect(warehouseOf('HOS').label).toBe('RX');
    expect(warehouseOf('B&B').label).toBe('RX');
    expect(warehouseOf('TeleSales Anesthesia').label).toBe('Anesthesia Telesales');
    expect(warehouseOf('TeleSales').label).toBe('MD Telesales');
    expect(warehouseOf('B2B', 'DSWD').label).toBe('PAP');
    expect(warehouseOf('B2B', 'Distributor order').label).toBe('B2B');
    expect(warehouseOf('PS').key).toBe('unassigned');
    expect(warehouseOf(null).key).toBe('unassigned');
  });

  test('the queue filters by warehouse', async () => {
    expect(await queueIds('bid')).toEqual(of('BID'));
    expect(await queueIds('clidp')).toEqual(of('CLIDP'));
    expect(await queueIds('rx')).toEqual(of('STC'));
    expect(await queueIds('b2b')).toEqual(of('B2B')); // not the B2B order whose Source is DSWD
    expect(await queueIds('md_telesales')).toEqual(of('TELESALES'));
    expect(await queueIds('b2c')).toEqual(of('B2C'));
    expect(await queueIds('pap')).toEqual(of('PAP'));
    expect(await queueIds('unassigned')).toEqual(of('NONE', 'PS'));
  });

  test('"Confirmed by Finance" filters too, and each row says which warehouse', async () => {
    expect(await confirmedIds('rx')).toEqual(of('STC', 'HOS'));
    expect(await confirmedIds('anesthesia')).toEqual(of('ANES'));
    expect(await confirmedIds('unassigned')).toEqual(of('NONE', 'PS', 'MGMT'));
    const row = (await request(app).get('/api/dispatch/recent').query({ warehouse: 'pap' }).set(auth()))
      .body.data.finance_confirmed.find((o) => o.id === ids.PAP);
    expect(row.warehouse).toEqual({ key: 'pap', label: 'PAP' });
  });
});
