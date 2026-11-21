/**
 * Sep 15, 2026 — "Today" on the Dispatch page.
 *
 * Confirmed with the business: it applies to the two Recent lists, so
 * Dispatch sees all of today's orders to fulfill —
 *   New draft SOs          every draft SO created today
 *   Confirmed by Finance   every order Finance confirmed today, not shipped
 * in Philippine time, and not capped at 20.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}

describe('Dispatch: Today', () => {
  let token;
  let medrepId;
  let customerId;
  const created = [];
  const now = new Date();
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
  const TWO_DAYS_AGO = hoursAgo(48);
  const JUST_NOW = hoursAgo(0);

  beforeAll(async () => {
    token = await loginAs('dispatch@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  async function orderAt(status, createdAt, { financeConfirmedAt = null } = {}) {
    const ref = `GM-TODAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                             delivery_address, zoho_so_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'credit', 100, '1 Today St', ?, ?, ?)`
      )
      .run(ref, customerId, medrepId, status, `ZSO-${ref}`, createdAt, createdAt);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(id);
    if (financeConfirmedAt) {
      await db
        .prepare(
          `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, created_at)
           VALUES (?, 'FINANCE_VERIFIED', 'ready_for_finance_verified', 'ready_for_draft_invoice', 'Finance', ?)`
        )
        .run(id, financeConfirmedAt);
    }
    return id;
  }

  const recent = async (period) =>
    (await request(app).get('/api/dispatch/recent').query({ period }).set({ Authorization: `Bearer ${token}` })).body.data;

  test("today's draft SOs, and not older ones", async () => {
    const todays = await orderAt('ready_for_finance_verified', JUST_NOW);
    const older = await orderAt('ready_for_finance_verified', TWO_DAYS_AGO);
    const ids = (await recent('today')).new_draft_sos.map((o) => o.id);
    expect(ids).toContain(todays);
    expect(ids).not.toContain(older);
  });

  test('orders Finance confirmed today — even one raised days ago — and not ones confirmed before', async () => {
    const raisedEarlierConfirmedToday = await orderAt('ready_for_draft_invoice', TWO_DAYS_AGO, { financeConfirmedAt: JUST_NOW });
    const confirmedBefore = await orderAt('ready_for_dispatch', TWO_DAYS_AGO, { financeConfirmedAt: TWO_DAYS_AGO });
    const ids = (await recent('today')).finance_confirmed.map((o) => o.id);
    expect(ids).toContain(raisedEarlierConfirmedToday);
    expect(ids).not.toContain(confirmedBefore);

    // "Any time" still shows both.
    const all = (await recent(undefined)).finance_confirmed.map((o) => o.id);
    expect(all).toEqual(expect.arrayContaining([raisedEarlierConfirmedToday, confirmedBefore]));
  });

  test('today is not capped at 20', async () => {
    const ids = [];
    for (let i = 0; i < 22; i++) ids.push(await orderAt('ready_for_draft_invoice', JUST_NOW, { financeConfirmedAt: JUST_NOW }));
    const got = (await recent('today')).finance_confirmed.map((o) => o.id);
    expect(ids.every((id) => got.includes(id))).toBe(true);
  });

  test('any-time view is not capped at 20 either, so older active orders do not vanish', async () => {
    const olderId = await orderAt('ready_for_draft_invoice', hoursAgo(72), { financeConfirmedAt: hoursAgo(72) });
    const newerIds = [];
    for (let i = 0; i < 21; i++) newerIds.push(await orderAt('ready_for_draft_invoice', JUST_NOW, { financeConfirmedAt: JUST_NOW }));
    const got = (await recent(undefined)).finance_confirmed.map((o) => o.id);
    expect(got).toContain(olderId);
    expect(newerIds.every((id) => got.includes(id))).toBe(true);
  });

  test('fulfilled/shipped orders without Confirm-for-delivery stay visible in Confirmed Orders and Dispatch History', async () => {
    const shippedId = await orderAt('tracking_shared', JUST_NOW, { financeConfirmedAt: hoursAgo(2) });
    await db
      .prepare("INSERT INTO dispatch_records (order_id, status, courier, tracking_number, zoho_shipment_id, zoho_shipment_number, dispatched_at) VALUES (?, 'dispatched', 'LBC Express', 'LBC-GHOST-1', 'ZSHP-G1', 'SH-G1', ?)")
      .run(shippedId, JUST_NOW);

    try {
      const board = await recent(undefined);
      const row = board.confirmed_orders.find((o) => o.id === shippedId);
      expect(row).toBeTruthy();
      expect(row.tracking_number).toBe('LBC-GHOST-1');
      expect(row.dispatch_courier).toBe('LBC Express');

      const hist = await request(app)
        .get('/api/orders')
        .query({ dispatch_history: 'true', search: 'LBC-GHOST-1' })
        .set({ Authorization: `Bearer ${token}` });
      expect(hist.status).toBe(200);
      expect(hist.body.data.orders.map((o) => o.id)).toEqual([]); // search doesn't match tracking_number column, match order id:

      const orderRow = await db.prepare('SELECT getmeds_order_id FROM orders WHERE id = ?').get(shippedId);
      const histByOrder = await request(app)
        .get('/api/orders')
        .query({ dispatch_history: 'true', search: orderRow.getmeds_order_id })
        .set({ Authorization: `Bearer ${token}` });
      expect(histByOrder.status).toBe(200);
      expect(histByOrder.body.data.orders.map((o) => o.id)).toContain(shippedId);
    } finally {
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(shippedId);
    }
  });

  test('entered_tracking pre-fills Fulfill batches response, and zoho-tracking syncs Zoho shipment', async () => {
    const zoho = require('../src/integrations/zoho');
    const orderId = await orderAt('dispatched', JUST_NOW, { financeConfirmedAt: hoursAgo(1) });
    await db
      .prepare("INSERT INTO dispatch_records (order_id, status, courier, zoho_shipment_id, zoho_shipment_number) VALUES (?, 'dispatched', 'Lalamove', 'ZSHP-PATIENT-1', 'SH-PT-1')")
      .run(orderId);

    const spy = jest.spyOn(zoho, 'updateShipmentTracking').mockResolvedValue({
      code: 0,
      shipmentorder: { shipment_id: 'ZSHP-PATIENT-1', shipment_number: 'SH-PT-1', tracking_number: 'TRK-PT-999' }
    });

    const prevDrFlag = process.env.GETMEDS_DR_WORKFLOW;
    process.env.GETMEDS_DR_WORKFLOW = 'true';
    try {
      // Pre-existing DISPATCH_TRACKING_ADDED event -> pre-fills entered_tracking on GET /batches
      await db
        .prepare(
          `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, metadata)
           VALUES (?, 'DISPATCH_TRACKING_ADDED', 'dispatched', 'dispatched', 'Dispatch', ?)`
        )
        .run(orderId, JSON.stringify({ courier: 'Lalamove', tracking_number: 'PRE-123' }));

      const batchesRes = await request(app)
        .get(`/api/dispatch/orders/${orderId}/batches`)
        .set({ Authorization: `Bearer ${token}` });
      expect(batchesRes.status).toBe(200);
      expect(batchesRes.body.data.order.entered_tracking).toEqual(
        expect.objectContaining({ courier: 'Lalamove', tracking_number: 'PRE-123' })
      );

      // Direct Zoho tracking update endpoint pushes to Zoho and updates order status to tracking_shared
      const syncRes = await request(app)
        .post(`/api/dispatch/orders/${orderId}/zoho-tracking`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ delivery_method: 'LBC Express', tracking_number: 'TRK-PT-999' });
      expect(syncRes.status).toBe(200);
      expect(syncRes.body.data.status).toBe('tracking_shared');
      expect(syncRes.body.data.tracking_number).toBe('TRK-PT-999');
      expect(spy).toHaveBeenCalledWith('ZSHP-PATIENT-1', expect.objectContaining({
        deliveryMethod: 'LBC Express',
        trackingNumber: 'TRK-PT-999'
      }));
      const dr = await db.prepare('SELECT tracking_number, courier FROM dispatch_records WHERE order_id = ?').get(orderId);
      expect(dr).toEqual({ tracking_number: 'TRK-PT-999', courier: 'LBC Express' });

      // Verify order detail carries customer compliance + salesperson fields for in-Hub Sales Order printing
      const orderDetailRes = await request(app).get(`/api/orders/${orderId}`).set({ Authorization: `Bearer ${token}` });
      expect(orderDetailRes.status).toBe(200);
      expect(orderDetailRes.body.data.order).toHaveProperty('tin');
      expect(orderDetailRes.body.data.order).toHaveProperty('lto_license_number');
      expect(orderDetailRes.body.data.order).toHaveProperty('salesperson_name');
    } finally {
      if (prevDrFlag === undefined) delete process.env.GETMEDS_DR_WORKFLOW;
      else process.env.GETMEDS_DR_WORKFLOW = prevDrFlag;
      spy.mockRestore();
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(orderId);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(orderId);
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(orderId);
    }
  });
});
