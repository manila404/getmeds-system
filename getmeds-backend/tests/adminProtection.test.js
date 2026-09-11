/**
 * Sep 11, 2026 — an admin account cannot be switched off.
 *
 * The thing being prevented is a system locked out of its own administration:
 * no admin means no approving sign-ups, no user management, and no way back in
 * short of a database console.
 *
 * There are three doors to the same outcome and they do not look alike:
 *
 *   deactivate   is_active = 0          obviously a removal
 *   update       is_active: false       the same removal, via an edit
 *   update       role: 'medrep'         a DEMOTION — the access is just as
 *                                       gone, and nothing in the audit trail
 *                                       says "deactivated"
 *
 * The third is the one a guard written in a hurry misses, so it is tested on
 * its own rather than folded in with the others.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

let adminToken;
let adminId;
const created = [];

describe('admin accounts are protected', () => {
  beforeAll(async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = login.body.data.token;
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    adminId = admin.id;
  });

  afterAll(async () => {
    for (const id of created) {
      // Scripts have to use the escape hatch too — which is the point of it.
      await db.prepare("SELECT set_config('app.allow_admin_change', 'on', false)").get();
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
      await db.prepare("SELECT set_config('app.allow_admin_change', 'off', false)").get();
    }
    if (db.close) await db.close();
  });

  describe('through the API', () => {
    test('deactivate is refused with a readable reason', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${adminId}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_PROTECTED');
      // Not a 500 with a Postgres exception in it: the database would have
      // stopped this anyway, but an admin should be told they were prevented,
      // not shown a stack trace.
      expect(res.body.error.message).toMatch(/cannot be deactivated/i);
    });

    test('update with is_active:false is refused', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_active: false });

      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_PROTECTED');
    });

    test('DEMOTION is refused — the door that does not look like one', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'medrep' });

      expect(res.statusCode).toBe(403);
      expect(res.body.error.message).toMatch(/another role/i);

      const after = await db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(adminId);
      expect(after.role).toBe('admin');
      expect(after.is_active).toBe(1);
    });

    test('an admin cannot lock themselves out either', async () => {
      // Self-service is not an exemption. An admin acting on their own id is
      // the most likely way this happens by accident.
      const res = await request(app)
        .patch(`/api/admin/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_active: false, role: 'finance' });
      expect(res.statusCode).toBe(403);
    });

    test('non-admin users can still be deactivated', async () => {
      // The guard must be about admins, not about user management in general —
      // otherwise offboarding anybody becomes a database job.
      const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
      const email = `protect.victim.${Date.now()}@getmeds.ph`;
      await db
        .prepare(
          `INSERT INTO users (name, email, password_hash, role, is_active, created_at, approval_status)
           VALUES ('Protect Victim', ?, ?, 'medrep', 1, ?, 'approved')`
        )
        .run(email, seed.password_hash, new Date().toISOString());
      const victim = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      created.push(victim.id);

      const res = await request(app)
        .patch(`/api/admin/users/${victim.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);

      const after = await db.prepare('SELECT is_active FROM users WHERE id = ?').get(victim.id);
      expect(after.is_active).toBe(0);
    });
  });

  describe('through direct SQL — the path the API guard does not cover', () => {
    // Every repair and provisioning script connects with these same
    // credentials. A rule that lives only in a controller protects the one
    // route somebody remembered to guard, and one of those scripts deleted two
    // user rows earlier today.
    const expectBlocked = async (label, fn) => {
      await expect(fn()).rejects.toThrow(/admin account/i);
    };

    test('UPDATE cannot deactivate an admin', async () => {
      await expectBlocked('deactivate', () =>
        db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(adminId)
      );
    });

    test('UPDATE cannot demote an admin', async () => {
      await expectBlocked('demote', () =>
        db.prepare("UPDATE users SET role = 'medrep' WHERE id = ?").run(adminId)
      );
    });

    test('DELETE cannot remove an admin', async () => {
      await expectBlocked('delete', () => db.prepare('DELETE FROM users WHERE id = ?').run(adminId));

      const still = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(adminId);
      expect(still.role).toBe('admin');
    });

    test('harmless edits to an admin still work', async () => {
      // A blanket "no UPDATE on admins" would make renaming one, or changing
      // their password, a database-console job.
      const before = await db.prepare('SELECT name FROM users WHERE id = ?').get(adminId);
      await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(before.name, adminId);
      const after = await db.prepare('SELECT name, role, is_active FROM users WHERE id = ?').get(adminId);
      expect(after.role).toBe('admin');
      expect(after.is_active).toBe(1);
    });

    test('the escape hatch works, and has to be set on purpose', async () => {
      // Offboarding a real departing admin has to remain possible. It is
      // deliberate rather than convenient: a stray script does not set session
      // variables, and a person typing this has decided to.
      const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
      const email = `protect.secondadmin.${Date.now()}@getmeds.ph`;
      await db
        .prepare(
          `INSERT INTO users (name, email, password_hash, role, is_active, created_at, approval_status)
           VALUES ('Second Admin', ?, ?, 'admin', 1, ?, 'approved')`
        )
        .run(email, seed.password_hash, new Date().toISOString());
      const second = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);

      // Blocked without the flag…
      await expect(
        db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(second.id)
      ).rejects.toThrow(/admin account/i);

      // …allowed with it.
      await db.prepare("SELECT set_config('app.allow_admin_change', 'on', false)").get();
      await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(second.id);
      const off = await db.prepare('SELECT is_active FROM users WHERE id = ?').get(second.id);
      expect(off.is_active).toBe(0);

      await db.prepare('DELETE FROM users WHERE id = ?').run(second.id);
      await db.prepare("SELECT set_config('app.allow_admin_change', 'off', false)").get();

      // And the flag really is off again — a test that left it on would make
      // every later assertion in this file pass for the wrong reason.
      await expect(
        db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(adminId)
      ).rejects.toThrow(/admin account/i);
    });
  });
});
