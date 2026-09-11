/**
 * Sep 11, 2026 — accounts are created by an admin, and only by an admin.
 *
 * Self-service sign-up (POST /api/auth/register) was removed: an admin creates
 * each account on the Users page and hands the login to the person. So two
 * things are asserted here — that the public endpoint is really gone, and that
 * POST /api/admin/users now carries the checks sign-up used to make.
 *
 * Driven over real HTTP against the wired-up app, like the rest of the suite.
 * Every account created here uses the `create-test-` email prefix and is
 * removed in afterAll.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const PREFIX = 'create-test-';
const uniqueEmail = (label = 'user') =>
  `${PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}@getmeds.ph`;

const newAccount = (overrides = {}) => ({
  first_name: 'Aaron',
  middle_name: 'Pun-an',
  last_name: 'Manila',
  display_name: 'Aaron Manila',
  role: 'medrep',
  division: 'HOS',
  sub_division: 'GENSAN, BAGUIO',
  email: uniqueEmail(),
  password: 'correct-horse',
  ...overrides
});

let adminToken;
let medrepToken;

const create = (body, token = adminToken) =>
  request(app).post('/api/admin/users').set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
  adminToken = admin.body.data.token;
  const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
  medrepToken = medrep.body.data.token;
});

afterAll(async () => {
  await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${PREFIX}%`);
});

describe('self-service sign-up is gone', () => {
  test('POST /api/auth/register no longer exists, and creates nothing', async () => {
    const body = newAccount({ email: uniqueEmail('register') });
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(404);
    expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
  });
});

describe('POST /api/admin/users', () => {
  test('creates an account that can sign in straight away — no approval step', async () => {
    const body = newAccount();
    const res = await create(body);

    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual(
      expect.objectContaining({
        email: body.email,
        role: 'medrep',
        division: 'HOS',
        sub_division: 'GENSAN, BAGUIO',
        display_name: 'Aaron Manila',
        approval_status: 'approved'
      })
    );
    expect(res.body.data.user.password_hash).toBeUndefined();

    const login = await request(app).post('/api/auth/login').send({ email: body.email, password: body.password });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toEqual(expect.any(String));
  });

  test('leaves the Salesperson unset — it is picked from Zoho’s list afterwards', async () => {
    const res = await create(newAccount());
    expect(res.status).toBe(201);
    expect(res.body.data.user.salesperson).toBeNull();
  });

  test('the role is the admin’s choice', async () => {
    const res = await create(newAccount({ role: 'finance', division: '' }));
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('finance');
    expect(res.body.data.user.division).toBeNull();
  });

  test('a medrep without a Division is refused', async () => {
    const body = newAccount({ division: '' });
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
  });

  test('a Division off the fixed list is refused', async () => {
    const res = await create(newAccount({ division: 'NOT A DIVISION' }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Division must be one of/);
  });

  test('a password shorter than 8 characters is refused, creating nothing', async () => {
    const body = newAccount({ password: 'abc123' });
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at least 8/);
    expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
  });

  test('a malformed email is refused', async () => {
    const res = await create(newAccount({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('email is trimmed and lower-cased, and the duplicate check sees through case', async () => {
    const email = uniqueEmail('case');
    const first = await create(newAccount({ email: `  ${email.toUpperCase()}  ` }));
    expect(first.status).toBe(201);
    expect(first.body.data.user.email).toBe(email);

    const again = await create(newAccount({ email }));
    expect(again.status).toBe(409);
  });

  test('a MedRep cannot create accounts', async () => {
    const body = newAccount();
    const res = await create(body, medrepToken);
    expect(res.status).toBe(403);
    expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
  });

  test('nobody signed out can create accounts', async () => {
    const res = await request(app).post('/api/admin/users').send(newAccount());
    expect(res.status).toBe(401);
  });

  test('an order carries a multi-value sub-division through to the payload', async () => {
    // Moved from the sign-up tests: relaxing the account field but not the
    // order field would mean every order raised by such an account is rejected
    // for a value the account is allowed to hold.
    const body = newAccount({ sub_division: 'GENSAN, BAGUIO' });
    expect((await create(body)).status).toBe(201);
    const session = await request(app).post('/api/auth/login').send({ email: body.email, password: body.password });

    const customer = await db.prepare('SELECT * FROM customers WHERE zoho_contact_id IS NOT NULL AND is_active = 1 LIMIT 1').get();
    const product = await db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT 1').get();

    const order = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${session.body.data.token}`)
      .send({
        customer_id: customer.id,
        items: [{ product_id: product.id, quantity: 1, rate: 10 }],
        delivery_address: '1 Free Text St',
        is_draft: true,
        sub_division: 'GENSAN, BAGUIO'
      });

    expect(order.status).toBe(201);
    const saved = await db.prepare('SELECT sub_division FROM orders WHERE id = ?').get(order.body.data.order.id);
    expect(saved.sub_division).toBe('GENSAN, BAGUIO');

    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(order.body.data.order.id);
    await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.body.data.order.id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(order.body.data.order.id);
  });
});
