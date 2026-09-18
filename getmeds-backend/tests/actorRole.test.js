/**
 * Sep 18, 2026 — the trail says WHO edited an order and in what role, not
 * just their name. "By: Veronica" alone doesn't tell a MedRep whether that
 * was Management overriding something or a colleague — order_events now
 * carries actor_role (auditService.js's logEvent, looked up from actor_id's
 * CURRENT role so no controller has to pass it explicitly), and
 * orderTimelineService.js/OrderPipeline.jsx surface it as `by_role`.
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

describe('Order events record the actor\'s role', () => {
  let medrepToken, medrepId, managerToken, customerId;
  const createdOrderIds = [];

  beforeAll(async () => {
    medrepToken = await loginAs('medrep@getmeds.ph');
    managerToken = await loginAs('manager@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  async function draftOrder() {
    const ref = `GM-ROLE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'draft', 'credit', 100, '1 Trail St')`
      )
      .run(ref, customerId, medrepId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);
    return id;
  }

  test('a MedRep\'s own edit is logged with actor_role medrep', async () => {
    const id = await draftOrder();
    const res = await request(app)
      .patch(`/api/orders/${id}/details`)
      .set(auth(medrepToken))
      .send({ delivery_notes: 'Please deliver after 2pm' });
    expect(res.status).toBe(200);

    const event = await db
      .prepare("SELECT actor_name, actor_role FROM order_events WHERE order_id = ? AND event_type = 'ORDER_DETAILS_EDITED'")
      .get(id);
    expect(event.actor_role).toBe('medrep');
    expect(event.actor_name).toBe('Juan dela Cruz');
  });

  test("Management editing the same order is logged with actor_role management, distinct from the MedRep's own edit", async () => {
    const id = await draftOrder();
    await request(app).patch(`/api/orders/${id}/details`).set(auth(medrepToken)).send({ delivery_notes: 'first' });
    await request(app).patch(`/api/orders/${id}/details`).set(auth(managerToken)).send({ delivery_notes: 'corrected by management' });

    const events = await db
      .prepare("SELECT actor_name, actor_role FROM order_events WHERE order_id = ? AND event_type = 'ORDER_DETAILS_EDITED' ORDER BY id ASC")
      .all(id);
    expect(events).toHaveLength(2);
    expect(events[0].actor_role).toBe('medrep');
    expect(events[1].actor_role).toBe('management');
    expect(events[1].actor_name).not.toBe(events[0].actor_name);
  });

  test('GET /api/orders/:id exposes actor_role on every event, and the timeline carries it as by_role', async () => {
    const id = await draftOrder();
    await request(app).patch(`/api/orders/${id}/details`).set(auth(managerToken)).send({ delivery_notes: 'management note' });

    const res = await request(app).get(`/api/orders/${id}`).set(auth(managerToken));
    expect(res.status).toBe(200);

    const edited = res.body.data.events.find((e) => e.event_type === 'ORDER_DETAILS_EDITED');
    expect(edited.actor_role).toBe('management');

    // Draft has no milestone reached yet, so the edit sits under the first
    // stage's "updates" — same place OrderPipeline.jsx reads by_role from.
    const allUpdates = res.body.data.timeline.stages.flatMap((s) => s.updates);
    const timelineEntry = allUpdates.find((u) => u.event_type === 'ORDER_DETAILS_EDITED');
    expect(timelineEntry).toBeTruthy();
    expect(timelineEntry.by_role).toBe('management');
  });
});
