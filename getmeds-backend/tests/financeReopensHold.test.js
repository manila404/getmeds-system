/**
 * Finance can lift its own hold.
 *
 * Sep 12, 2026.
 *
 * A hold already had one way out: the MedRep attaches or corrects something,
 * and the order returns to the queue on its own (services/financeHoldService).
 * That covers the case where the hold was a request to the rep.
 *
 * It does not cover the commoner one. Finance holds an order, then sorts the
 * account out themselves — rings the customer, finds the payment already
 * posted, decides the balance is fine — and there is no way to put the order
 * back. The workaround was to ask the rep to touch it so it reappeared on
 * Finance's own queue, which is a person working around the software.
 *
 * ── What is deliberately NOT allowed ──────────────────────────────────────
 *
 * Only a hold Finance applied. 'on_hold' is reachable from eight statuses and
 * the warehouse and Management set it too; letting Finance lift any of them
 * would pull an order backwards through the pipeline from a stage Finance has
 * nothing to do with. The refusal says so plainly, because the fix is to talk
 * to whoever applied the hold, not to retry.
 *
 * And a reason is required. The hold was recorded with one; an order that
 * silently reappears in the queue with no account of why is worse than one
 * that never left.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('POST /api/finance/orders/:id/reopen', () => {
  let financeToken, medrepToken;
  let customerId, medrepId;
  const createdOrderIds = [];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  /** An order on hold, with a trail saying which status the hold came from. */
  async function heldOrder(heldFrom = 'ready_for_finance_verified') {
    const ref = `REOPEN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status,
                             customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'on_hold', 'credit', 1500, '1 Reopen St')`
      )
      .run(ref, customerId, medrepId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);

    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, notes)
         VALUES (?, 'FINANCE_REJECTED', ?, 'on_hold', ?, 'held for the test')`
      )
      .run(id, heldFrom, medrepId);
    return id;
  }

  const statusOf = async (id) =>
    (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;

  const reopen = (id, token, body) =>
    request(app).post(`/api/finance/orders/${id}/reopen`).set(auth(token)).send(body);

  test('Finance can put its own held order back in the queue', async () => {
    const id = await heldOrder();

    const res = await reopen(id, financeToken, { reason: 'Spoke to the customer, balance is settled' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready_for_finance_verified');
    expect(await statusOf(id)).toBe('ready_for_finance_verified');
  });

  test('it then shows on the Finance queue as awaiting confirmation', async () => {
    // The point of the whole endpoint: the order is back where Finance works.
    const id = await heldOrder();
    await reopen(id, financeToken, { reason: 'account cleared' });

    const queue = await request(app)
      .get('/api/finance/queue?stage=actionable&limit=100')
      .set(auth(financeToken));
    expect(queue.body.data.orders.map((o) => o.id)).toContain(id);
  });

  test('the reason is required, and lands on the timeline', async () => {
    const id = await heldOrder();

    const refused = await reopen(id, financeToken, {});
    expect(refused.status).toBe(400);
    expect(await statusOf(id)).toBe('on_hold');

    await reopen(id, financeToken, { reason: 'payment located in Zoho Books' });
    const ev = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'RETURNED_TO_FINANCE'")
      .get(id);
    expect(ev.notes).toMatch(/payment located in Zoho Books/);
  });

  test('a hold applied further down the pipeline is not Finance to lift', async () => {
    // The guard. A warehouse hold belongs to the warehouse, and lifting it
    // here would drag the order backwards from a stage Finance is past.
    const id = await heldOrder('picking_packing');

    const res = await reopen(id, financeToken, { reason: 'trying it on' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_A_FINANCE_HOLD');
    expect(await statusOf(id)).toBe('on_hold');
  });

  test('an order that is not on hold has nothing to reopen', async () => {
    const id = await heldOrder();
    await reopen(id, financeToken, { reason: 'first time' });

    const second = await reopen(id, financeToken, { reason: 'again' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('NOT_ON_HOLD');
  });

  test('a MedRep cannot reopen it from here', async () => {
    // They have their own route back — attach or correct something — and it
    // leaves a record of WHAT changed. This endpoint would let them clear a
    // hold by asserting it was fine.
    const id = await heldOrder();

    const res = await reopen(id, medrepToken, { reason: 'looks fine to me' });
    expect(res.status).toBe(403);
    expect(await statusOf(id)).toBe('on_hold');
  });
});
