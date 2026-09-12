/**
 * An admin can change an account's role — within limits.
 *
 * Sep 12, 2026.
 *
 * The server has accepted `role` on PATCH /api/admin/users/:id for a long
 * time; what was missing was any way to reach it. A MedRep who moved to
 * Finance kept the access they were no longer supposed to have, and the
 * workaround was a second account.
 *
 * Two limits make this safe to expose, and both are tested below because both
 * are the kind of thing a later refactor removes without noticing:
 *
 *   - an admin cannot be changed to another role. It is the same protection
 *     that stops an admin being deactivated, and for the same reason: it is
 *     what keeps the system from being locked out of its own administration.
 *     Without it, "demote the admin, then deactivate them" walks straight
 *     around the deactivation guard.
 *
 *   - an unrecognised role is refused with a 400 before it reaches the
 *     database. users.role has a CHECK constraint, so it was never storable —
 *     but it used to arrive as a raw Postgres error returned to the caller as
 *     a 500 carrying the constraint name and a stack trace.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { ROLES } = require('../src/constants/roles');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('PATCH /api/admin/users/:id — role', () => {
  let adminToken, medrepToken;
  let subjectId;
  const createdUserIds = [];

  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');

    const seed = await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    const email = `role-subject-${Date.now()}@getmeds.ph`;
    await db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'medrep')")
      .run('Role Subject', email, seed.password_hash);
    subjectId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
    createdUserIds.push(subjectId);
  });

  afterAll(async () => {
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  const roleOf = async (id) => (await db.prepare('SELECT role FROM users WHERE id = ?').get(id)).role;

  test('an admin can move an account between the ordinary roles', async () => {
    for (const role of ['finance', 'dispatch', 'management', 'medrep']) {
      const res = await request(app)
        .patch(`/api/admin/users/${subjectId}`)
        .set(auth(adminToken))
        .send({ role });
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe(role);
      expect(await roleOf(subjectId)).toBe(role);
    }
  });

  test('the role is stored lower-cased, whatever case it arrives in', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${subjectId}`)
      .set(auth(adminToken))
      .send({ role: 'FINANCE' });
    expect(res.status).toBe(200);
    expect(await roleOf(subjectId)).toBe('finance');

    await request(app).patch(`/api/admin/users/${subjectId}`).set(auth(adminToken)).send({ role: 'medrep' });
  });

  test('an unknown role is refused with 400, not a database error', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${subjectId}`)
      .set(auth(adminToken))
      .send({ role: 'superuser' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
    // The message has to be usable by whoever sent it.
    for (const r of ROLES) expect(res.body.error.message).toContain(r);
    // And must not leak the schema.
    expect(JSON.stringify(res.body)).not.toMatch(/constraint|pg_|stack/i);

    expect(await roleOf(subjectId)).toBe('medrep');
  });

  test('an empty role is refused rather than stored', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${subjectId}`)
      .set(auth(adminToken))
      .send({ role: '' });
    expect(res.status).toBe(400);
    expect(await roleOf(subjectId)).toBe('medrep');
  });

  test('an admin account cannot be changed to another role', async () => {
    // Without this, "demote the admin, then deactivate them" walks around the
    // deactivation guard entirely.
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();

    const res = await request(app)
      .patch(`/api/admin/users/${admin.id}`)
      .set(auth(adminToken))
      .send({ role: 'medrep' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_PROTECTED');
    expect(await roleOf(admin.id)).toBe('admin');
  });

  test('a non-admin cannot change anyone role', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${subjectId}`)
      .set(auth(medrepToken))
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
    expect(await roleOf(subjectId)).toBe('medrep');
  });
});
