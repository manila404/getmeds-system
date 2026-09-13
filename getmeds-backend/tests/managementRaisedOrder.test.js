/**
 * An order a manager raises is approved the moment they raise it.
 *
 * Sep 12, 2026. The sequence, stated once:
 *
 *   management raises it  ->  approved on creation
 *                         ->  Sales Order created in Zoho (as a Draft)
 *                         ->  Finance verifies, which confirms that Draft
 *
 * There is no approval queue in that path and there should not be: a manager
 * raising an order IS the management decision, and routing it to themselves
 * would be a rubber stamp with an audit trail.
 *
 * What went wrong before was narrower than it looked. The order was always
 * handled correctly — it skipped a gate it genuinely did not need. But nothing
 * RECORDED that, and the timeline's "Management Approved" stage fills only
 * from a MANAGEMENT_APPROVED event. So the stage sat unticked for good and the
 * order read as waiting on somebody who was never coming. GM-20260912-0003 was
 * the one that surfaced it, at PHP 30,000.
 *
 * The pair of events below is the part worth defending. It would be easier to
 * emit MANAGEMENT_APPROVED for everything that skips the gate, and it would be
 * wrong: a Finance or Dispatch user raising an order has not received a
 * manager's approval, and the audit trail is the one place that must not claim
 * otherwise.
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

describe('an order raised by a Management user', () => {
  let managementToken, financeToken;
  let customerId, productId, medrepId;
  const createdOrderIds = [];
  const createdUserIds = [];
  const createdCustomerIds = [];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');

    // Own manager rather than a seeded one: which management accounts exist
    // varies between environments, and a suite that fails because somebody
    // renamed a fixture tells you nothing about the rule it is guarding.
    // Reusing the seeded rep's bcrypt hash means loginAs works without this
    // file needing bcryptjs.
    const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    const mgrEmail = `mgr-raises-${Date.now()}@getmeds.ph`;
    await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'management')")
      .run('Raising Manager', mgrEmail, seed.password_hash);
    createdUserIds.push((await db.prepare('SELECT id FROM users WHERE email = ?').get(mgrEmail)).id);
    managementToken = await loginAs(mgrEmail);

    /**
     * Its own CREDIT customer.
     *
     * resolvedCustomerType reads the customer's own `type` BEFORE the request
     * body, so sending customer_type: 'credit' against a direct customer
     * quietly produces a direct order — and credit is the path that used to
     * stop at 'so_created' waiting on a manual Zoho confirmation, which is the
     * whole subject of this file.
     *
     * Created here rather than added to globalSetup's fixtures: other suites
     * count what is in that table, and a shared fixture added for one test is
     * how a suite starts failing for reasons nobody can trace back.
     */
    const custRef = `FIXTURE-CREDIT-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO customers (name, type, credit_limit, contact_person, contact_number,
                                address, is_active, zoho_contact_id, source)
         VALUES (?, 'credit', 100000, 'Credit Contact', '09170000001',
                 '1 Credit St, Manila', 1, ?, 'local')`
      )
      .run(`FIXTURE Credit Customer ${custRef}`, custRef);
    customerId = (await db.prepare('SELECT id FROM customers WHERE zoho_contact_id = ?').get(custRef)).id;
    createdCustomerIds.push(customerId);
    productId = (await db.prepare('SELECT id FROM products LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    for (const id of createdCustomerIds) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  const eventsOf = (orderId) =>
    db.prepare('SELECT event_type, notes, metadata FROM order_events WHERE order_id = ? ORDER BY id').all(orderId);

  async function raiseAsManagement() {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(managementToken))
      .send({
        customer_id: customerId,
        medrep_id: medrepId,
        customer_type: 'credit',
        delivery_address: '1 Management St',
        items: [{ product_id: productId, quantity: 1, unit_price: 1500 }]
      });
    if (res.status === 201 || res.status === 200) {
      const id = res.body.data?.order?.id;
      if (id) createdOrderIds.push(id);
    }
    return res;
  }

  test('it is recorded as approved on creation, with no approval queue', async () => {
    const res = await raiseAsManagement();
    expect([200, 201]).toContain(res.status);

    const orderId = res.body.data.order.id;
    const types = eventsOf(orderId).then
      ? await eventsOf(orderId)
      : eventsOf(orderId);
    const names = (await Promise.resolve(types)).map((e) => e.event_type);

    expect(names).toContain('MANAGEMENT_APPROVED');
    // The gate was never entered, so nothing should claim it was pending one.
    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    expect(order.status).not.toBe('pending_management_approval');
  });

  test('it lands on Finance, not in a waiting room', async () => {
    // The whole point of the change: a credit order used to stop at
    // 'so_created' until a person confirmed the Sales Order in Zoho by hand,
    // and Finance never saw it until they did.
    const res = await raiseAsManagement();
    const orderId = res.body.data.order.id;

    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    expect(order.status).toBe('ready_for_finance_verified');

    const queue = await request(app)
      .get('/api/finance/queue?stage=actionable&limit=100')
      .set(auth(financeToken));
    expect(queue.status).toBe(200);
    expect(queue.body.data.orders.map((o) => o.id)).toContain(orderId);
  });

  test('the approval names the manager who raised it', async () => {
    // A trail entry that says an order was approved without saying by whom is
    // the kind of record that is worse than none.
    const res = await raiseAsManagement();
    const orderId = res.body.data.order.id;

    const approval = (await eventsOf(orderId)).find((e) => e.event_type === 'MANAGEMENT_APPROVED');
    expect(approval).toBeTruthy();
    expect(approval.notes).toMatch(/raised by/i);

    const meta = typeof approval.metadata === 'string' ? JSON.parse(approval.metadata) : approval.metadata;
    expect(meta.approvedOnCreation).toBe(true);
    expect(meta.raisedByRole).toBe('management');
  });

  test('a MedRep raising their own order still goes to the approval queue', async () => {
    // The guard on the change above. Skipping approval is a privilege of the
    // role that would otherwise be doing the approving; widening it to
    // everyone would quietly remove the gate from the people it exists for.
    const medrepToken = await loginAs('medrep@getmeds.ph');
    const res = await request(app)
      .post('/api/orders')
      .set(auth(medrepToken))
      .send({
        customer_id: customerId,
        customer_type: 'credit',
        delivery_address: '1 MedRep St',
        items: [{ product_id: productId, quantity: 1, unit_price: 1500 }]
      });

    expect([200, 201]).toContain(res.status);
    const orderId = res.body.data.order.id;
    createdOrderIds.push(orderId);

    const order = await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    expect(order.status).toBe('pending_management_approval');

    const names = (await eventsOf(orderId)).map((e) => e.event_type);
    expect(names).not.toContain('MANAGEMENT_APPROVED');
  });
});
