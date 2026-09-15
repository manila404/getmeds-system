/**
 * Sep 15, 2026 — resubmitting an order Management sent back.
 *
 * GM-20260915-0023: Management (Veronica) sent it back ("Change source"). The
 * rep who RAISED it for a colleague could not resubmit — the order page only
 * offered Submit to the order's own MedRep, though the server always allowed
 * the raiser. And a resubmission reached Management as an ordinary "needs
 * your approval", with nothing saying it had been sent back or why.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('resubmitting an order Management sent back', () => {
  let raiserToken;
  let raiserId;
  let colleagueId;
  let managementToken;
  let managementId;
  let customerId;
  const created = [];
  const createdUsers = [];

  beforeAll(async () => {
    raiserToken = await loginAs('medrep@getmeds.ph');
    raiserId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    // A colleague the order is for, and a Management user — made the way
    // workflowV2.test.js makes its manager, reusing the seeded rep's hash.
    const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    const stamp = Date.now();
    for (const [name, role] of [['Colleague Rep', 'medrep'], ['Veronica Manager', 'management']]) {
      const email = `sentback-${role}-${stamp}@getmeds.ph`;
      await db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, seed.password_hash, role);
      const { id } = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      createdUsers.push(id);
      if (role === 'medrep') colleagueId = id;
      else {
        managementId = id;
        managementToken = await loginAs(email);
      }
    }
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    for (const id of createdUsers) {
      await db.prepare('DELETE FROM order_events WHERE actor_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE recipient_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  });

  /** Raised by the seeded rep FOR a colleague, waiting for Management. */
  async function pendingOrder() {
    const ref = `GM-SENTBACK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type,
                             total_amount, delivery_address, intake_source)
         VALUES (?, ?, ?, ?, 'pending_management_approval', 'direct', 1800, '1 Sent Back St', 'Patient order referred by doctor')`
      )
      .run(ref, customerId, colleagueId, raiserId);
    const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
    created.push(row.id);
    return row;
  }

  const sendBack = (id, reason) => request(app).post(`/api/orders/${id}/send-back`).set(auth(managementToken)).send({ reason });
  const submit = (id, token) => request(app).post(`/api/orders/${id}/submit`).set(auth(token));

  test('the order page says who sent it back and why', async () => {
    const order = await pendingOrder();
    expect((await sendBack(order.id, 'Change source')).status).toBe(200);
    const page = await request(app).get(`/api/orders/${order.id}`).set(auth(raiserToken));
    expect(page.body.data.order.status).toBe('draft');
    expect(page.body.data.order.sent_back).toEqual(expect.objectContaining({ by: 'Veronica Manager', reason: 'Change source' }));
  });

  test('the rep who raised it can resubmit — and Management is told it is a resubmission', async () => {
    const order = await pendingOrder();
    await sendBack(order.id, 'Change source');
    const res = await submit(order.id, raiserToken);
    expect(res.status).toBe(200);
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id)).status).toBe('pending_management_approval');

    const ev = await db
      .prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'STATUS_CHANGE' AND old_status = 'draft' ORDER BY id DESC LIMIT 1")
      .get(order.id);
    expect(ev.notes).toMatch(/Resubmitted by .* after Management \(Veronica Manager\) sent it back for: Change source/);

    const note = await db.prepare('SELECT message FROM notifications WHERE order_id = ? AND recipient_id = ?').get(order.id, managementId);
    expect(note.message).toMatch(/RESUBMITTED after being sent back \(Change source\)/);
  });

  test('the approval queue marks it Resubmitted, with the reason', async () => {
    const order = await pendingOrder();
    await sendBack(order.id, 'Wrong division');
    await submit(order.id, raiserToken);
    const queue = await request(app)
      .get('/api/management/orders')
      .query({ status: 'pending_management_approval', search: order.getmeds_order_id })
      .set(auth(managementToken));
    const row = queue.body.data.orders.find((o) => o.id === order.id);
    expect(row.resubmission).toEqual(expect.objectContaining({ by: 'Veronica Manager', reason: 'Wrong division' }));
  });

  test('an order never sent back is not marked as a resubmission', async () => {
    const order = await pendingOrder();
    const queue = await request(app)
      .get('/api/management/orders')
      .query({ status: 'pending_management_approval', search: order.getmeds_order_id })
      .set(auth(managementToken));
    expect(queue.body.data.orders.find((o) => o.id === order.id).resubmission).toBeNull();
  });
});
