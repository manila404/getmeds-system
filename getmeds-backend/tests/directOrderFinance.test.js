/**
 * Every order reaches Finance — a Direct one included.
 *
 * Sep 14, 2026.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * GM-20260914-0006 was a Direct order. The MedRep raised it, Management
 * (Veronica) approved it, and it went straight to 'ready_for_draft_invoice' —
 * past Finance, with nobody checking the customer's account or the payment.
 *
 * The rule that sends a Direct order to Finance already existed; it was only
 * switched on under GETMEDS_WORKFLOW_V2, which is off. Both creation and
 * approval read `isCredit || isWorkflowV2Enabled()`, so with the switch off a
 * Direct order skipped Finance on either path.
 *
 * ── The rule now ──────────────────────────────────────────────────────────
 *
 * Every order goes to Finance, switch or not. Management's approval is a
 * decision about the order; Finance's check is about the account and the
 * payment. Neither stands in for the other. These tests pin the rule on both
 * paths, and with the switch explicitly OFF — the setting it slipped through.
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

describe('a Direct order reaches Finance', () => {
  let managerToken, medrepToken, financeToken;
  let directCustomerId, productId, medrepId;
  const createdOrderIds = [];
  const createdUserIds = [];
  const savedFlag = process.env.GETMEDS_WORKFLOW_V2;

  beforeAll(async () => {
    // The setting GM-20260914-0006 slipped through.
    process.env.GETMEDS_WORKFLOW_V2 = 'false';

    medrepToken = await loginAs('medrep@getmeds.ph');
    financeToken = await loginAs('finance@getmeds.ph');
    medrepId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('medrep@getmeds.ph')).id;

    // Own manager: which management accounts exist varies by environment.
    const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    const email = `mgr-direct-${Date.now()}@getmeds.ph`;
    await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'management')")
      .run('Direct Manager', email, seed.password_hash);
    createdUserIds.push((await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id);
    managerToken = await loginAs(email);

    directCustomerId = (await db.prepare("SELECT id FROM customers WHERE type = 'direct' AND is_active = 1 LIMIT 1").get()).id;
    productId = (await db.prepare('SELECT id FROM products WHERE is_active = 1 LIMIT 1').get()).id;
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.GETMEDS_WORKFLOW_V2;
    else process.env.GETMEDS_WORKFLOW_V2 = savedFlag;
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  const directOrder = {
    customer_type: 'direct',
    delivery_address: '1 Direct St',
    no_payment_proof_reason: 'payment_to_follow',
    items: [{ product_id: null, quantity: 1, unit_price: 125 }]
  };

  const statusOf = async (id) => (await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status;

  const onFinanceQueue = async (id) => {
    const q = await request(app).get('/api/finance/queue?stage=actionable&limit=100').set(auth(financeToken));
    expect(q.status).toBe(200);
    return q.body.data.orders.some((o) => o.id === id);
  };

  test('a Direct order a MedRep raised goes to Finance once Management approves it', async () => {
    // Exactly GM-20260914-0006's path.
    const raised = await request(app)
      .post('/api/orders')
      .set(auth(medrepToken))
      .send({
        ...directOrder,
        customer_id: directCustomerId,
        items: [{ ...directOrder.items[0], product_id: productId }]
      });
    expect([200, 201]).toContain(raised.status);
    const id = raised.body.data.order.id;
    createdOrderIds.push(id);
    expect(await statusOf(id)).toBe('pending_management_approval');

    const approved = await request(app).post(`/api/orders/${id}/approve`).set(auth(managerToken)).send({});
    expect(approved.status).toBe(200);

    expect(await statusOf(id)).toBe('ready_for_finance_verified');
    expect(await onFinanceQueue(id)).toBe(true);
  });

  test('a Direct order Management raised itself goes straight to Finance', async () => {
    const raised = await request(app)
      .post('/api/orders')
      .set(auth(managerToken))
      .send({
        ...directOrder,
        customer_id: directCustomerId,
        medrep_id: medrepId,
        items: [{ ...directOrder.items[0], product_id: productId }]
      });
    expect([200, 201]).toContain(raised.status);
    const id = raised.body.data.order.id;
    createdOrderIds.push(id);

    expect(await statusOf(id)).toBe('ready_for_finance_verified');
    expect(await onFinanceQueue(id)).toBe(true);
  });

  test('nothing skips straight to invoicing without Finance', async () => {
    // The guard on the rule itself: a Direct order approved by Management
    // must not have a trail that jumps to 'ready_for_draft_invoice'.
    const raised = await request(app)
      .post('/api/orders')
      .set(auth(managerToken))
      .send({
        ...directOrder,
        customer_id: directCustomerId,
        medrep_id: medrepId,
        items: [{ ...directOrder.items[0], product_id: productId }]
      });
    const id = raised.body.data.order.id;
    createdOrderIds.push(id);

    const jumped = await db
      .prepare("SELECT 1 FROM order_events WHERE order_id = ? AND new_status = 'ready_for_draft_invoice'")
      .get(id);
    expect(jumped).toBeFalsy();
  });
});
