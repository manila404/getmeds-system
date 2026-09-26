/**
 * Sep 26, 2026 — Pharmacy: the "All orders" tab and the channel pills.
 *
 * "All orders" lists every native (GM-) order of the six pharmacy channels from
 * Sep 12, 2026, whether or not a prescription is attached, so the pharmacist can
 * inspect the items and notes. The channel pills narrow every tab.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const created = [];
let dispatchToken, medrepToken, medrepId, customerId;
const stamp = Date.now();

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let seq = 0;
async function order({ division, status = 'ready_for_finance_verified', prefix = 'GM', createdAt = '2026-09-20T02:00:00.000Z', rx = false }) {
  seq += 1;
  const ref = `${prefix}-PHALL-${stamp}-${seq}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address,
                           division, created_at, zoho_so_id, zoho_so_number)
       VALUES (?, ?, ?, ?, 'credit', 500, '1 Ph St', ?, ?, ?, 'SO-PH')`
    )
    .run(ref, customerId, medrepId, status, division, createdAt, `ZSO-PHALL-${stamp}-${seq}`);
  const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  if (rx) {
    await db
      .prepare(
        `INSERT INTO payment_proofs (order_id, file_type, status, storage_path, file_name, content_type, uploaded_by, uploaded_at)
         VALUES (?, 'prescription', 'pending', ?, 'rx.jpg', 'image/jpeg', ?, ?)`
      )
      .run(row.id, `orders/${row.id}/prescription/rx.jpg`, medrepId, new Date().toISOString());
  }
  return row.id;
}

const get = async (query, token = dispatchToken) => (await request(app).get(`/api/dispatch/pharmacy/queue?${query}`).set(auth(token))).body.data;
const ids = (d) => d.orders.map((o) => o.id);

describe('pharmacy: All orders and channel pills', () => {
  let hos, hosRx, telesales, md, urouOld, b2b, imported, noDivision, draft, tooOld;

  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;

    hos = await order({ division: 'HOS' });
    hosRx = await order({ division: 'HOS', rx: true });
    telesales = await order({ division: 'TeleSales Anesthesia', status: 'completed' });
    md = await order({ division: 'MD Telesales' });
    urouOld = await order({ division: 'URO', createdAt: '2026-09-11T15:59:00.000Z' });
    tooOld = urouOld;
    b2b = await order({ division: 'B2B' });
    imported = await order({ division: 'HOS', prefix: 'ZOHO' });
    noDivision = await order({ division: null });
    draft = await order({ division: 'STC', status: 'draft' });
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM payment_proofs WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('lists native orders of the six channels, with or without a prescription', async () => {
    const d = await get('state=all_orders');
    const got = ids(d);
    for (const id of [hos, hosRx, telesales, md]) expect(got).toContain(id);
    expect(d.orders.find((o) => o.id === hos).rx_state).toBe('none');
    expect(d.orders.find((o) => o.id === hosRx).rx_state).toBe('pending');
  });

  test('leaves out other channels, imports, orders with no division, drafts and anything before Sep 12', async () => {
    const got = ids(await get('state=all_orders'));
    for (const id of [b2b, imported, noDivision, draft, tooOld]) expect(got).not.toContain(id);
  });

  test('the channel pill narrows the list: Telesales, B2C (which carries MD Telesales), HOS', async () => {
    const tele = ids(await get('state=all_orders&channel=Telesales'));
    expect(tele).toContain(telesales);
    expect(tele).not.toContain(hos);
    expect(tele).not.toContain(md);

    const b2c = ids(await get('state=all_orders&channel=B2C'));
    expect(b2c).toContain(md);
    expect(b2c).not.toContain(telesales);

    const h = ids(await get('state=all_orders&channel=hos'));
    expect(h).toEqual(expect.arrayContaining([hos, hosRx]));
    expect(h).not.toContain(md);
  });

  test('an unknown channel is ignored rather than trusted', async () => {
    const d = await get("state=all_orders&channel=HOS'%20OR%201=1");
    expect(d.channel).toBeNull();
    expect(ids(d)).not.toContain(b2b);
  });

  test('the prescription tabs keep working, and the pill narrows them too', async () => {
    const pending = await get('state=pending');
    expect(ids(pending)).toContain(hosRx);
    expect(ids(pending)).not.toContain(hos);
    expect((await get('state=pending&channel=Telesales')).orders.map((o) => o.id)).not.toContain(hosRx);
    expect(pending.counts.all_orders).toBeGreaterThanOrEqual(4);
    expect(pending.channels).toEqual(['HOS', 'Telesales', 'B&B', 'STC', 'URO', 'B2C']);
  });

  test('an order outside approval-to-packing is listed but cannot be decided on', async () => {
    const d = await get('state=all_orders');
    expect(d.orders.find((o) => o.id === telesales).reviewable).toBe(false);
    expect(d.orders.find((o) => o.id === hosRx).reviewable).toBe(true);
  });

  test('Management can look, the MedRep cannot', async () => {
    const res = await request(app).get('/api/dispatch/pharmacy/queue?state=all_orders').set(auth(medrepToken));
    expect(res.status).toBe(403);
  });
});
