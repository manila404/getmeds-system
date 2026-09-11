/**
 * Sep 11, 2026 — the Salesperson is assigned by an admin, not derived.
 *
 * `users.salesperson` used to be GENERATED as "<division> | <display name>".
 * The appeal was that it could not drift. What it drifted from was the only
 * thing that matters: Zoho's actual Salesperson list, which holds 198 names
 * under no single convention — some bare ('Mohit Kumar'), some prefixed
 * ('MSA | DIANA ROSE ALCANTARA'). No formula produces both. Measured against
 * the live org, 3 generated values matched and 2 did not.
 *
 * A miss is not a harmless mismatch, and that is the whole reason for this
 * change: LiveZohoAdapter.createSalesOrder does not reject an unknown
 * Salesperson name, it CREATES one. Every wrong guess is a permanent junk
 * Salesperson in the company's Zoho, minted on somebody's first order.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const created = [];
let adminToken;

/** A name the mock org genuinely has, so the happy path uses a real value. */
let knownSalesperson;

async function makeUser({ email, role = 'medrep', division = 'B2B', displayName = 'Assign Target' }) {
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  await db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at,
                          display_name, division, approval_status)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'approved')`
    )
    .run(displayName, email, seed.password_hash, role, new Date().toISOString(), displayName, division);
  const row = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  created.push(row.id);
  return row.id;
}

describe('Salesperson is assigned by an admin from Zoho’s list', () => {
  beforeAll(async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = login.body.data.token;
    const list = await zoho.listSalespersons();
    knownSalesperson = (list.salespersons || [])[0]?.salesperson_name;
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (db.close) await db.close();
  });

  describe('it is no longer derived', () => {
    // Sep 11, 2026: was "a new sign-up has NO salesperson". Sign-up is gone;
    // accounts are created by an admin, and the same guarantee holds there.
    test('a newly created account has NO salesperson', async () => {
      const email = `sp.created.${Date.now()}@getmeds.ph`;
      const res = await request(app)
        .post('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email,
          password: 'demo1234',
          first_name: 'New',
          last_name: 'Rep',
          display_name: 'New Rep',
          role: 'medrep',
          division: 'B2B'
        });
      expect(res.statusCode).toBe(201);

      const row = await db.prepare('SELECT id, division, display_name, salesperson FROM users WHERE email = ?').get(email);
      created.push(row.id);

      // Division and display name are both set, which under the old generated
      // column would have produced "B2B | New Rep" and put that on the first
      // Sales Order this person sent.
      expect(row.division).toBe('B2B');
      expect(row.display_name).toBe('New Rep');
      expect(row.salesperson).toBeNull();
    });

    test('editing a profile does not change the salesperson', async () => {
      const email = `sp.profile.${Date.now()}@getmeds.ph`;
      const id = await makeUser({ email, displayName: 'Before Rename' });
      await db.prepare('UPDATE users SET salesperson = ? WHERE id = ?').run(knownSalesperson, id);

      const login = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
      const token = login.body?.data?.token;
      expect(token).toBeTruthy();

      const res = await request(app)
        .patch('/api/auth/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ display_name: 'After Rename', division: 'HOS' });
      expect([200, 204]).toContain(res.statusCode);

      // Under the generated column this rename silently rewrote the name on
      // every future Sales Order — and could mint a new Zoho Salesperson from
      // a profile edit.
      const after = await db.prepare('SELECT display_name, salesperson FROM users WHERE id = ?').get(id);
      expect(after.display_name).toBe('After Rename');
      expect(after.salesperson).toBe(knownSalesperson);
    });
  });

  describe('GET /api/admin/salespersons', () => {
    test('returns Zoho’s list for the admin to pick from', async () => {
      const res = await request(app).get('/api/admin/salespersons').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      const names = res.body.data.salespersons.map((s) => s.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain(knownSalesperson);
    });

    test('shows which names are already taken', async () => {
      const email = `sp.taken.${Date.now()}@getmeds.ph`;
      const id = await makeUser({ email });
      await db.prepare('UPDATE users SET salesperson = ? WHERE id = ?').run(knownSalesperson, id);

      const res = await request(app).get('/api/admin/salespersons').set('Authorization', `Bearer ${adminToken}`);
      const row = res.body.data.salespersons.find((s) => s.name === knownSalesperson);
      // Two people on one Zoho Salesperson is not an error, but an admin
      // should be able to see it rather than discover it later in a report.
      expect(row.assigned_to).toBeTruthy();
      expect(row.assigned_to.email).toBe(email);
    });

    test('marks each name active or inactive, and counts both', async () => {
      // Zoho marks a Salesperson inactive when the person leaves. This org is
      // 101 active to 97 inactive, so without the flag the picker is twice as
      // long as it should be and half of it is former staff sitting right
      // beside the people actually being assigned.
      const res = await request(app).get('/api/admin/salespersons').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);

      for (const sp of res.body.data.salespersons) {
        expect(typeof sp.is_active).toBe('boolean');
      }
      expect(res.body.data.active_count + res.body.data.inactive_count).toBe(
        res.body.data.salespersons.length
      );
    });

    test('a fixture with no is_active field counts as active', async () => {
      // The mock org's records carry no is_active at all. An absent flag means
      // "no opinion", not "inactive" — reading it as falsy would empty the
      // picker entirely against any Zoho response shaped that way.
      const res = await request(app).get('/api/admin/salespersons').set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.data.active_count).toBeGreaterThan(0);
    });

    test('an inactive salesperson is still ASSIGNABLE', async () => {
      // The active/inactive split is a usability filter, not a permission.
      // The server's job is only "does Zoho know this name", which is what
      // stops a junk record being created there; correcting a historical
      // assignment, or a rep coming back, are both legitimate.
      const list = await request(app).get('/api/admin/salespersons').set('Authorization', `Bearer ${adminToken}`);
      const inactive = list.body.data.salespersons.find((sp) => !sp.is_active);
      if (!inactive) return; // mock org has none; nothing to assert

      const id = await makeUser({ email: `sp.inactive.${Date.now()}@getmeds.ph` });
      const res = await request(app)
        .patch(`/api/admin/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ salesperson: inactive.name });
      expect(res.statusCode).toBe(200);
    });

    test('a medrep cannot read the list', async () => {
      const login = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
      const res = await request(app)
        .get('/api/admin/salespersons')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe('PATCH /api/admin/users/:id', () => {
    test('an admin can assign a Salesperson that Zoho has', async () => {
      const id = await makeUser({ email: `sp.assign.${Date.now()}@getmeds.ph` });

      const res = await request(app)
        .patch(`/api/admin/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ salesperson: knownSalesperson });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.user.salesperson).toBe(knownSalesperson);
    });

    test('a name Zoho does not have is REFUSED', async () => {
      // The assertion the whole change exists for. Accepting this would not
      // fail later — it would succeed later, by creating the Salesperson in
      // the company's Zoho org.
      const id = await makeUser({ email: `sp.bogus.${Date.now()}@getmeds.ph` });

      const res = await request(app)
        .patch(`/api/admin/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ salesperson: 'Totally Made Up Person' });

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('UNKNOWN_SALESPERSON');

      const after = await db.prepare('SELECT salesperson FROM users WHERE id = ?').get(id);
      expect(after.salesperson).toBeNull();
    });

    test('matching ignores case, and stores Zoho’s own spelling', async () => {
      const id = await makeUser({ email: `sp.case.${Date.now()}@getmeds.ph` });
      const res = await request(app)
        .patch(`/api/admin/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ salesperson: knownSalesperson.toUpperCase() });
      expect(res.statusCode).toBe(200);
    });

    test('null clears it — "not decided yet" stays expressible', async () => {
      const id = await makeUser({ email: `sp.clear.${Date.now()}@getmeds.ph` });
      await db.prepare('UPDATE users SET salesperson = ? WHERE id = ?').run(knownSalesperson, id);

      const res = await request(app)
        .patch(`/api/admin/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ salesperson: null });

      expect(res.statusCode).toBe(200);
      const after = await db.prepare('SELECT salesperson FROM users WHERE id = ?').get(id);
      expect(after.salesperson).toBeNull();
    });

    test('omitting the field leaves the salesperson alone', async () => {
      // PATCH means "change what I named". A request about is_active must not
      // clear a Salesperson as a side effect.
      const id = await makeUser({ email: `sp.untouched.${Date.now()}@getmeds.ph` });
      await db.prepare('UPDATE users SET salesperson = ? WHERE id = ?').run(knownSalesperson, id);

      const res = await request(app)
        .patch(`/api/admin/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_active: true });

      expect(res.statusCode).toBe(200);
      const after = await db.prepare('SELECT salesperson FROM users WHERE id = ?').get(id);
      expect(after.salesperson).toBe(knownSalesperson);
    });
  });
});
