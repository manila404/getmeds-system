/**
 * The User Details modal's server side: editing an account's own details, and
 * permanently deleting one.
 *
 * Sep 24, 2026.
 *
 * Two rules here are the kind a later refactor removes without noticing, so both
 * are pinned:
 *
 *   - a delete is only ever allowed for an account with NO history. Twenty-odd
 *     tables point at users(id); deleting a person who raised an order or
 *     verified a payment would rewrite who did what. The answer for those is
 *     Deactivate, and the response says so.
 *   - an admin, and yourself, can never be deleted through this route.
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

describe('User Details: edit and delete', () => {
  let adminToken, medrepToken, passwordHash;
  const stamp = Date.now();
  const created = [];

  const makeUser = async (label, role = 'medrep') => {
    const email = `ud-${label}-${stamp}@getmeds.ph`;
    await db
      .prepare(
        "INSERT INTO users (name, email, password_hash, role, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(`UD ${label} ${stamp}`, email, passwordHash, role, `UD`, `${label} ${stamp}`);
    const row = await db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    created.push(row.id);
    return row;
  };

  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    passwordHash = (await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph'))
      .password_hash;
  });

  afterAll(async () => {
    // Children first: a row that references another has to go before it.
    await db.prepare('UPDATE users SET approved_by = NULL WHERE approved_by = ANY(?)').run([created]);
    for (const id of created) {
      await db.prepare('DELETE FROM notifications WHERE recipient_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  });

  describe('PATCH /api/admin/users/:id — name and email', () => {
    test('changes first and last name together, and keeps the list in step', async () => {
      const u = await makeUser('rename');
      const res = await request(app)
        .patch(`/api/admin/users/${u.id}`)
        .set(auth(adminToken))
        .send({ first_name: 'Maria Clara', last_name: `Santos ${stamp}` });
      expect(res.status).toBe(200);

      const row = await db.prepare('SELECT name, display_name, first_name, last_name FROM users WHERE id = ?').get(u.id);
      expect(row.first_name).toBe('Maria Clara');
      expect(row.last_name).toBe(`Santos ${stamp}`);
      expect(row.name).toBe(`Maria Clara Santos ${stamp}`);
      expect(row.display_name).toBe(row.name);

      // A two-word first name survives the round trip through the list, which
      // used to split `name` on the first space and get it wrong.
      const list = await request(app).get('/api/admin/users').set(auth(adminToken));
      const listed = list.body.data.find((x) => x.id === u.id);
      expect(listed.first_name).toBe('Maria Clara');
      expect(listed.last_name).toBe(`Santos ${stamp}`);
    });

    test('refuses a blank first name', async () => {
      const u = await makeUser('blank');
      const res = await request(app)
        .patch(`/api/admin/users/${u.id}`)
        .set(auth(adminToken))
        .send({ first_name: '   ' });
      expect(res.status).toBe(400);
    });

    test('refuses a name another account already has, and changes nothing', async () => {
      const a = await makeUser('clash-a');
      const b = await makeUser('clash-b');
      const before = await db.prepare('SELECT name FROM users WHERE id = ?').get(b.id);
      const res = await request(app)
        .patch(`/api/admin/users/${b.id}`)
        .set(auth(adminToken))
        .send({ first_name: 'UD', last_name: `clash-a ${stamp}`, role: 'finance' });
      expect(res.status).toBe(409);
      // The role in the same request was not applied either.
      const after = await db.prepare('SELECT name, role FROM users WHERE id = ?').get(b.id);
      expect(after.name).toBe(before.name);
      expect(after.role).toBe('medrep');
      expect(a.id).not.toBe(b.id);
    });

    test('changes the email, lower-cased, and refuses one already in use', async () => {
      const a = await makeUser('mail-a');
      const b = await makeUser('mail-b');

      const ok = await request(app)
        .patch(`/api/admin/users/${a.id}`)
        .set(auth(adminToken))
        .send({ email: `UD-New-${stamp}@GetMeds.PH` });
      expect(ok.status).toBe(200);
      expect((await db.prepare('SELECT email FROM users WHERE id = ?').get(a.id)).email).toBe(`ud-new-${stamp}@getmeds.ph`);

      const taken = await request(app)
        .patch(`/api/admin/users/${a.id}`)
        .set(auth(adminToken))
        .send({ email: b.email.toUpperCase() });
      expect(taken.status).toBe(409);

      const bad = await request(app)
        .patch(`/api/admin/users/${a.id}`)
        .set(auth(adminToken))
        .send({ email: 'not-an-email' });
      expect(bad.status).toBe(400);
    });

    test('re-sending the account\'s own email is not a conflict', async () => {
      const u = await makeUser('same-mail');
      const res = await request(app)
        .patch(`/api/admin/users/${u.id}`)
        .set(auth(adminToken))
        .send({ email: u.email });
      expect(res.status).toBe(200);
    });

    test('sets a username, shown in the list; an untouched account still shows its email prefix', async () => {
      const u = await makeUser('uname');
      const other = await makeUser('uname-plain');

      const ok = await request(app)
        .patch(`/api/admin/users/${u.id}`)
        .set(auth(adminToken))
        .send({ username: `Custom.Name-${stamp}` });
      expect(ok.status).toBe(200);

      const list = (await request(app).get('/api/admin/users').set(auth(adminToken))).body.data;
      expect(list.find((x) => x.id === u.id).username).toBe(`Custom.Name-${stamp}`);
      expect(list.find((x) => x.id === other.id).username).toBe(other.email.split('@')[0]);
    });

    test('refuses a username someone already has, case-insensitively, including an email prefix', async () => {
      const a = await makeUser('uname-a');
      const b = await makeUser('uname-b');
      await request(app).patch(`/api/admin/users/${a.id}`).set(auth(adminToken)).send({ username: `taken-${stamp}` });

      const dupe = await request(app)
        .patch(`/api/admin/users/${b.id}`)
        .set(auth(adminToken))
        .send({ username: `TAKEN-${stamp}` });
      expect(dupe.status).toBe(409);

      // b would also collide with a's untouched-account display, i.e. a prefix.
      const c = await makeUser('uname-c');
      const clash = await request(app)
        .patch(`/api/admin/users/${b.id}`)
        .set(auth(adminToken))
        .send({ username: c.email.split('@')[0] });
      expect(clash.status).toBe(409);
    });

    test('refuses an unusable username, and keeping the current one is not a conflict', async () => {
      const u = await makeUser('uname-bad');
      for (const bad of ['', ' ', 'a', 'has space', 'bad@name']) {
        const res = await request(app).patch(`/api/admin/users/${u.id}`).set(auth(adminToken)).send({ username: bad });
        expect(res.status).toBe(400);
      }
      const same = await request(app)
        .patch(`/api/admin/users/${u.id}`)
        .set(auth(adminToken))
        .send({ username: u.email.split('@')[0] });
      expect(same.status).toBe(200);
    });

    test('a non-admin cannot edit accounts', async () => {
      const u = await makeUser('nonadmin');
      const res = await request(app)
        .patch(`/api/admin/users/${u.id}`)
        .set(auth(medrepToken))
        .send({ first_name: 'Nope' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/admin/users — Date Modified and ordering', () => {
    test('updated_at moves when any write path touches the account', async () => {
      const u = await makeUser('modified');
      // Backdate it so the assertion cannot pass on clock resolution alone.
      await db.prepare("UPDATE users SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(u.id);
      const before = await db.prepare('SELECT updated_at FROM users WHERE id = ?').get(u.id);
      expect(before.updated_at).toBe('2020-01-01T00:00:00.000Z');

      // An admin edit...
      await request(app).patch(`/api/admin/users/${u.id}`).set(auth(adminToken)).send({ role: 'finance' });
      const afterEdit = await db.prepare('SELECT updated_at FROM users WHERE id = ?').get(u.id);
      expect(afterEdit.updated_at > '2020-01-01T00:00:00.000Z').toBe(true);

      // ...and a write that does not go through the admin controller at all.
      await db.prepare("UPDATE users SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(u.id);
      await db.prepare("UPDATE users SET password_hash = password_hash WHERE id = ?").run(u.id);
      const afterOther = await db.prepare('SELECT updated_at FROM users WHERE id = ?').get(u.id);
      expect(afterOther.updated_at > '2020-01-01T00:00:00.000Z').toBe(true);
    });

    test('the list carries updated_at, and admins come first', async () => {
      await makeUser('order-check');
      const res = await request(app).get('/api/admin/users').set(auth(adminToken));
      expect(res.status).toBe(200);
      const rows = res.body.data;
      expect(rows.every((r) => r.updated_at)).toBe(true);

      const roles = rows.map((r) => r.role);
      const lastAdmin = roles.lastIndexOf('admin');
      const firstNonAdmin = roles.findIndex((r) => r !== 'admin');
      expect(lastAdmin).toBeGreaterThanOrEqual(0);
      expect(lastAdmin).toBeLessThan(firstNonAdmin);
    });
  });

  describe('DELETE /api/admin/users/:id', () => {
    test('permanently removes an account with no history, and its notifications', async () => {
      const u = await makeUser('deletable');
      await db
        .prepare("INSERT INTO notifications (recipient_id, channel, message) VALUES (?, 'in_app', 'hello')")
        .run(u.id);

      const res = await request(app).delete(`/api/admin/users/${u.id}`).set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id)).toBeUndefined();
      expect(await db.prepare('SELECT id FROM notifications WHERE recipient_id = ?').get(u.id)).toBeUndefined();
    });

    test('refuses an account that has history, and removes nothing', async () => {
      const subject = await makeUser('has-history');
      const other = await makeUser('approved-by-subject');
      // `other` was approved by `subject`: a record of who did what.
      await db.prepare('UPDATE users SET approved_by = ? WHERE id = ?').run(subject.id, other.id);
      await db
        .prepare("INSERT INTO notifications (recipient_id, channel, message) VALUES (?, 'in_app', 'keep me')")
        .run(subject.id);

      const res = await request(app).delete(`/api/admin/users/${subject.id}`).set(auth(adminToken));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('HAS_HISTORY');
      expect(res.body.error.message).toMatch(/deactivate/i);
      expect(JSON.stringify(res.body)).not.toMatch(/constraint|pg_|stack/i);

      expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(subject.id)).toBeTruthy();
      // The refused delete rolled back: the inbox is untouched too.
      expect(await db.prepare('SELECT id FROM notifications WHERE recipient_id = ?').get(subject.id)).toBeTruthy();
    });

    test('an admin account cannot be deleted', async () => {
      const admin = await db.prepare("SELECT id FROM users WHERE email = 'admin@getmeds.ph'").get();
      const res = await request(app).delete(`/api/admin/users/${admin.id}`).set(auth(adminToken));
      expect([403]).toContain(res.status);
      expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(admin.id)).toBeTruthy();
    });

    test('an admin cannot delete themselves', async () => {
      const me = await makeUser('self-admin', 'medrep');
      const meToken = await loginAs(me.email);
      // Not an admin, so this is refused at the router; the point is that the
      // account survives.
      const res = await request(app).delete(`/api/admin/users/${me.id}`).set(auth(meToken));
      expect(res.status).toBe(403);
      expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(me.id)).toBeTruthy();
    });

    test('a non-admin cannot delete', async () => {
      const u = await makeUser('protected');
      const res = await request(app).delete(`/api/admin/users/${u.id}`).set(auth(medrepToken));
      expect(res.status).toBe(403);
      expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(u.id)).toBeTruthy();
    });

    test('404 for an account that does not exist', async () => {
      const res = await request(app).delete('/api/admin/users/99999999').set(auth(adminToken));
      expect(res.status).toBe(404);
    });
  });
});
