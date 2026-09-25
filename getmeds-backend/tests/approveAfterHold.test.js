/**
 * Sep 25, 2026 — approving an order a SECOND time.
 *
 * GM-20260925-0042 was approved (Sales Order SO-67942 created in Zoho), put On
 * Hold, then resumed / resubmitted back to "pending Management approval" with
 * its Sales Order still attached. Each Approve click after that:
 *
 *   1. created ANOTHER Draft Sales Order in Zoho (five extras piled up), and
 *   2. failed with 'duplicate key value violates unique constraint
 *      "dispatch_records_order_id_key"', so the order never moved.
 *
 * Approving an order that already has its Sales Order has to keep that one,
 * create nothing new in Zoho, leave the existing dispatch / payment row alone,
 * and move the order on to Finance.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const created = [];
let managerToken, medrepId, customerId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function pendingOrder({ customerType, soId, withRow }) {
  const ref = `GM-REAPP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, submitted_at, zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status)
       VALUES (?, ?, ?, 'pending_management_approval', ?, 1200, '1 Re St, Cebu', ?, ?, ?, ?, ?)`
    )
    .run(ref, customerId, medrepId, customerType, new Date().toISOString(),
      soId, soId ? 'SO-EXISTING' : null, soId ? 'draft' : null, soId ? 'synced' : null);
  const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.push(row.id);
  if (withRow === 'dispatch') {
    await db.prepare("INSERT INTO dispatch_records (order_id, status, created_at) VALUES (?, 'packing', ?)").run(row.id, new Date().toISOString());
  }
  if (withRow === 'payment') {
    await db.prepare("INSERT INTO payments (order_id, status, created_at) VALUES (?, 'verified', ?)").run(row.id, new Date().toISOString());
  }
  return row.id;
}

const approve = (id) => request(app).post(`/api/orders/${id}/approve`).set(auth(managerToken)).send({});

describe('approving an order that already has a Zoho Sales Order', () => {
  let createSpy;

  beforeAll(async () => {
    managerToken = await loginAs('manager@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  beforeEach(() => {
    createSpy = jest.spyOn(zoho, 'createSalesOrder');
  });
  afterEach(() => createSpy.mockRestore());

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('a credit order: keeps its Sales Order, creates none, does not trip on its dispatch row, moves on', async () => {
    const id = await pendingOrder({ customerType: 'credit', soId: 'ZSO-KEEP-1', withRow: 'dispatch' });

    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(createSpy).not.toHaveBeenCalled();

    const order = await db.prepare('SELECT status, zoho_so_id, zoho_so_number, zoho_sync_status FROM orders WHERE id = ?').get(id);
    expect(order.status).toBe('ready_for_finance_verified');
    expect(order.zoho_so_id).toBe('ZSO-KEEP-1');
    expect(order.zoho_so_number).toBe('SO-EXISTING');
    expect(order.zoho_sync_status).toBe('synced');

    // One dispatch row, and it was not reset.
    const rows = await db.prepare('SELECT status FROM dispatch_records WHERE order_id = ?').all(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('packing');

    // The trail says what happened, rather than claiming a new SO was made.
    const hop = await db
      .prepare("SELECT notes FROM order_events WHERE order_id = ? AND new_status = 'so_created' LIMIT 1")
      .get(id);
    expect(hop.notes).toMatch(/kept/i);
    expect(hop.notes).not.toMatch(/Zoho SO created/);
  });

  test('a direct order: its existing payment row is kept, not reset or duplicated', async () => {
    const id = await pendingOrder({ customerType: 'direct', soId: 'ZSO-KEEP-2', withRow: 'payment' });
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(createSpy).not.toHaveBeenCalled();

    const rows = await db.prepare('SELECT status FROM payments WHERE order_id = ?').all(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('verified');
  });

  test('approving twice in a row does not create a second Sales Order either', async () => {
    const id = await pendingOrder({ customerType: 'credit', soId: 'ZSO-KEEP-3', withRow: 'dispatch' });
    expect((await approve(id)).status).toBe(200);
    // Back to pending, as a hold + resume does.
    await db.prepare("UPDATE orders SET status = 'pending_management_approval' WHERE id = ?").run(id);
    expect((await approve(id)).status).toBe(200);
    expect(createSpy).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dispatch_records WHERE order_id = ?').get(id)).toEqual({ n: 1 });
  });

  test('a first approval (no Sales Order yet) still creates one', async () => {
    const id = await pendingOrder({ customerType: 'credit', soId: null, withRow: null });
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const order = await db.prepare('SELECT status, zoho_so_id FROM orders WHERE id = ?').get(id);
    expect(order.status).toBe('ready_for_finance_verified');
    expect(order.zoho_so_id).toBeTruthy();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dispatch_records WHERE order_id = ?').get(id)).toEqual({ n: 1 });
  });
});
