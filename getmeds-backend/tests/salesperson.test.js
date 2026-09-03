/**
 * The MedRep -> Zoho Salesperson mapping, added Sep 2, 2026.
 *
 * "Salesperson" is a MANDATORY field on every Sales Order in this Zoho org
 * and is matched by NAME, so three things have to hold and each is covered
 * here:
 *
 *   1. The name that goes out is the ORDER'S MedRep, not whoever is clicking.
 *   2. A missing mapping falls back to the old TEST | MEDREP stand-in for
 *      TestGM- orders only, and to nothing for a real one.
 *   3. "Zoho has never heard of this name" and "we could not ask Zoho" are
 *      different answers, because the order form says different things.
 *
 * Runs in mock mode (tests/setupEnv.js sets ZOHO_MODE=mock), so nothing here
 * opens a socket.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
const salespersonService = require('../src/services/salespersonService');

const EMAIL_PREFIX = 'salesperson-test-';
const uniqueEmail = (label) => `${EMAIL_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}@getmeds.ph`;

const signUp = (overrides = {}) =>
  request(app)
    .post('/api/auth/register')
    .send({
      first_name: 'Aaron',
      middle_name: 'Pun-an',
      last_name: 'Manila',
      display_name: 'Aaron Manila',
      division: 'TEST',
      sub_division: 'sample',
      email: uniqueEmail('rep'),
      password: 'long-enough-pw',
      ...overrides
    });

beforeEach(() => salespersonService.clearCache());

afterAll(async () => {
  await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${EMAIL_PREFIX}%`);
  salespersonService.clearCache();
});

describe('salespersonService.forUser', () => {
  test('returns the generated "<division> | <display name>" for a signed-up rep', async () => {
    const res = await signUp();
    expect(await salespersonService.forUser(res.body.data.user.id)).toBe('TEST | Aaron Manila');
  });

  test('returns null for an account with no division — nothing to attribute to', async () => {
    // Sep 2, 2026 (2): this used to read admin@getmeds.ph, on the reasoning
    // that the seeded logins predate these fields. They no longer do —
    // seed.js gives all six a division and display name, because an account
    // without a mapping can no longer place an order at all. So the case is
    // made explicitly instead of borrowed from the seed.
    const id = (await db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ('No Mapping', ?, 'x', 'medrep')`
      )
      .run(`${EMAIL_PREFIX}no-division@getmeds.ph`)).lastInsertRowid;
    try {
      expect(await salespersonService.forUser(id)).toBeNull();
    } finally {
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    expect(await salespersonService.forUser(null)).toBeNull();
    expect(await salespersonService.forUser(999999)).toBeNull();
  });
});

describe('salespersonService.verify', () => {
  test('exists: true when Zoho has the name', async () => {
    const result = await salespersonService.verify('TEST | Aaron Manila');
    expect(result).toEqual(expect.objectContaining({ checked: true, exists: true }));
  });

  test('exists: false when Zoho answered and does not have it', async () => {
    const result = await salespersonService.verify('NOPE | Nobody At All');
    expect(result).toEqual(expect.objectContaining({ checked: true, exists: false }));
  });

  test('matches case- and spacing-insensitively', async () => {
    const result = await salespersonService.verify('  test  |  AARON MANILA ');
    expect(result.exists).toBe(true);
    expect(result.matchedName).toBe('TEST | Aaron Manila');
  });

  // The distinction the order-form banner depends on.
  test('an unreachable Zoho is checked:false / exists:null — NOT "does not exist"', async () => {
    const original = Object.getOwnPropertyDescriptor(zoho, 'listSalespersons');
    zoho.listSalespersons = async () => { throw new Error('ECONNREFUSED'); };
    try {
      const result = await salespersonService.verify('TEST | Aaron Manila');
      expect(result.checked).toBe(false);
      expect(result.exists).toBeNull();
      expect(result.reason).toBe('ZOHO_UNREACHABLE');
    } finally {
      if (original) Object.defineProperty(zoho, 'listSalespersons', original);
      else delete zoho.listSalespersons;
      salespersonService.clearCache();
    }
  });

  test('no mapping at all is its own answer, and asks Zoho nothing', async () => {
    let called = false;
    const original = Object.getOwnPropertyDescriptor(zoho, 'listSalespersons');
    zoho.listSalespersons = async () => { called = true; return { salespersons: [] }; };
    try {
      const result = await salespersonService.verify(null);
      expect(result).toEqual(expect.objectContaining({ checked: false, exists: null, reason: 'NO_SALESPERSON' }));
      expect(called).toBe(false);
    } finally {
      if (original) Object.defineProperty(zoho, 'listSalespersons', original);
      else delete zoho.listSalespersons;
      salespersonService.clearCache();
    }
  });

  test('the list is cached — a second verify does not re-read Zoho', async () => {
    let reads = 0;
    const original = Object.getOwnPropertyDescriptor(zoho, 'listSalespersons');
    zoho.listSalespersons = async () => {
      reads += 1;
      return { salespersons: [{ salesperson_id: '1', salesperson_name: 'TEST | Aaron Manila' }] };
    };
    try {
      salespersonService.clearCache();
      await salespersonService.verify('TEST | Aaron Manila');
      await salespersonService.verify('TEST | Someone Else');
      expect(reads).toBe(1);

      await salespersonService.verify('TEST | Aaron Manila', { force: true });
      expect(reads).toBe(2);
    } finally {
      if (original) Object.defineProperty(zoho, 'listSalespersons', original);
      else delete zoho.listSalespersons;
      salespersonService.clearCache();
    }
  });
});

describe('GET /api/orders/meta/salesperson', () => {
  const login = async (email, password) => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    return res.body.data.token;
  };

  test('reports a verified mapping for a signed-up rep', async () => {
    const body = { email: uniqueEmail('ok'), password: 'long-enough-pw' };
    await signUp(body);
    const token = await login(body.email, body.password);

    const res = await request(app).get('/api/orders/meta/salesperson').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({ salesperson: 'TEST | Aaron Manila', checked: true, exists: true })
    );
  });

  test('reports exists:false for a division Zoho does not know', async () => {
    const body = { email: uniqueEmail('unknown'), password: 'long-enough-pw', division: 'NOPE' };
    await signUp(body);
    const token = await login(body.email, body.password);

    const res = await request(app).get('/api/orders/meta/salesperson').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.salesperson).toBe('NOPE | Aaron Manila');
    expect(res.body.data.exists).toBe(false);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/orders/meta/salesperson');
    expect(res.status).toBe(401);
  });
});

describe('what actually reaches the Sales Order', () => {
  const adapter = () => new MockZohoAdapter({ log: () => {} });

  test("sends the rep's own salesperson when they have one", async () => {
    const res = await adapter().createSalesOrder({
      getmeds_order_id: 'GM-20260902-0001',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      salesperson_name: 'TEST | Aaron Manila'
    });
    expect(res.salesorder.salesperson_name).toBe('TEST | Aaron Manila');
  });

  test("a rep's own salesperson beats the stand-in, even on a TestGM- order", async () => {
    const res = await adapter().createSalesOrder({
      getmeds_order_id: 'TestGM-20260902-0001',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      salesperson_name: 'TEST | Aaron Manila'
    });
    expect(res.salesorder.salesperson_name).toBe('TEST | Aaron Manila');
  });

  // Sep 2, 2026 (2): these three used to assert that a missing mapping was
  // survivable — the TestGM- stand-in for test orders, nothing at all for
  // real ones. Both are gone, because the premise underneath them was
  // wrong: Zoho does not reject an unknown Salesperson name, it CREATES
  // one, and "TEST | MEDREP" plus two junk entries in org 714292728 are
  // the evidence. An unresolvable mapping is now refused before anything
  // is sent.
  test('a TestGM- order with no mapping is refused, not stamped with a stand-in', async () => {
    await expect(
      adapter().createSalesOrder({
        getmeds_order_id: 'TestGM-20260902-0002',
        customer_name: 'Client',
        zoho_customer_id: 'ZC-1',
        total_amount: 100,
        items: [],
        salesperson_name: null
      })
    ).rejects.toMatchObject({ code: 'SALESPERSON_NOT_FOUND' });
  });

  test('a real order with no mapping is refused rather than sent without one', async () => {
    await expect(
      adapter().createSalesOrder({
        getmeds_order_id: 'GM-20260902-0002',
        customer_name: 'Client',
        zoho_customer_id: 'ZC-1',
        total_amount: 100,
        items: [],
        salesperson_name: null
      })
    ).rejects.toMatchObject({ code: 'SALESPERSON_NOT_FOUND' });
  });

  test('blank-but-present is treated as no mapping, not as a blank name', async () => {
    await expect(
      adapter().createSalesOrder({
        getmeds_order_id: 'TestGM-20260902-0003',
        customer_name: 'Client',
        zoho_customer_id: 'ZC-1',
        total_amount: 100,
        items: [],
        salesperson_name: '   '
      })
    ).rejects.toMatchObject({ code: 'SALESPERSON_NOT_FOUND' });
  });

  test('a name Zoho does not have is refused — this is what stops Zoho creating it', async () => {
    await expect(
      adapter().createSalesOrder({
        getmeds_order_id: 'GM-20260902-0004',
        customer_name: 'Client',
        zoho_customer_id: 'ZC-1',
        total_amount: 100,
        items: [],
        salesperson_name: 'NOPE | Nobody At All'
      })
    ).rejects.toMatchObject({ code: 'SALESPERSON_NOT_FOUND' });
  });

  test('what goes out is the resolved id, and never a free-text name', async () => {
    const res = await adapter().createSalesOrder({
      getmeds_order_id: 'GM-20260902-0005',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      salesperson_name: '  test  |  AARON MANILA '
    });
    // Case and spacing tolerated on the way in; the id is what identifies
    // the rep on the Sales Order.
    expect(res.salesorder.salesperson_id).toBe('MOCK-SP-2');
    expect(res.salesorder.salesperson_name).toBe('TEST | Aaron Manila');
  });
});

// Sep 2, 2026: Division and Sub-division ride along with the Salesperson as
// their own Zoho custom fields (cf_division / cf_sub_division).
describe('Division and Sub-division on the Sales Order', () => {
  const adapter = () => new MockZohoAdapter({ log: () => {} });
  const cf = (so, label) => (so.custom_fields || []).find((f) => f.label === label);

  const create = (overrides = {}) =>
    adapter().createSalesOrder({
      getmeds_order_id: 'GM-20260902-0100',
      customer_name: 'Client',
      zoho_customer_id: 'ZC-1',
      total_amount: 100,
      items: [],
      // Division and Salesperson are independent fields, but an order
      // still needs a resolvable rep to be created at all — these tests
      // are about the custom fields, not about the refusal.
      salesperson_name: 'TEST | Aaron Manila',
      ...overrides
    });

  test('both are sent when the rep has both', async () => {
    const res = await create({ division: 'TEST', sub_division: 'sample' });
    expect(cf(res.salesorder, 'Division').value).toBe('TEST');
    expect(cf(res.salesorder, 'Sub-division').value).toBe('sample');
  });

  test('a blank sub-division is omitted rather than sent empty', async () => {
    const res = await create({ division: 'TEST', sub_division: null });
    expect(cf(res.salesorder, 'Division').value).toBe('TEST');
    // Omitted, not blank — an empty custom field would overwrite whatever
    // Zoho already holds.
    expect(cf(res.salesorder, 'Sub-division')).toBeUndefined();
  });

  test('neither is sent for an account that has no division', async () => {
    const res = await create({ division: null, sub_division: null });
    expect(cf(res.salesorder, 'Division')).toBeUndefined();
    expect(cf(res.salesorder, 'Sub-division')).toBeUndefined();
  });

  // The three are read from one row on purpose — reading them separately is
  // how a rep's Salesperson could end up describing a different division
  // than the Division field beside it.
  test('they come from the same account as the Salesperson', async () => {
    const res = await signUp();
    const profile = await salespersonService.profileForUser(res.body.data.user.id);
    expect(profile).toEqual({
      salesperson: 'TEST | Aaron Manila',
      division: 'TEST',
      sub_division: 'sample'
    });
  });

  test('profileForUser is all-null for an account that has none', async () => {
    // Explicitly created: the seeded logins all carry a mapping now.
    const id = (await db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ('No Mapping', ?, 'x', 'medrep')`
      )
      .run(`${EMAIL_PREFIX}no-profile@getmeds.ph`)).lastInsertRowid;
    try {
      expect(await salespersonService.profileForUser(id)).toEqual({
        salesperson: null,
        division: null,
        sub_division: null
      });
    } finally {
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    expect(await salespersonService.profileForUser(null)).toEqual({
      salesperson: null,
      division: null,
      sub_division: null
    });
  });
});

describe('the adapter contract stays read-only', () => {
  test('listSalespersons exists on the mock and returns names', async () => {
    const res = await zoho.listSalespersons();
    expect(Array.isArray(res.salespersons)).toBe(true);
    expect(res.salespersons.map((s) => s.salesperson_name)).toContain('TEST | MEDREP');
  });

  // Adding a read must not have added a write. If a createSalesperson ever
  // appears on this contract it should be a deliberate, reviewed decision —
  // this fails the moment one shows up by accident.
  test('no method exists that could create or edit a Zoho salesperson', () => {
    const surface = new Set();
    for (let o = zoho; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      Object.getOwnPropertyNames(o).forEach((n) => surface.add(n));
    }
    for (const name of surface) {
      expect(name).not.toMatch(/^(create|update|edit|delete|remove)Salesperson/i);
    }
  });
});
