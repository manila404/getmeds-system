/**
 * Oct 9, 2026 — a Team Lead / Leader re-submits a held order that is theirs.
 *
 * Mitzi Francisco (a Leader, role team_lead) could not re-submit her own held order
 * GM-20261009-0003: "Only the MedRep on this order, or Management, can re-submit it."
 * The check only admitted the medrep role. A Team Lead may re-submit an order they own or
 * raised, and nobody else's (the same "theirs only" rule editing already uses).
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const created = { users: [], orders: [] };
let leadToken, otherRepId, customerId, leadId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(role, email, name) {
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  const info = await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at, approval_status)
       VALUES (?, ?, ?, ?, 1, ?, 'approved')`
    )
    .run(name, email, seed.password_hash, role, new Date().toISOString());
  created.users.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

async function heldOrder({ medrepId, raisedById = null }) {
  const ref = `GM-TLRS-${stamp}-${created.orders.length}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type, total_amount,
                           delivery_address, exception_reason)
       VALUES (?, ?, ?, ?, 'on_hold', 'credit', 25463.2, '1 Hold St', 'Not yet Receive')`
    )
    .run(ref, customerId, medrepId, raisedById);
  const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.orders.push(id);
  await db
    .prepare(
      `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_name, notes)
       VALUES (?, 'FINANCE_REJECTED', 'ready_for_finance_verified', 'on_hold', 'Finance Getmeds', 'held for the test')`
    )
    .run(id);
  return id;
}
const resubmit = (id, token = leadToken) =>
  request(app).post(`/api/orders/${id}/resubmit`).set(auth(token)).send({ reason: 'Order details corrected' });
const statusOf = async (id) => (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;

beforeAll(async () => {
  leadId = await makeUser('team_lead', `lead.resub.${stamp}@getmeds.ph`, 'Resubmit Leader');
  leadToken = await loginAs(`lead.resub.${stamp}@getmeds.ph`);
  otherRepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
  customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
});

afterAll(async () => {
  for (const id of created.orders) {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  for (const id of created.users) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
});

describe('a Team Lead re-submitting a held order', () => {
  test('their own order (they are its MedRep) goes back to Finance', async () => {
    const id = await heldOrder({ medrepId: leadId });
    const res = await resubmit(id);
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('ready_for_finance_verified');
  });

  test('an order they raised for a MedRep goes back too', async () => {
    const id = await heldOrder({ medrepId: otherRepId, raisedById: leadId });
    expect((await resubmit(id)).status).toBe(200);
    expect(await statusOf(id)).toBe('ready_for_finance_verified');
  });

  test("someone else's order is refused, and nothing changes", async () => {
    const id = await heldOrder({ medrepId: otherRepId });
    const res = await resubmit(id);
    expect(res.status).toBe(403);
    expect(await statusOf(id)).toBe('on_hold');
  });
});
