/**
 * POST /api/auth/register — the public sign-up endpoint added Sep 2, 2026.
 *
 * Driven over real HTTP (supertest against the wired-up Express app) rather
 * than by calling the controller with a hand-built req/res, because the whole
 * point of this endpoint is that it sits in front of the auth middleware and
 * is reachable without a token. Testing it any other way would not prove that.
 *
 * These run against the real data/getmeds.db like the rest of the suite, so
 * every account created here uses the `signup-test-` email prefix and is
 * removed in afterAll.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const EMAIL_PREFIX = 'signup-test-';
const uniqueEmail = (label = 'user') =>
  `${EMAIL_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}@getmeds.ph`;

// Sep 9, 2026: `division` was 'TEST', which is not in DIVISIONS and never has
// been — so register() answered 400 before reaching anything this suite meant
// to assert, and 19 of its tests had been failing for that reason alone. The
// spec sample it was copied from predates the fixed Division list.
//
// 'HOS' is a real Division. Sep 11, 2026: sign-up no longer derives a
// Salesperson from it — an admin assigns one from Zoho's own list — so these
// fixtures expect `salesperson` to come back NULL.
const validSignup = (overrides = {}) => ({
  first_name: 'Aaron',
  middle_name: 'Pun-an',
  last_name: 'Manila',
  display_name: 'Aaron Manila',
  division: 'HOS',
  // Sep 9, 2026: sub-division is free text and may name several — this one
  // deliberately is NOT on the HOS suggestion list, which is the behaviour
  // that changed today (see auth.controller.js's register).
  sub_division: 'sample, another',
  email: uniqueEmail(),
  password: 'correct-horse',
  ...overrides
});

afterAll(async () => {
  await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${EMAIL_PREFIX}%`);
});

/**
 * Sep 9, 2026: a freshly signed-up account cannot log in until an admin
 * approves it — that is the whole point of the change made today. The tests
 * below that are about something ELSE (the Salesperson string, role
 * enforcement) approve first so they still exercise what they are named after,
 * rather than re-testing the approval gate by accident.
 *
 * Approved directly in the database rather than through
 * POST /api/admin/users/:id/approve, deliberately: this is setup for another
 * test's subject, and routing it through the admin endpoint would make every
 * one of these fail if that endpoint broke, for reasons unrelated to what they
 * assert. The endpoint has its own coverage in tests/signupApproval.test.js.
 */
async function approve(email) {
  await db
    .prepare("UPDATE users SET approval_status = 'approved' WHERE LOWER(email) = LOWER(?)")
    .run(email);
}

