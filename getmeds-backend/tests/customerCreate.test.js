/**
 * Sep 11, 2026 — creating a customer that does not exist yet, mid-order.
 *
 * A MedRep taking an order from a pharmacy Zoho had never seen could not place
 * it at all: the form only picks existing contacts, createSalesOrder needs a
 * Zoho contact id, and getting one meant asking somebody else and waiting.
 *
 * This is the FOURTH write this app can make to Zoho, and the first that
 * creates a contact — a permanent record in the company's org. So the tests
 * below are weighted towards the things that must NOT happen: a duplicate
 * created because nobody looked, and a local row that survives a Zoho refusal.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const created = { customers: [] };
let medrepToken;
let adminToken;

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const validCustomer = (overrides = {}) => ({
  display_name: `Test Pharmacy ${uniq()}`,
  first_name: 'Maria',
  last_name: 'Santos',
  email: 'maria@example.ph',
  phone: '+639171234567',
  contact_number: '+639171234567',
  billing_address: { address: '123 Taft Ave', city: 'Manila', phone: '+639171234567' },
  shipping_same_as_billing: true,
  ...overrides
});

async function cleanup(name) {
  const row = await db.prepare('SELECT id FROM customers WHERE name = ?').get(name);
  if (row) created.customers.push(row.id);
}

describe('creating a customer from the order form', () => {
  beforeAll(async () => {
    const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrep.body.data.token;
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;
  });

  afterAll(async () => {
    for (const id of created.customers) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    if (db.close) await db.close();
  });

  const create = (token, body) =>
    request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send(body);

  describe('who may do it', () => {
    test('a MedRep can — that is the whole point', async () => {
      const body = validCustomer();
      const res = await create(medrepToken, body);
      expect(res.statusCode).toBe(201);
      expect(res.body.data.customer.zoho_contact_id).toBeTruthy();
      await cleanup(body.display_name);
    });

    test('finance cannot — they work orders, they do not open accounts', async () => {
      const fin = await request(app).post('/api/auth/login').send({ email: 'finance@getmeds.ph', password: 'demo123' });
      if (!fin.body?.data?.token) return;
      const res = await create(fin.body.data.token, validCustomer());
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe('the duplicate block', () => {
    test('a matching NAME blocks, and hands back the existing customer', async () => {
      // The check Zoho will never make for us: it happily holds three contacts
      // called "Mercury Drug Taft", and nobody notices until someone is
      // reconciling invoices.
      const body = validCustomer();
      const first = await create(medrepToken, body);
      expect(first.statusCode).toBe(201);
      await cleanup(body.display_name);

      const second = await create(medrepToken, validCustomer({ display_name: body.display_name }));
      expect(second.statusCode).toBe(409);
      expect(second.body.error.code).toBe('CUSTOMER_EXISTS');
      expect(second.body.error.duplicates.length).toBeGreaterThan(0);
      // Enough to actually select it, not just be told it exists.
      expect(second.body.error.duplicates[0].zoho_contact_id).toBeTruthy();
      expect(second.body.error.duplicates[0].matched_on).toBe('name');
    });

    test('a matching LTO LICENCE blocks, even under a different name', async () => {
      // Zoho enforces this one with a unique index, but its refusal names the
      // field and not the contact already holding the licence — so the rep
      // learns "already exists" and still cannot find who. Answering locally
      // gives them the pharmacy to pick.
      const licence = `LTO-${uniq()}`;
      const first = validCustomer({ lto_license_number: licence });
      expect((await create(medrepToken, first)).statusCode).toBe(201);
      await cleanup(first.display_name);

      const second = validCustomer({ lto_license_number: licence });
      const res = await create(medrepToken, second);
      expect(res.statusCode).toBe(409);
      expect(res.body.error.duplicates[0].matched_on).toBe('licence');
    });

    test('a blocked create writes NOTHING, locally or in Zoho', async () => {
      const body = validCustomer();
      expect((await create(medrepToken, body)).statusCode).toBe(201);
      await cleanup(body.display_name);

      const before = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
      const spy = jest.spyOn(zoho, 'createContact');
      try {
        const res = await create(medrepToken, validCustomer({ display_name: body.display_name }));
        expect(res.statusCode).toBe(409);
        // Refused before Zoho was asked. A create attempt that Zoho then
        // rejects still costs an API call and, worse, might succeed.
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const after = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
      expect(after).toBe(before);
    });

    test('a duplicate comes back as a WHOLE customer, not a summary', async () => {
      // It is handed to the order form to be selected, and the form reads more
      // than a name off it: `category` decides whether the hospital rules
      // apply (GL Number, receiver type, four attachments). A slim projection
      // made a hospital customer picked from the duplicate list behave like an
      // ordinary one, with nothing on screen to say a control had been skipped.
      const body = validCustomer();
      expect((await create(medrepToken, body)).statusCode).toBe(201);
      await cleanup(body.display_name);

      const row = await db.prepare('SELECT id FROM customers WHERE name = ?').get(body.display_name);
      await db.prepare("UPDATE customers SET category = 'hospital' WHERE id = ?").run(row.id);

      const res = await create(medrepToken, validCustomer({ display_name: body.display_name }));
      expect(res.statusCode).toBe(409);
      const dup = res.body.error.duplicates[0];
      expect(dup.category).toBe('hospital');
      expect(dup).toHaveProperty('is_active');
      expect(dup).toHaveProperty('zoho_contact_id');
    });

    test('names differing only by case or punctuation are still the same customer', async () => {
      const body = validCustomer({ display_name: `Mercury Drug ${uniq()}` });
      expect((await create(medrepToken, body)).statusCode).toBe(201);
      await cleanup(body.display_name);

      const res = await create(medrepToken, validCustomer({ display_name: body.display_name.toUpperCase() }));
      expect(res.statusCode).toBe(409);
    });
  });

  describe('validation happens before anything is written', () => {
    const cases = [
      ['no display name', { display_name: '' }],
      ['no contact number', { contact_number: '' }],
      ['no phone', { phone: '' }],
      ['no billing address', { billing_address: { phone: '+639171234567' } }],
      ['no billing phone', { billing_address: { address: '123 Taft Ave' } }]
    ];

    for (const [label, override] of cases) {
      test(`rejects: ${label}`, async () => {
        const spy = jest.spyOn(zoho, 'createContact');
        try {
          const res = await create(medrepToken, validCustomer(override));
          expect(res.statusCode).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    }

    test('shipping is only required when it differs from billing', async () => {
      const same = await create(medrepToken, validCustomer({ shipping_same_as_billing: true }));
      expect(same.statusCode).toBe(201);
      await cleanup(same.body.data.customer.name);

      const differs = await create(
        medrepToken,
        validCustomer({ shipping_same_as_billing: false, shipping_address: {} })
      );
      expect(differs.statusCode).toBe(400);
      expect(differs.body.error.message).toMatch(/shipping/i);
    });

    test('a date Zoho cannot parse is refused rather than silently dropped', async () => {
      // Zoho accepts an unparseable date and stores nothing, which looks
      // exactly like the field was left blank.
      const res = await create(medrepToken, validCustomer({ license_expiry_date: '31/12/2027' }));
      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toMatch(/date/i);
    });
  });

  describe('when Zoho refuses', () => {
    test('no local customer is left behind', async () => {
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(new Error('Zoho is unavailable'));
      const body = validCustomer();
      try {
        const before = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
        const res = await create(medrepToken, body);

        // 502, not 400: the request was fine, the upstream refused. A 400
        // sends a rep back to re-read a form with nothing wrong in it.
        expect(res.statusCode).toBe(502);
        expect(res.body.error.code).toBe('ZOHO_REFUSED');

        const after = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
        // A local row with no zoho_contact_id is a customer that looks
        // selectable and then fails at the first Sales Order — the exact
        // failure this feature exists to remove.
        expect(after).toBe(before);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * Sep 11, 2026. `category` means "hospital order rules apply" — it is what
   * turns on the GL Number, the receiver type and four required attachments.
   *
   * Every one of the 95,063 customers already in this database is NULL, so
   * that rule has never fired for anybody. A customer created here without one
   * silently joins them, and the failure is invisible: the controls are simply
   * absent and the order submits looking complete. Hence these tests.
   */
  describe('customer type — the field that decides hospital rules', () => {
    test('is stored, so hospital rules can actually fire', async () => {
      const body = validCustomer({ category: 'hospital' });
      const res = await create(medrepToken, body);
      expect(res.statusCode).toBe(201);
      await cleanup(body.display_name);
      expect(res.body.data.customer.category).toBe('hospital');
    });

    test('"not sure" is a real answer and stores NULL', async () => {
      // Forcing a guess is wrong in both directions: claimed and the rep is
      // blocked on attachments they do not have; missed and four controls
      // disappear silently.
      const body = validCustomer({ category: '' });
      const res = await create(medrepToken, body);
      expect(res.statusCode).toBe(201);
      await cleanup(body.display_name);
      expect(res.body.data.customer.category).toBeNull();
    });

    test('an omitted category is NULL, not a crash', async () => {
      const body = validCustomer();
      delete body.category;
      const res = await create(medrepToken, body);
      expect(res.statusCode).toBe(201);
      await cleanup(body.display_name);
      expect(res.body.data.customer.category).toBeNull();
    });

    test('an invented category is refused before anything is written', async () => {
      // The column has a CHECK constraint, so a bad value would fail at the
      // INSERT — AFTER the contact was created in Zoho, leaving a contact
      // there with no customer here.
      const spy = jest.spyOn(zoho, 'createContact');
      try {
        const res = await create(medrepToken, validCustomer({ category: 'clinic' }));
        expect(res.statusCode).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    test('each allowed category round-trips', async () => {
      for (const category of ['doctor', 'hospital', 'distributor', 'pwd']) {
        const body = validCustomer({ category });
        const res = await create(medrepToken, body);
        expect(res.statusCode).toBe(201);
        await cleanup(body.display_name);
        expect(res.body.data.customer.category).toBe(category);
      }
    });
  });

  describe('what reaches Zoho', () => {
    test('defaults to a business, and sends the custom fields it was given', async () => {
      const spy = jest.spyOn(zoho, 'createContact');
      const body = validCustomer({
        lto_license_number: `LTO-${uniq()}`,
        lto_type: 'Retail',
        license_owner: 'Maria Santos',
        is_doctor: true,
        tin: '123-456-789'
      });
      try {
        const res = await create(medrepToken, body);
        expect(res.statusCode).toBe(201);
        await cleanup(body.display_name);

        const sent = spy.mock.calls[0][0];
        // Confirmed with the business, and load-bearing: 'business' is the
        // sub-type whose TIN rule updateContactTin exists for, so defaulting
        // the other way would create contacts that fail their first order.
        expect(sent.customer_sub_type).toBe('business');
        expect(sent.lto_type).toBe('Retail');
        expect(sent.is_doctor).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    test('shipping falls back to billing when the rep said they are the same', async () => {
      const spy = jest.spyOn(zoho, 'createContact');
      const body = validCustomer({ shipping_same_as_billing: true });
      try {
        expect((await create(medrepToken, body)).statusCode).toBe(201);
        await cleanup(body.display_name);
        const sent = spy.mock.calls[0][0];
        expect(sent.shipping_address).toEqual(body.billing_address);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
