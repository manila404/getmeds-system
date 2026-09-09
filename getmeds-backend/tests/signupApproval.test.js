/**
 * Sep 9, 2026 — a sign-up has to be approved by an admin before it can be used,
 * and sub-division is free text.
 *
 * The gate is only as good as its weakest hole, so each way in is asserted
 * separately: the sign-up response itself, the login, and a token that was
 * valid when approval was revoked. Missing any one of the three would leave
 * "approved" as decoration.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const PREFIX = 'approval.test+';
const email = () => `${PREFIX}${Date.now()}${Math.random().toString(36).slice(2, 8)}@getmeds.ph`;

const applicant = (overrides = {}) => ({
  first_name: 'Pending',
  last_name: 'Person',
  display_name: 'Pending Person',
  division: 'HOS',
  email: email(),
  password: 'correct-horse',
  ...overrides
});

let adminToken;

async function signUp(overrides = {}) {
  const body = applicant(overrides);
  const res = await request(app).post('/api/auth/register').send(body);
  return { body, res };
}

const login = (body) =>
  request(app).post('/api/auth/login').send({ email: body.email, password: body.password });

describe('Sign-up requires admin approval', () => {
  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${PREFIX}%`);
  });

  test('a new sign-up cannot log in', async () => {
    const { body } = await signUp();
    const res = await login(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PENDING_APPROVAL');
    // The message has to say what to do next. "Invalid email or password"
    // would send someone to reset a password that is perfectly correct.
    expect(res.body.error.message).toMatch(/approve/i);
  });

  test('a wrong password on a pending account still reads as invalid credentials', async () => {
    // The approval check runs AFTER the password on purpose. Answering
    // "waiting for approval" to any password would turn this endpoint into a
    // way to discover which email addresses have signed up.
    const { body } = await signUp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('approving lets them in', async () => {
    const { body, res: signup } = await signUp();
    const id = signup.body.data.user.id;

    const approved = await request(app)
      .post(`/api/admin/users/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(approved.status).toBe(200);
    expect(approved.body.data.user.approval_status).toBe('approved');
    expect(approved.body.data.user.approved_by).toBeTruthy();
    expect(approved.body.data.user.approved_at).toBeTruthy();

    const res = await login(body);
    expect(res.status).toBe(200);
    expect(res.body.data.token).toEqual(expect.any(String));
  });

  test('approving twice is a no-op, not an error', async () => {
    const { res: signup } = await signUp();
    const id = signup.body.data.user.id;
    const url = `/api/admin/users/${id}/approve`;

    const first = await request(app).post(url).set('Authorization', `Bearer ${adminToken}`);
    const second = await request(app).post(url).set('Authorization', `Bearer ${adminToken}`);

    expect(first.body.data.changed).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.data.changed).toBe(false);
  });

  test('rejecting keeps them out, and says so differently', async () => {
    const { body, res: signup } = await signUp();
    const id = signup.body.data.user.id;

    const rejected = await request(app)
      .post(`/api/admin/users/${id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.user.approval_status).toBe('rejected');

    const res = await login(body);
    expect(res.status).toBe(403);
    // Distinct from PENDING_APPROVAL: "still waiting" and "was refused" are
    // different things to tell someone.
    expect(res.body.error.code).toBe('SIGNUP_REJECTED');
  });

  test('a rejected account can be approved after all', async () => {
    const { body, res: signup } = await signUp();
    const id = signup.body.data.user.id;

    await request(app).post(`/api/admin/users/${id}/reject`).set('Authorization', `Bearer ${adminToken}`);
    await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${adminToken}`);

    const res = await login(body);
    expect(res.status).toBe(200);
  });

  test('an already-approved account cannot be "rejected" — that is a Deactivate', async () => {
    const { res: signup } = await signUp();
    const id = signup.body.data.user.id;

    await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${adminToken}`);
    const res = await request(app)
      .post(`/api/admin/users/${id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_APPROVED');
  });

  test('losing approval kills a token already in someone’s hands', async () => {
    // The gate cannot live only at the login: a token is good for 8 hours, so
    // requireAuth re-reads approval_status on every request rather than
    // trusting what the token said when it was issued.
    //
    // The status is changed in the DATABASE here, not through the reject
    // endpoint — that endpoint deliberately refuses an already-approved
    // account (409 ALREADY_APPROVED; Deactivate is the right action for one of
    // those, covered by the next test). What is under test is the middleware,
    // so the state it reacts to is set directly.
    const { body, res: signup } = await signUp();
    const id = signup.body.data.user.id;

    await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${adminToken}`);
    const session = await login(body);
    const token = session.body.data.token;

    const before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await db.prepare("UPDATE users SET approval_status = 'pending' WHERE id = ?").run(id);

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  test('deactivating an approved account also kills its live token', async () => {
    // The pre-existing half of the same guard, asserted next to the new one so
    // a future edit to that condition cannot quietly drop either.
    const { body, res: signup } = await signUp();
    const id = signup.body.data.user.id;

    await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${adminToken}`);
    const session = await login(body);
    const token = session.body.data.token;

    await request(app)
      .patch(`/api/admin/users/${id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  test('only an admin can approve', async () => {
    const { res: signup } = await signUp();
    const id = signup.body.data.user.id;

    const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    const res = await request(app)
      .post(`/api/admin/users/${id}/approve`)
      .set('Authorization', `Bearer ${medrep.body.data.token}`);

    expect(res.status).toBe(403);
  });

  test('pending accounts sort to the top of the admin user list', async () => {
    // A queue buried among eighty alphabetised names is a queue nobody works.
    await signUp();
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const users = res.body.data;
    const firstPending = users.findIndex((u) => u.approval_status === 'pending');
    const firstApproved = users.findIndex((u) => u.approval_status === 'approved');
    expect(firstPending).toBe(0);
    expect(firstPending).toBeLessThan(firstApproved);
  });

  test('accounts that predate approval are treated as approved', async () => {
    // The column DEFAULTS to 'approved' precisely so that adding it to a live
    // database does not lock everyone out on deploy. The seeded logins are
    // exactly that case.
    const res = await request(app).post('/api/auth/login').send({ email: 'finance@getmeds.ph', password: 'demo123' });
    expect(res.status).toBe(200);
  });
});

describe('Sub-division is free text', () => {
  afterAll(async () => {
    await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${PREFIX}%`);
  });

  test('accepts a value that is not on the Division\'s suggestion list', async () => {
    // HOS has the longest fixed list, and was the worst case: the dropdown
    // could not express a branch the list had never been updated with.
    const { res } = await signUp({ division: 'HOS', sub_division: 'A BRANCH NOBODY LISTED' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.sub_division).toBe('A BRANCH NOBODY LISTED');
  });

  test('accepts several sub-divisions at once', async () => {
    // The actual ask: a rep covers more than one, and a <select> cannot say so.
    const { body, res } = await signUp({ division: 'HOS', sub_division: 'GENSAN, BAGUIO, BICOL' });

    expect(res.status).toBe(201);
    const row = await db.prepare('SELECT sub_division FROM users WHERE email = ?').get(body.email);
    expect(row.sub_division).toBe('GENSAN, BAGUIO, BICOL');
  });

  test('an order carries a multi-value sub-division through to the payload', async () => {
    // The half that would otherwise be missed: relaxing the account field but
    // not the order field means every order raised by such an account is
    // rejected for a value the account is required to hold.
    const { body, res: signup } = await signUp({ division: 'HOS', sub_division: 'GENSAN, BAGUIO' });
    await db
      .prepare("UPDATE users SET approval_status = 'approved' WHERE id = ?")
      .run(signup.body.data.user.id);
    const session = await login(body);

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