describe('POST /api/auth/register', () => {
  test('creates a PENDING medrep and issues no token', async () => {
    const body = validSignup();
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toEqual(
      expect.objectContaining({
        email: body.email,
        role: 'medrep',
        first_name: 'Aaron',
        middle_name: 'Pun-an',
        last_name: 'Manila',
        display_name: 'Aaron Manila',
        division: 'HOS',
        sub_division: 'sample, another'
      })
    );
    // Sep 9, 2026: NO token. Sign-up used to sign the applicant straight in,
    // which is the thing admin approval exists to prevent — an account able to
    // raise orders before anyone confirmed the person, or the Salesperson
    // every one of their orders would send to Zoho.
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.approval_status).toBe('pending');
    expect(res.body.data.message).toMatch(/approve/i);
    // No password material comes back in the response.
    expect(res.body.data.user.password_hash).toBeUndefined();

    const row = await db
      .prepare('SELECT role, is_active, approval_status FROM users WHERE email = ?')
      .get(body.email);
    expect(row.role).toBe('medrep');
    // is_active stays 1 — the account is not DISABLED, it is unapproved. The
    // two are separate columns because they are separate situations.
    expect(row.is_active).toBe(1);
    expect(row.approval_status).toBe('pending');
  });

  /**
   * Sep 11, 2026: this block used to pin the OPPOSITE contract — that sign-up
   * produces "<division> | <display name>" and that it follows any later edit
   * to either half.
   *
   * That behaviour was removed deliberately, not broken. `users.salesperson`
   * was a generated column, and what it generated did not reliably exist in
   * Zoho: the org's list holds 198 names under no single convention, some bare
   * ('Mohit Kumar'), some prefixed ('MSA | DIANA ROSE ALCANTARA'). Measured
   * against the live org, 3 of this system's generated values matched a real
   * Salesperson and 2 did not.
   *
   * And a miss does not fail. LiveZohoAdapter.createSalesOrder CREATES an
   * unknown Salesperson rather than rejecting it, so every wrong guess became
   * a permanent junk record in the company's Zoho, minted on someone's first
   * order — or, via the old profile-edit behaviour, on a rename.
   *
   * So the assertions are inverted on purpose: sign-up must now leave this
   * empty, and an admin fills it in from Zoho's list (see
   * salespersonAssignment.test.js).
   */
  describe('the Salesperson string is NOT derived at sign-up', () => {
    test('a new account has no salesperson, even with division and display name set', async () => {
      const body = validSignup();
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      // Both halves of the old formula are present and correct...
      const row = await db
        .prepare('SELECT division, display_name, salesperson FROM users WHERE email = ?')
        .get(body.email);
      expect(row.division).toBe('HOS');
      expect(row.display_name).toBe('Aaron Manila');
      // ...and it still produces nothing, because nobody has said who this
      // person is in Zoho yet. NULL is the honest answer.
      expect(row.salesperson).toBeNull();
      expect(res.body.data.user.salesperson).toBeNull();
    });

    test('changing division or display_name does NOT invent one', async () => {
      const body = validSignup();
      await request(app).post('/api/auth/register').send(body);

      await db.prepare('UPDATE users SET division = ? WHERE email = ?').run('B2B', body.email);
      await db.prepare('UPDATE users SET display_name = ? WHERE email = ?').run('A. Manila', body.email);

      const row = await db.prepare('SELECT salesperson FROM users WHERE email = ?').get(body.email);
      expect(row.salesperson).toBeNull();
    });

    test('an admin-assigned salesperson survives a later profile change', async () => {
      // The other half of the same guarantee. Under the generated column a
      // rename silently rewrote the name on every future Sales Order.
      const body = validSignup();
      await request(app).post('/api/auth/register').send(body);
      await db
        .prepare('UPDATE users SET salesperson = ? WHERE email = ?')
        .run('NORTH | Juan dela Cruz', body.email);

      await db.prepare('UPDATE users SET division = ?, display_name = ? WHERE email = ?')
        .run('B2B', 'Someone Else', body.email);

      const row = await db.prepare('SELECT salesperson FROM users WHERE email = ?').get(body.email);
      expect(row.salesperson).toBe('NORTH | Juan dela Cruz');
    });

    // The New Order form reads user.salesperson straight off the session, so
    // both ways of establishing one have to carry it — including carrying the
    // absence of one, which is what tells the form to say so.
    test('login and /api/auth/me both carry whatever it is', async () => {
      const body = validSignup();
      await request(app).post('/api/auth/register').send(body);
      await approve(body.email);

      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: body.email, password: body.password });
      expect(login.status).toBe(200);
      expect(login.body.data.user.salesperson).toBeNull();

      await db
        .prepare('UPDATE users SET salesperson = ? WHERE email = ?')
        .run('NORTH | Maria Santos', body.email);

      const me = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.salesperson).toBe('NORTH | Maria Santos');
    });

    test('is NULL for an account with no division either', async () => {
      await db
        .prepare(
          `INSERT INTO users (name, email, password_hash, role)
           VALUES ('No Mapping', 'signup-test-no-division@getmeds.ph', 'x', 'medrep')`
        )
        .run();
      const row = await db
        .prepare("SELECT id, salesperson FROM users WHERE email = 'signup-test-no-division@getmeds.ph'")
        .get();
      try {
        expect(row.salesperson).toBeNull();
      } finally {
        await db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
      }
    });
  });

  describe('name fields', () => {
    test('display_name falls back to "first last" when the client omits it', async () => {
      const body = validSignup();
      delete body.display_name;

      const res = await request(app).post('/api/auth/register').send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.user.display_name).toBe('Aaron Manila');
      // display_name no longer feeds the Salesperson — see the block below.
      expect(res.body.data.user.salesperson).toBeNull();
    });

    test('display_name is kept when it differs from first + last', async () => {
      const body = validSignup({ display_name: 'Bong Manila' });
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.user.display_name).toBe('Bong Manila');
      expect(res.body.data.user.salesperson).toBeNull();
    });

    // Everything already on screen reads user.name, so it has to stay useful.
    test('users.name mirrors the display name', async () => {
      const body = validSignup({ display_name: 'Bong Manila' });
      await request(app).post('/api/auth/register').send(body);

      expect((await db.prepare('SELECT name FROM users WHERE email = ?').get(body.email)).name).toBe('Bong Manila');
    });

    test('middle_name and sub_division are optional and stored as NULL when blank', async () => {
      const body = validSignup({ middle_name: '', sub_division: '' });
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      const row = await db.prepare('SELECT middle_name, sub_division FROM users WHERE email = ?').get(body.email);
      expect(row.middle_name).toBeNull();
      expect(row.sub_division).toBeNull();
      expect(res.body.data.user.salesperson).toBeNull();
    });
  });

  describe('required fields', () => {
    test.each([
      ['first_name', 'first name'],
      ['last_name', 'last name'],
      ['division', 'division'],
      ['email', 'email'],
      ['password', 'password']
    ])('rejects a missing %s with 400 and names it, creating nothing', async (field, label) => {
      const body = validSignup();
      const email = body.email;
      delete body[field];

      const res = await request(app).post('/api/auth/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain(label);
      expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined();
    });

    // Dropping both name parts leaves nothing for display_name to fall back to.
    test('rejects when first and last name are both missing', async () => {
      const body = validSignup();
      delete body.first_name;
      delete body.last_name;
      delete body.display_name;

      const res = await request(app).post('/api/auth/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toEqual(expect.arrayContaining(['first name', 'last name', 'display name']));
    });
  });

  test('the new account can log in with the password it signed up with', async () => {
    const body = validSignup({ password: 'another-good-one' });
    await request(app).post('/api/auth/register').send(body);

    await approve(body.email);
    const res = await request(app).post('/api/auth/login').send({ email: body.email, password: 'another-good-one' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('medrep');
  });

  // The security property that matters most: role is not a caller input.
  test('a role in the request body is ignored — an admin sign-up is still a medrep', async () => {
    const body = validSignup({ role: 'admin' });
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('medrep');
    expect((await db.prepare('SELECT role FROM users WHERE email = ?').get(body.email)).role).toBe('medrep');
  });

  test('a salesperson in the request body is ignored — it is an admin’s decision', async () => {
    // Still ignored, and now for a stronger reason than "it is derived". A
    // self-declared Salesperson that Zoho does not know would be CREATED there
    // on this person’s first order, so accepting one at sign-up would let
    // anybody add a record to the company’s Zoho org by typing it into a
    // registration form.
    const body = validSignup({ salesperson: 'ADMIN | Somebody Else' });
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.user.salesperson).toBeNull();

    const row = await db.prepare('SELECT salesperson FROM users WHERE email = ?').get(body.email);
    expect(row.salesperson).toBeNull();
  });

  test('rejects an email outside the allowed domain and creates nothing', async () => {
    const email = `${EMAIL_PREFIX}outsider-${Date.now()}@gmail.com`;
    const res = await request(app).post('/api/auth/register').send(validSignup({ email }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    expect(res.body.error.message).toContain('@getmeds.ph');
    expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined();
  });

  test('rejects a password shorter than 8 characters and creates nothing', async () => {
    const body = validSignup({ password: 'abc123' });
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
  });

  test('rejects a malformed email', async () => {
    const res = await request(app).post('/api/auth/register').send(validSignup({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a second sign-up with the same email returns 409 and does not duplicate the user', async () => {
    const body = validSignup();
    const first = await request(app).post('/api/auth/register').send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/auth/register')
      .send(validSignup({ email: body.email, first_name: 'Someone', last_name: 'Else', display_name: 'Someone Else' }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EMAIL_IN_USE');

    expect((await db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(body.email)).c).toBe(1);
    // The first sign-up's details survive — the second did not overwrite them.
    expect((await db.prepare('SELECT display_name FROM users WHERE email = ?').get(body.email)).display_name)
      .toBe('Aaron Manila');
  });

  test('email is trimmed and lower-cased, and the duplicate check sees through case', async () => {
    const email = uniqueEmail('case');
    const shouted = `  ${email.toUpperCase()}  `;

    const res = await request(app).post('/api/auth/register').send(validSignup({ email: shouted }));
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(email);

    const again = await request(app).post('/api/auth/register').send(validSignup({ email }));
    expect(again.status).toBe(409);
  });

  test('SIGNUP_ENABLED=false turns the endpoint off with 403 SIGNUP_DISABLED', async () => {
    const previous = process.env.SIGNUP_ENABLED;
    process.env.SIGNUP_ENABLED = 'false';
    try {
      const body = validSignup();
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SIGNUP_DISABLED');
      expect(await db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.SIGNUP_ENABLED;
      else process.env.SIGNUP_ENABLED = previous;
    }
  });

  test('SIGNUP_ALLOWED_EMAIL_DOMAINS widens the allow-list', async () => {
    const previous = process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS;
    process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS = 'getmeds.ph, partner-clinic.ph';
    try {
      const email = `${EMAIL_PREFIX}partner-${Date.now()}@partner-clinic.ph`;
      const res = await request(app).post('/api/auth/register').send(validSignup({ email }));
      expect(res.status).toBe(201);
      expect(res.body.data.user.role).toBe('medrep');
    } finally {
      if (previous === undefined) delete process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS;
      else process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS = previous;
    }
  });

  // Sign-up must not be a way to reach anything a medrep cannot already reach.
  //
  // Sep 9, 2026: this used to read a token straight off the register response.
  // That response has no token any more, so it was sending "Bearer undefined"
  // and getting its 403 for the wrong reason entirely — it would have passed
  // just as well if admin routes were wide open to every medrep. The account
  // is approved and logged in properly first, so the 403 is now about the ROLE.
  test('a signed-up medrep is still refused admin-only endpoints', async () => {
    const body = validSignup();
    await request(app).post('/api/auth/register').send(body);
    await approve(body.email);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: body.email, password: body.password });
    expect(login.status).toBe(200);

    const admin = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(admin.status).toBe(403);
  });

  /**
   * Sep 11, 2026: the approval queue, as something an admin can be told about
   * rather than something they have to go and look for.
   *
   * Sign-up creates an account that cannot log in until approved, and the only
   * place that was visible was the User Management page. A new rep therefore
   * waited as long as it took somebody to wander onto a screen an admin opens
   * once a month -- while the rep, reasonably, assumed the system was broken.
   */
  describe('GET /api/admin/users/pending', () => {
    test('reports who is waiting, newest first', async () => {
      const older = validSignup();
      await request(app).post('/api/auth/register').send(older);
      const newer = validSignup();
      await request(app).post('/api/auth/register').send(newer);

      // The older one must not look newer just because it was created in the
      // same millisecond as the other.
      await db
        .prepare("UPDATE users SET created_at = '2020-01-01T00:00:00.000Z' WHERE email = ?")
        .run(older.email);

      const login = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
      const res = await request(app)
        .get('/api/admin/users/pending')
        .set('Authorization', `Bearer ${login.body.data.token}`);

      expect(res.statusCode).toBe(200);
      const emails = res.body.data.users.map((u) => u.email);
      expect(emails).toContain(older.email);
      expect(emails).toContain(newer.email);
      expect(emails.indexOf(newer.email)).toBeLessThan(emails.indexOf(older.email));
      expect(res.body.data.count).toBe(res.body.data.users.length);
    });

    test('an approved account drops off the queue', async () => {
      const body = validSignup();
      await request(app).post('/api/auth/register').send(body);
      await approve(body.email);

      const login = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
      const res = await request(app)
        .get('/api/admin/users/pending')
        .set('Authorization', `Bearer ${login.body.data.token}`);

      expect(res.body.data.users.map((u) => u.email)).not.toContain(body.email);
    });

    test('it is not shadowed by the /users/:id routes', async () => {
      // Express matches in declaration order, so '/users/pending' registered
      // after a '/users/:id' route would be read as "the user whose id is
      // pending" -- a 404 or a cast error that looks like a missing feature
      // rather than a routing mistake.
      const login = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
      const res = await request(app)
        .get('/api/admin/users/pending')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data.users)).toBe(true);
    });

    test('a medrep cannot read it', async () => {
      const login = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
      const res = await request(app)
        .get('/api/admin/users/pending')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect([401, 403]).toContain(res.statusCode);
    });
  });
});
