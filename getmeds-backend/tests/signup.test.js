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

// The sample from the spec, so the expected Salesperson string below is the
// exact one that was asked for: "TEST | Aaron Manila".
const validSignup = (overrides = {}) => ({
  first_name: 'Aaron',
  middle_name: 'Pun-an',
  last_name: 'Manila',
  display_name: 'Aaron Manila',
  division: 'TEST',
  sub_division: 'sample',
  email: uniqueEmail(),
  password: 'correct-horse',
  ...overrides
});

afterAll(() => {
  db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${EMAIL_PREFIX}%`);
});

describe('POST /api/auth/register', () => {
  test('creates an active medrep and returns a token that works immediately', async () => {
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
        division: 'TEST',
        sub_division: 'sample'
      })
    );
    expect(res.body.data.token).toEqual(expect.any(String));
    // No password material comes back in the response.
    expect(res.body.data.user.password_hash).toBeUndefined();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(body.email);

    const row = db.prepare('SELECT role, is_active FROM users WHERE email = ?').get(body.email);
    expect(row.role).toBe('medrep');
    expect(row.is_active).toBe(1);
  });

  describe('the Salesperson string', () => {
    test('is "<division> | <display name>" in both the response and the database', async () => {
      const body = validSignup();
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.user.salesperson).toBe('TEST | Aaron Manila');
      expect(db.prepare('SELECT salesperson FROM users WHERE email = ?').get(body.email).salesperson)
        .toBe('TEST | Aaron Manila');
    });

    // The point of making it a GENERATED column rather than a stored string:
    // change either half and it follows, with no code involved.
    test('follows a later change to division or display_name — it cannot go stale', async () => {
      const body = validSignup();
      await request(app).post('/api/auth/register').send(body);

      db.prepare('UPDATE users SET division = ? WHERE email = ?').run('NORTH', body.email);
      expect(db.prepare('SELECT salesperson FROM users WHERE email = ?').get(body.email).salesperson)
        .toBe('NORTH | Aaron Manila');

      db.prepare('UPDATE users SET display_name = ? WHERE email = ?').run('A. Manila', body.email);
      expect(db.prepare('SELECT salesperson FROM users WHERE email = ?').get(body.email).salesperson)
        .toBe('NORTH | A. Manila');
    });

    // The New Order form reads user.salesperson straight off the session, so
    // both ways of establishing one have to carry it — otherwise the field
    // there is silently blank until the next full page load.
    test('login and /api/auth/me both carry it', async () => {
      const body = validSignup();
      await request(app).post('/api/auth/register').send(body);

      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: body.email, password: body.password });
      expect(login.status).toBe(200);
      expect(login.body.data.user.salesperson).toBe('TEST | Aaron Manila');

      const me = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.data.token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.salesperson).toBe('TEST | Aaron Manila');
    });

    test('is NULL for an account with no division', () => {
      // Sep 2, 2026 (2): this used to point at the seeded logins, which
      // carried no mapping because they predated these fields. seed.js now
      // gives all six one — an account without a mapping cannot place an
      // order, since Salesperson is mandatory in this Zoho org. The case
      // still needs covering, so it is made here rather than assumed.
      const id = db
        .prepare(
          `INSERT INTO users (name, email, password_hash, role)
           VALUES ('No Mapping', 'signup-test-no-division@getmeds.ph', 'x', 'medrep')`
        )
        .run().lastInsertRowid;
      try {
        const row = db.prepare('SELECT salesperson FROM users WHERE id = ?').get(id);
        expect(row.salesperson).toBeNull();
      } finally {
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      }
    });

    test('surrounding whitespace on either part is trimmed out of it', async () => {
      const body = validSignup({ division: '  TEST  ', display_name: '  Aaron Manila  ' });
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.user.salesperson).toBe('TEST | Aaron Manila');
    });
  });

  describe('name fields', () => {
    test('display_name falls back to "first last" when the client omits it', async () => {
      const body = validSignup();
      delete body.display_name;

      const res = await request(app).post('/api/auth/register').send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.user.display_name).toBe('Aaron Manila');
      expect(res.body.data.user.salesperson).toBe('TEST | Aaron Manila');
    });

    test('display_name is kept when it differs from first + last', async () => {
      const body = validSignup({ display_name: 'Bong Manila' });
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      expect(res.body.data.user.display_name).toBe('Bong Manila');
      expect(res.body.data.user.salesperson).toBe('TEST | Bong Manila');
    });

    // Everything already on screen reads user.name, so it has to stay useful.
    test('users.name mirrors the display name', async () => {
      const body = validSignup({ display_name: 'Bong Manila' });
      await request(app).post('/api/auth/register').send(body);

      expect(db.prepare('SELECT name FROM users WHERE email = ?').get(body.email).name).toBe('Bong Manila');
    });

    test('middle_name and sub_division are optional and stored as NULL when blank', async () => {
      const body = validSignup({ middle_name: '', sub_division: '' });
      const res = await request(app).post('/api/auth/register').send(body);

      expect(res.status).toBe(201);
      const row = db.prepare('SELECT middle_name, sub_division FROM users WHERE email = ?').get(body.email);
      expect(row.middle_name).toBeNull();
      expect(row.sub_division).toBeNull();
      // A missing sub-division must not break the salesperson string.
      expect(res.body.data.user.salesperson).toBe('TEST | Aaron Manila');
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
      expect(db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined();
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
    expect(db.prepare('SELECT role FROM users WHERE email = ?').get(body.email).role).toBe('medrep');
  });

  test('a salesperson in the request body is ignored — it is derived, not accepted', async () => {
    const body = validSignup({ salesperson: 'ADMIN | Somebody Else' });
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.user.salesperson).toBe('TEST | Aaron Manila');
  });

  test('rejects an email outside the allowed domain and creates nothing', async () => {
    const email = `${EMAIL_PREFIX}outsider-${Date.now()}@gmail.com`;
    const res = await request(app).post('/api/auth/register').send(validSignup({ email }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    expect(res.body.error.message).toContain('@getmeds.ph');
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeUndefined();
  });

  test('rejects a password shorter than 8 characters and creates nothing', async () => {
    const body = validSignup({ password: 'abc123' });
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
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

    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(body.email).c).toBe(1);
    // The first sign-up's details survive — the second did not overwrite them.
    expect(db.prepare('SELECT display_name FROM users WHERE email = ?').get(body.email).display_name)
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
      expect(db.prepare('SELECT id FROM users WHERE email = ?').get(body.email)).toBeUndefined();
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
  test('a signed-up medrep is still refused admin-only endpoints', async () => {
    const res = await request(app).post('/api/auth/register').send(validSignup());
    const token = res.body.data.token;

    const admin = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${token}`);
    expect(admin.status).toBe(403);
  });
});
