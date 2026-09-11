/**
 * Sep 11, 2026 — customers held because Zoho will not accept them yet.
 *
 * This org's Zoho token grants ZohoInventory.contacts.READ and not .CREATE, so
 * creating a customer fails with "You are not authorized to perform this
 * operation". Reissuing the token needs the API Console, which is not always
 * reachable — so rather than send a MedRep away mid-order, the customer is
 * stored here as pending and pushed once the token allows it.
 *
 * The danger this design has to avoid is the one that motivated the whole
 * feature: a local customer with no zoho_contact_id is selectable, and an
 * order against it dies at createSalesOrder. So the assertions below are
 * mostly about a held customer staying VISIBLY held — no fake contact id, no
 * order silently queued to fail, and a release that actually happens.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const customerCreate = require('../src/services/customerCreateService');

const created = { customers: [], orders: [] };
let medrepToken;
let adminToken;

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const validCustomer = (overrides = {}) => ({
  display_name: `Held Pharmacy ${uniq()}`,
  phone: '+639171234567',
  contact_number: '+639171234567',
  billing_address: { address: '1 Held St', city: 'Manila', phone: '+639171234567' },
  shipping_same_as_billing: true,
  ...overrides
});

/** Zoho's answer when the contacts.CREATE scope is missing. */
const scopeError = () => new Error('You are not authorized to perform this operation');

async function track(name) {
  const row = await db.prepare('SELECT id FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1').get(name);
  if (row) created.customers.push(row.id);
  return row?.id;
}

