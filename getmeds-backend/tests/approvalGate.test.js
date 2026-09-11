/**
 * The approval gate, for accounts left pending when sign-up was removed.
 *
 * Sep 9, 2026: a self-service sign-up had to be approved by an admin before it
 * could be used. Sep 11, 2026: sign-up itself is gone — accounts are created
 * by an admin, approved from the start — but sign-ups were still waiting in
 * the live database when it went, so the gate and the Approve/Reject endpoints
 * stay for them. There is no endpoint that makes a pending account any more,
 * so these tests seed them directly.
 *
 * The gate is only as good as its weakest hole, so each way in is asserted
 * separately: the login, and a token that was valid when approval was revoked.
 * Missing either would leave "approved" as decoration.
 *
 * (Was tests/signupApproval.test.js.)
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const db = require('../src/db/database');

const PREFIX = 'approval.test+';
const PASSWORD = 'correct-horse';
const HASH = bcrypt.hashSync(PASSWORD, 4);

let adminToken;

/** A leftover sign-up: a medrep row still waiting on an admin. */
async function pendingAccount() {
  const email = `${PREFIX}${Date.now()}${Math.random().toString(36).slice(2, 8)}@getmeds.ph`;
  await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, display_name, division, approval_status)
       VALUES ('Pending Person', ?, ?, 'medrep', 'Pending Person', 'HOS', 'pending')`
    )
    .run(email, HASH);
  const { id } = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  return { id, body: { email, password: PASSWORD } };
}

const login = (body) =>
  request(app).post('/api/auth/login').send({ email: body.email, password: body.password });

describe('Accounts still pending from sign-up', () => {
  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${PREFIX}%`);
  });

  test('a pending account cannot log in', async () => {
    const { body } = await pendingAccount();
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
    // way to discover which email addresses have an account.
    const { body } = await pendingAccount();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('approving lets them in', async () => {
    const { id, body } = await pendingAccount();

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
    const { id } = await pendingAccount();
    const url = `/api/admin/users/${id}/approve`;

    const first = await request(app).post(url).set('Authorization', `Bearer ${adminToken}`);
    const second = await request(app).post(url).set('Authorization', `Bearer ${adminToken}`);

    expect(first.body.data.changed).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.data.changed).toBe(false);
  });

  test('rejecting keeps them out, and says so differently', async () => {
    const { id, body } = await pendingAccount();

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
    const { id, body } = await pendingAccount();

    await request(app).post(`/api/admin/users/${id}/reject`).set('Authorization', `Bearer ${adminToken}`);
    await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${adminToken}`);

    const res = await login(body);
    expect(res.status).toBe(200);
  });

  test('an already-approved account cannot be "rejected" — that is a Deactivate', async () => {
    const { id } = await pendingAccount();

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
    // account (409 ALREADY_APPROVED). What is under test is the middleware, so
    // the state it reacts to is set directly.
    const { id, body } = await pendingAccount();

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
    const { id, body } = await pendingAccount();

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
    const { id } = await pendingAccount();

    const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    const res = await request(app)
      .post(`/api/admin/users/${id}/approve`)
      .set('Authorization', `Bearer ${medrep.body.data.token}`);

    expect(res.status).toBe(403);
  });

  test('pending accounts sort to the top of the admin user list', async () => {
    // A queue buried among eighty alphabetised names is a queue nobody works.
    await pendingAccount();
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
    // database did not lock everyone out on deploy. The seeded logins are
    // exactly that case.
    const res = await request(app).post('/api/auth/login').send({ email: 'finance@getmeds.ph', password: 'demo123' });
    expect(res.status).toBe(200);
  });
});
