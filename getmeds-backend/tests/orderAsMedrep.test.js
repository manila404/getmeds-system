/**
 * "Raise this order as <MedRep>" — the Test Mode affordance added Sep 2, 2026.
 *
 * In TEST_MODE an admin passes every role gate, so they can reach the New
 * Order form; their order used to be attributed to the single seeded
 * medrep@getmeds.ph account (auditService's resolveActor). Harmless when
 * nothing was per-MedRep, useless now that each carries their own Zoho
 * Salesperson — testing one meant logging out and back in.
 *
 * The rules being guarded here are all about who is allowed to redirect an
 * order onto someone else's name:
 *
 *   - TEST_MODE + admin  -> `medrep_id` is honoured
 *   - anyone else        -> `medrep_id` is IGNORED, not refused, so a stray
 *                           field from an old client can never quietly move
 *                           an order in normal operation
 *   - honoured but bad   -> 400, because there the caller meant something
 *                           specific and got it wrong
 *
 * Env is set explicitly in beforeAll rather than inherited from .env, so
 * this file does not change behaviour when someone edits .env.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const PREFIX = 'as-medrep-test-';
const PASSWORD = 'long-enough-pw';

let adminToken;
let repA;
let repB;
let repBToken;
let customerId;
let productId;
const createdOrderIds = [];

const saved = {};
const setEnv = (key, value) => {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const signUp = async (label, division, displayName) => {
  const email = `${PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}@getmeds.ph`;
  const res = await request(app).post('/api/auth/register').send({
    first_name: displayName.split(' ')[0],
    last_name: displayName.split(' ').slice(1).join(' ') || 'Rep',
    display_name: displayName,
    division,
    email,
    password: PASSWORD
  });
  if (res.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.data.user, email };
};

const login = async (email, password = PASSWORD) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
};

const createOrder = (token, body) =>
  request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({
      customer_id: customerId,
      items: [{ product_id: productId, quantity: 2 }],
      delivery_address: '1 Test St, Manila',
      ...body
    });

beforeAll(async () => {
  // Test Mode on, and the TEST-customer gate off so any fixture customer is
  // orderable — this file is about who the order is FOR, not about the gate.
  setEnv('TEST_MODE', 'true');
  setEnv('ZOHO_TEST_CUSTOMER_IDS', '');
  setEnv('ZOHO_TEST_CUSTOMER_ID', '');
  setEnv('ZOHO_DRY_RUN', 'false');

  adminToken = await login('admin@getmeds.ph', 'demo123');

  repA = await signUp('repa', 'TEST', 'Aaron Manila');
  repB = await signUp('repb', 'NORTH', 'Bea Cruz');
  repBToken = await login(repB.email);

  customerId = (await db
    .prepare("INSERT INTO customers (name, type, zoho_contact_id) VALUES (?, 'credit', ?)")
    .run(`${PREFIX}client`, `${PREFIX}zc`)).lastInsertRowid;
  productId = (await db
    .prepare('INSERT INTO products (name, sku, unit_price) VALUES (?, ?, 10)')
    .run(`${PREFIX}product`, `${PREFIX}sku`)).lastInsertRowid;
});

afterAll(async () => {
  for (const id of createdOrderIds) {
    await db.prepare('DELETE FROM notifications WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  if (productId) await db.prepare('DELETE FROM products WHERE id = ?').run(productId);
  if (customerId) await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${PREFIX}%`);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /api/orders/meta/medreps', () => {
  test('an admin in Test Mode gets the list, with each rep\'s Salesperson', async () => {
    const res = await request(app).get('/api/orders/meta/medreps').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);

    const mine = res.body.data.medreps.find((m) => m.id === repA.id);
    expect(mine).toEqual(
      expect.objectContaining({ display_name: 'Aaron Manila', division: 'TEST', salesperson: 'TEST | Aaron Manila' })
    );
  });

  test('a MedRep gets an empty, disabled list — the picker is not theirs', async () => {
    const res = await request(app).get('/api/orders/meta/medreps').set('Authorization', `Bearer ${repBToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: false, medreps: [] });
  });

  test('outside Test Mode even an admin gets nothing', async () => {
    setEnv('TEST_MODE', 'false');
    try {
      const res = await request(app).get('/api/orders/meta/medreps').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.medreps).toEqual([]);
    } finally {
      setEnv('TEST_MODE', 'true');
    }
  });
});

describe('POST /api/orders with medrep_id', () => {
  test('an admin raises the order for the named rep, and Zoho gets THAT rep\'s Salesperson', async () => {
    const res = await createOrder(adminToken, { medrep_id: repA.id });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    createdOrderIds.push(order.id);

    // Attributed to the chosen rep, not to the admin and not to the seeded
    // medrep account resolveActor would otherwise have picked.
    const row = await db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(order.id);
    expect(row.medrep_id).toBe(repA.id);

    // And the Sales Order carries their Salesperson — the whole point.
    const so = await zoho.getSalesOrder(order.zoho_so_id);
    expect(so.salesorder.salesperson_name).toBe('TEST | Aaron Manila');
  });

  test('picking a different rep changes the Salesperson that goes out', async () => {
    const res = await createOrder(adminToken, { medrep_id: repB.id });
    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.data.order.id);

    const so = await zoho.getSalesOrder(res.body.data.order.zoho_so_id);
    expect(so.salesorder.salesperson_name).toBe('NORTH | Bea Cruz');
  });

  test('the audit trail records who actually raised it', async () => {
    const res = await createOrder(adminToken, { medrep_id: repA.id });
    createdOrderIds.push(res.body.data.order.id);

    const event = await db
      .prepare("SELECT actor_id, actor_name, notes, metadata FROM order_events WHERE order_id = ? ORDER BY id LIMIT 1")
      .get(res.body.data.order.id);

    // Actor stays the MedRep — that is what makes the attribution consistent
    // with orders.medrep_id and the Zoho Salesperson…
    expect(event.actor_id).toBe(repA.id);
    // …and the admin who clicked is named alongside, so it stays traceable.
    expect(event.notes).toContain('on behalf of Aaron Manila');
    expect(JSON.parse(event.metadata)).toEqual(
      expect.objectContaining({ onBehalfOf: true, raisedByUserId: expect.any(Number) })
    );
  });

  test('an unknown medrep_id is a 400, and creates nothing', async () => {
    const before = (await db.prepare('SELECT COUNT(*) c FROM orders').get()).c;

    const res = await createOrder(adminToken, { medrep_id: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MEDREP');
    expect((await db.prepare('SELECT COUNT(*) c FROM orders').get()).c).toBe(before);
  });

  test('an id that is a real user but not a MedRep is refused too', async () => {
    const admin = await db.prepare("SELECT id FROM users WHERE email = 'admin@getmeds.ph'").get();
    const res = await createOrder(adminToken, { medrep_id: admin.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MEDREP');
  });

  // The containment rule: this is a test affordance, so nobody else gets it.
  test('a MedRep naming someone else is IGNORED — the order stays theirs', async () => {
    const res = await createOrder(repBToken, { medrep_id: repA.id });
    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.data.order.id);

    const row = await db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(row.medrep_id).toBe(repB.id);

    const so = await zoho.getSalesOrder(res.body.data.order.zoho_so_id);
    expect(so.salesorder.salesperson_name).toBe('NORTH | Bea Cruz');
  });

  test('outside Test Mode medrep_id is ignored rather than rejected', async () => {
    setEnv('TEST_MODE', 'false');
    try {
      const res = await createOrder(repBToken, { medrep_id: repA.id });
      expect(res.status).toBe(201);
      createdOrderIds.push(res.body.data.order.id);

      const row = await db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(res.body.data.order.id);
      expect(row.medrep_id).toBe(repB.id);
    } finally {
      setEnv('TEST_MODE', 'true');
    }
  });

  test('no medrep_id at all behaves exactly as before', async () => {
    const res = await createOrder(repBToken, {});
    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.data.order.id);

    const row = await db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(res.body.data.order.id);
    expect(row.medrep_id).toBe(repB.id);

    const event = await db
      .prepare('SELECT notes, metadata FROM order_events WHERE order_id = ? ORDER BY id LIMIT 1')
      .get(res.body.data.order.id);
    expect(event.notes).not.toContain('on behalf of');
    expect(event.metadata).toBeNull();
  });
});