describe('holding customers Zoho cannot accept yet', () => {
  beforeAll(async () => {
    const m = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = m.body.data.token;
    const a = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = a.body.data.token;
  });

  afterAll(async () => {
    for (const id of created.orders) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of created.customers) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    if (db.close) await db.close();
  });

  const create = (body, token = medrepToken) =>
    request(app).post('/api/customers').set('Authorization', `Bearer ${token}`).send(body);

  describe('when the scope is missing', () => {
    test('the customer is SAVED, not refused', async () => {
      // The rep's work must survive. Turning them away mid-order is the dead
      // end this whole feature was built to remove.
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      try {
        const body = validCustomer();
        const res = await create(body);
        expect(res.statusCode).toBe(201);
        expect(res.body.data.held).toBe(true);
        expect(res.body.data.message).toMatch(/not in Zoho yet/i);
        await track(body.display_name);
      } finally {
        spy.mockRestore();
      }
    });

    test('it has NO zoho_contact_id — the thing that keeps it distinguishable', async () => {
      // A placeholder id would make a held customer look exactly like a real
      // one everywhere downstream, which is the original bug in a new costume.
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      try {
        const body = validCustomer();
        await create(body);
        const id = await track(body.display_name);
        const row = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
        expect(row.zoho_contact_id).toBeNull();
        expect(row.zoho_sync_status).toBe('pending');
        expect(row.source).toBe('local');
      } finally {
        spy.mockRestore();
      }
    });

    test('the whole creation payload is kept, not just the row', async () => {
      // customers does not hold licence dates, LTO type, or both addresses.
      // Without the payload, syncing later means asking the rep to retype what
      // they already entered — which is how a queue stops being worked.
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      try {
        const body = validCustomer({ lto_type: 'Retail', license_expiry_date: '2027-12-31' });
        await create(body);
        const id = await track(body.display_name);
        const row = await db.prepare('SELECT zoho_pending_payload FROM customers WHERE id = ?').get(id);
        const payload = JSON.parse(row.zoho_pending_payload);
        expect(payload.lto_type).toBe('Retail');
        expect(payload.license_expiry_date).toBe('2027-12-31');
        expect(payload.billing_address.address).toBe('1 Held St');
      } finally {
        spy.mockRestore();
      }
    });

    test('a duplicate is still blocked before anything is held', async () => {
      // The hold must not become a way to accumulate duplicates while Zoho is
      // unreachable — they would all be pushed at once later.
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      try {
        const body = validCustomer();
        expect((await create(body)).statusCode).toBe(201);
        await track(body.display_name);

        const again = await create(validCustomer({ display_name: body.display_name }));
        expect(again.statusCode).toBe(409);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('what counts as "Zoho is unreachable"', () => {
    // Sep 11, 2026. The hold started as "the contacts.CREATE scope is missing".
    // Then the refresh token got rate-limited and every create became a hard
    // 502 — the rep lost the whole form to a condition that clears itself in an
    // hour. The question is not WHY Zoho said no, it is whether saying no told
    // us anything about THIS customer.
    const unreachable = [
      ['a missing scope', 'You are not authorized to perform this operation'],
      ['an expired token', 'Failed to refresh Zoho access token: Access Denied (HTTP 400)'],
      ['a rate limit', 'You have made too many requests continuously. Please try again after some time.'],
      ['DNS failure', 'getaddrinfo ENOTFOUND www.zohoapis.com'],
      ['a dropped connection', 'fetch failed']
    ];

    for (const [label, message] of unreachable) {
      test(`${label} HOLDS the customer rather than losing the form`, async () => {
        const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(new Error(message));
        try {
          const body = validCustomer();
          const res = await create(body);
          expect(res.statusCode).toBe(201);
          expect(res.body.data.held).toBe(true);
          await track(body.display_name);
        } finally {
          spy.mockRestore();
        }
      });
    }

    test('a refusal ABOUT the customer still fails fast', async () => {
      // A duplicate licence will not fix itself. Holding it would queue
      // something guaranteed to fail on every future attempt.
      const spy = jest
        .spyOn(zoho, 'createContact')
        .mockRejectedValue(new Error('The LTO License Number you have entered already exists.'));
      try {
        const before = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
        const res = await create(validCustomer());
        expect(res.statusCode).toBe(502);
        expect(res.body.error.code).toBe('ZOHO_REFUSED');
        const after = (await db.prepare('SELECT COUNT(*) AS c FROM customers').get()).c;
        expect(after).toBe(before);
      } finally {
        spy.mockRestore();
      }
    });

    test('a real success is NOT flagged as held', async () => {
      // The flag is what the modal reads to decide between "Created in Zoho"
      // and "Saved — but not in Zoho yet". Getting it wrong tells the rep the
      // opposite of the truth.
      const body = validCustomer();
      const res = await create(body);
      expect(res.statusCode).toBe(201);
      expect(res.body.data.held).toBe(false);
      expect(res.body.data.customer.zoho_contact_id).toBeTruthy();
      await track(body.display_name);
    });
  });

  describe('the admin queue', () => {
    test('lists held customers, and a MedRep cannot see it', async () => {
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      let name;
      try {
        const body = validCustomer();
        await create(body);
        name = body.display_name;
        await track(name);
      } finally {
        spy.mockRestore();
      }

      const res = await request(app).get('/api/customers/pending').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.customers.map((c) => c.name)).toContain(name);
      expect(res.body.data.pending).toBeGreaterThan(0);

      const asRep = await request(app).get('/api/customers/pending').set('Authorization', `Bearer ${medrepToken}`);
      expect([401, 403]).toContain(asRep.statusCode);
    });

    test('syncing while STILL blocked keeps everything queued', async () => {
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      let id;
      try {
        const body = validCustomer();
        await create(body);
        id = await track(body.display_name);

        const res = await request(app)
          .post('/api/customers/pending/sync')
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.data.blocked).toBeTruthy();
        expect(res.body.data.message).toMatch(/has not been reissued/i);
      } finally {
        spy.mockRestore();
      }

      // Still pending, not failed — the next attempt after the token is fixed
      // has to pick it up.
      const row = await db.prepare('SELECT zoho_sync_status FROM customers WHERE id = ?').get(id);
      expect(row.zoho_sync_status).toBe('pending');
    });

    test('once Zoho accepts it, the customer becomes real', async () => {
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      let id;
      let name;
      try {
        const body = validCustomer();
        await create(body);
        name = body.display_name;
        id = await track(name);
      } finally {
        spy.mockRestore();
      }

      // The token has been reissued: the real mock adapter now answers.
      const res = await request(app)
        .post('/api/customers/pending/sync')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.synced.map((c) => c.name)).toContain(name);

      const row = await db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      expect(row.zoho_sync_status).toBe('synced');
      expect(row.zoho_contact_id).toBeTruthy();
      // Cleared once used, so the queue cannot push the same customer twice.
      expect(row.zoho_pending_payload).toBeNull();
      expect(row.source).toBe('zoho');
    });

    test('a refusal about THIS customer is marked failed, not retried forever', async () => {
      const spy = jest.spyOn(zoho, 'createContact').mockRejectedValue(scopeError());
      let id;
      try {
        const body = validCustomer();
        await create(body);
        id = await track(body.display_name);
      } finally {
        spy.mockRestore();
      }

      // Not a scope problem — a duplicate licence, say. Retrying cannot fix it.
      const spy2 = jest
        .spyOn(zoho, 'createContact')
        .mockRejectedValue(new Error('The LTO License Number you have entered already exists.'));
      try {
        const out = await customerCreate.syncHeldCustomer(id);
        expect(out.ok).toBe(false);
        expect(out.stillBlocked).toBeFalsy();
      } finally {
        spy2.mockRestore();
      }

      const row = await db.prepare('SELECT zoho_sync_status, zoho_sync_error FROM customers WHERE id = ?').get(id);
      expect(row.zoho_sync_status).toBe('failed');
      expect(row.zoho_sync_error).toMatch(/already exists/i);
    });
  });
});
