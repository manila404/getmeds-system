/**
 * Sep 14, 2026 — a waiting customer that Zoho may already have is not pushed.
 *
 * 1ST SPECIALITY PHARMA waited here for Zoho while someone created
 * "1ST SPECIALTY PHARMA" directly in Zoho and raised two Sales Orders against
 * it. Pushing the waiting one would have put the same business in Zoho twice.
 * The fixture below is that pair: one letter apart, same TIN.
 *
 * The push now compares first and holds a likely match back; a person then
 * uses the Zoho customer, pushes as new anyway, or deletes the waiting copy.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const { compareNames } = require('../src/services/customerCreateService');

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const created = { customers: [], orders: [] };
let adminToken;
let medrepId;

/** A distinctive word, so these fixtures never match other suites' rows. */
const tag = () => `Zq${uniq()}`;

async function insertCustomer({ name, zohoId = null, tin = null, phone = null, lto = null }) {
  const held = !zohoId;
  await db
    .prepare(
      `INSERT INTO customers (name, type, contact_number, address, source, zoho_contact_id, tin, lto_license_number,
                              is_active, created_at, zoho_sync_status, zoho_pending_payload)
       VALUES (?, 'direct', ?, '1 Dup St', ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(
      name,
      phone,
      held ? 'local' : 'zoho',
      zohoId,
      tin,
      lto,
      new Date().toISOString(),
      held ? 'pending' : 'synced',
      held ? JSON.stringify({ display_name: name, contact_number: phone || '+639170000000' }) : null
    );
  const row = await db.prepare('SELECT * FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1').get(name);
  created.customers.push(row.id);
  return row;
}

async function insertOrder(customerId) {
  const ref = `GM-DUP-${uniq()}`;
  await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount,
                           delivery_address, zoho_sync_status)
       VALUES (?, ?, ?, 'ready_for_finance_verified', 'direct', 100, '1 Dup St', 'failed')`
    )
    .run(ref, customerId, medrepId);
  const row = await db.prepare('SELECT * FROM orders WHERE getmeds_order_id = ?').get(ref);
  created.orders.push(row.id);
  return row;
}

/** The 1ST SPECIALITY PHARMA pair: waiting here, and already in Zoho. */
async function duplicatePair() {
  const t = tag();
  const inZoho = await insertCustomer({ name: `${t} 1ST SPECIALTY PHARMA`, zohoId: `ZC-DUP-${uniq()}` });
  const waiting = await insertCustomer({ name: `${t} 1ST SPECIALITY PHARMA`, tin: '681-470-003-00000' });
  return { inZoho, waiting };
}

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

describe('a waiting customer Zoho may already have', () => {
  beforeAll(async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = a.body.data.token;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
  });

  afterAll(async () => {
    for (const id of created.orders) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM zoho_retry_queue WHERE order_id = ?').run(id).catch(() => {});
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    for (const id of created.customers) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  describe('comparing names', () => {
    test('one letter apart is similar — SPECIALITY / SPECIALTY', () => {
      expect(compareNames('1ST SPECIALITY PHARMA', '1ST SPECIALTY PHARMA')).toBe('similar_name');
    });
    test('case, spacing and punctuation do not make a different name', () => {
      expect(compareNames('Mercury Drug - Taft', 'MERCURY DRUG TAFT')).toBe('same_name');
    });
    test("one name's words inside the other's is similar", () => {
      expect(compareNames('Mercury Drug Taft', 'Mercury Drug Taft Branch')).toBe('similar_name');
    });
    test('different numbers are different customers, however close the spelling', () => {
      expect(compareNames('Watsons Branch 12', 'Watsons Branch 13')).toBeNull();
    });
    test('unrelated names do not match', () => {
      expect(compareNames('Jazie Drug Distribution', '1ST SPECIALTY PHARMA')).toBeNull();
    });
  });

  test('the waiting list shows the Zoho customer it looks like', async () => {
    const { inZoho, waiting } = await duplicatePair();
    const res = await request(app).get('/api/customers/pending').set(auth());
    expect(res.statusCode).toBe(200);
    const row = res.body.data.customers.find((c) => c.id === waiting.id);
    expect(row.matches.map((m) => m.id)).toContain(inZoho.id);
    expect(row.matches.find((m) => m.id === inZoho.id).matched).toContain('similar_name');
  });

  test('a TIN or phone match counts even when the names differ', async () => {
    const t = tag();
    const inZoho = await insertCustomer({ name: `${t} Alpha Medical`, zohoId: `ZC-DUP-${uniq()}`, tin: '123456789-001', phone: '+63 917 555 0142' });
    const waiting = await insertCustomer({ name: `${t} Omega Clinic`, tin: '123-456-789-000', phone: '09175550142' });
    const row = (await request(app).get('/api/customers/pending').set(auth())).body.data.customers.find((c) => c.id === waiting.id);
    const match = row.matches.find((m) => m.id === inZoho.id);
    expect(match.matched).toEqual(expect.arrayContaining(['tin', 'phone']));
  });

  test('a placeholder phone that many Zoho customers share is not a match', async () => {
    // Production has 09123456789 on five unrelated customers; "Test Aaron"
    // was flagged against all of them.
    const t = tag();
    const phone = `0918${String(uniq()).slice(-7)}`;
    for (let i = 0; i < 4; i++) {
      await insertCustomer({ name: `${t} Unrelated ${'ABCD'[i]} Store`, zohoId: `ZC-DUP-${uniq()}`, phone });
    }
    const waiting = await insertCustomer({ name: `${tag()} Placeholder Phone Pharmacy`, phone });
    const row = (await request(app).get('/api/customers/pending').set(auth())).body.data.customers.find((c) => c.id === waiting.id);
    expect(row.matches).toEqual([]);
  });

  test('"Push to Zoho" holds it back without asking Zoho, and says so', async () => {
    const { waiting } = await duplicatePair();
    const spy = jest.spyOn(zoho, 'createContact');
    try {
      const res = await request(app).post('/api/customers/pending/sync').set(auth());
      expect(res.statusCode).toBe(200);
      expect(res.body.data.needs_review.map((c) => c.id)).toContain(waiting.id);
      expect(res.body.data.message).toMatch(/held back/i);
      const pushedNames = spy.mock.calls.map(([payload]) => payload.display_name);
      expect(pushedNames).not.toContain(waiting.name);
    } finally {
      spy.mockRestore();
    }
    const row = await db.prepare('SELECT zoho_sync_status, zoho_contact_id FROM customers WHERE id = ?').get(waiting.id);
    expect(row.zoho_sync_status).toBe('pending');
    expect(row.zoho_contact_id).toBeNull();
  });

  test('pushing it alone is refused until someone confirms it is a different customer', async () => {
    const { waiting } = await duplicatePair();
    const first = await request(app).post(`/api/customers/${waiting.id}/push`).set(auth()).send({});
    expect(first.statusCode).toBe(409);
    expect(first.body.error.code).toBe('LIKELY_DUPLICATE');

    const confirmed = await request(app).post(`/api/customers/${waiting.id}/push`).set(auth()).send({ confirm_new: true });
    expect(confirmed.statusCode).toBe(200);
    const row = await db.prepare('SELECT zoho_sync_status, zoho_contact_id FROM customers WHERE id = ?').get(waiting.id);
    expect(row.zoho_sync_status).toBe('synced');
    expect(row.zoho_contact_id).toBeTruthy();
  });

  test('"use the Zoho customer" moves the orders there and deletes the waiting copy', async () => {
    const { inZoho, waiting } = await duplicatePair();
    const order = await insertOrder(waiting.id);
    const spy = jest.spyOn(zoho, 'createContact');
    try {
      const res = await request(app).post(`/api/customers/${waiting.id}/link`).set(auth()).send({ target_id: inZoho.id });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.moved).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    expect((await db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(order.id)).customer_id).toBe(inZoho.id);
    expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeUndefined();
    // What the rep typed fills what the hand-made Zoho customer lacked.
    expect((await db.prepare('SELECT tin FROM customers WHERE id = ?').get(inZoho.id)).tin).toBe('681-470-003-00000');
    const events = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'CUSTOMER_LINKED_TO_ZOHO'").all(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].notes).toMatch(/SPECIALTY PHARMA/);
  });

  test('a customer that is not in Zoho cannot be the one used instead', async () => {
    const { waiting } = await duplicatePair();
    const other = await insertCustomer({ name: `${tag()} Another Waiting One` });
    const res = await request(app).post(`/api/customers/${waiting.id}/link`).set(auth()).send({ target_id: other.id });
    expect(res.statusCode).toBe(404);
    expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeTruthy();
  });

  test('deleting a waiting customer stops it being pushed', async () => {
    const waiting = await insertCustomer({ name: `${tag()} Test Aaron` });
    const res = await request(app).delete(`/api/customers/${waiting.id}/pending`).set(auth());
    expect(res.statusCode).toBe(200);
    expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeUndefined();
  });

  test('a waiting customer with orders cannot be deleted — its orders would lose their customer', async () => {
    const waiting = await insertCustomer({ name: `${tag()} Has Orders Pharmacy` });
    await insertOrder(waiting.id);
    const res = await request(app).delete(`/api/customers/${waiting.id}/pending`).set(auth());
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('HAS_ORDERS');
    expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeTruthy();
  });

  test('a customer already in Zoho can never be deleted through this', async () => {
    const { inZoho } = await duplicatePair();
    const res = await request(app).delete(`/api/customers/${inZoho.id}/pending`).set(auth());
    expect(res.statusCode).toBe(404);
    expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(inZoho.id)).toBeTruthy();
  });

  describe('"Update customer" — correct the Zoho customer, then use it', () => {
    /**
     * The real pair: Zoho's contact already had the same TIN and licence, and
     * the local copy of it had neither — which is why the review reads Zoho.
     */
    async function zohoPair() {
      const t = tag();
      const lto = `LTO-${uniq()}`;
      const { contact } = await zoho.createContact({
        display_name: `${t} 1ST SPECIALTY PHARMA`,
        contact_number: '917 590 7923',
        lto_license_number: lto,
        tin: '681-470-003-00000'
      });
      const inZoho = await insertCustomer({ name: contact.contact_name, zohoId: contact.contact_id });
      const waiting = await insertCustomer({ name: `${t} 1ST SPECIALITY PHARMA`, tin: '681-470-003-00000', phone: '+63 917 590 7923', lto });
      await db.prepare('UPDATE customers SET zoho_pending_payload = ? WHERE id = ?').run(
        JSON.stringify({
          display_name: waiting.name,
          contact_number: '+63 917 590 7923',
          phone: '+63 917 590 7923',
          tin: '681-470-003-00000',
          lto_license_number: lto,
          billing_address: { address: '245 ALCAZAR ST', city: 'CEBU CITY' }
        }),
        waiting.id
      );
      return { inZoho, waiting, contact, lto };
    }

    test('the comparison reads the customer from Zoho, not the thin local copy', async () => {
      const { inZoho, waiting, lto } = await zohoPair();
      const res = await request(app).get(`/api/customers/${waiting.id}/zoho-compare`).query({ target_id: inZoho.id }).set(auth());
      expect(res.statusCode).toBe(200);
      expect(res.body.data.source).toBe('zoho');
      expect(res.body.data.zoho.tin).toBe('681-470-003-00000');
      expect(res.body.data.zoho.lto_license_number).toBe(lto);
      expect(res.body.data.matched).toEqual(expect.arrayContaining(['similar_name', 'lto', 'tin', 'phone']));
      expect(res.body.data.waiting.address).toBe('245 ALCAZAR ST');
    });

    test('sends Zoho only what changed, then moves the orders and deletes the waiting copy', async () => {
      const { inZoho, waiting, contact, lto } = await zohoPair();
      const order = await insertOrder(waiting.id);
      const spy = jest.spyOn(zoho, 'updateContact');
      try {
        const res = await request(app)
          .post(`/api/customers/${waiting.id}/link`)
          .set(auth())
          .send({
            target_id: inZoho.id,
            update: {
              name: contact.contact_name,
              contact_number: '917 590 7923',
              phone: '+63 917 590 7923',
              email: '',
              tin: '681-470-003-00000',
              lto_license_number: lto,
              address: '245 ALCAZAR ST',
              city: 'CEBU CITY',
              category: 'distributor'
            }
          });
        expect(res.statusCode).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
        const [id, changes] = spy.mock.calls[0];
        expect(id).toBe(contact.contact_id);
        // Changed: phone and address. Unchanged (name, TIN, licence, contact
        // number) and empty (email) are not sent at all.
        expect(changes.phone).toBe('+63 917 590 7923');
        expect(changes.billing_address.address).toBe('245 ALCAZAR ST');
        expect(changes.contact_name).toBeUndefined();
        expect(changes.email).toBeUndefined();
        expect(changes.custom).toBeUndefined();
        expect(res.body.data.message).toMatch(/updated in Zoho \(phone, address, city\)/);
      } finally {
        spy.mockRestore();
      }

      const after = (await zoho.getContact(contact.contact_id)).contact;
      expect(after.phone).toBe('+63 917 590 7923');
      expect(after.cf_tin).toBe('681-470-003-00000');
      expect((await db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(order.id)).customer_id).toBe(inZoho.id);
      expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeUndefined();
      expect((await db.prepare('SELECT category FROM customers WHERE id = ?').get(inZoho.id)).category).toBe('distributor');
    });

    test('a field left empty never clears what Zoho has', async () => {
      const { inZoho, waiting, contact } = await zohoPair();
      const res = await request(app)
        .post(`/api/customers/${waiting.id}/link`)
        .set(auth())
        .send({ target_id: inZoho.id, update: { name: contact.contact_name, contact_number: '917 590 7923', tin: '', lto_license_number: '' } });
      expect(res.statusCode).toBe(200);
      const after = (await zoho.getContact(contact.contact_id)).contact;
      expect(after.cf_tin).toBe('681-470-003-00000');
      expect(after.cf_lto_license_number).toBeTruthy();
    });

    test('if Zoho refuses, nothing here changes', async () => {
      const { inZoho, waiting, contact } = await zohoPair();
      const order = await insertOrder(waiting.id);
      const spy = jest.spyOn(zoho, 'updateContact').mockRejectedValue(new Error('You are not authorized to perform this operation'));
      try {
        const res = await request(app)
          .post(`/api/customers/${waiting.id}/link`)
          .set(auth())
          .send({ target_id: inZoho.id, update: { name: contact.contact_name, contact_number: '917 590 7923', phone: '0917 000 0000' } });
        expect(res.statusCode).toBe(503);
        expect(res.body.error.message).toMatch(/Nothing was changed/);
      } finally {
        spy.mockRestore();
      }
      expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeTruthy();
      expect((await db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(order.id)).customer_id).toBe(waiting.id);
    });

    test('Contact Number is required, as Zoho requires it', async () => {
      const { inZoho, waiting, contact } = await zohoPair();
      const res = await request(app)
        .post(`/api/customers/${waiting.id}/link`)
        .set(auth())
        .send({ target_id: inZoho.id, update: { name: contact.contact_name, contact_number: '' } });
      expect(res.statusCode).toBe(400);
      expect(await db.prepare('SELECT id FROM customers WHERE id = ?').get(waiting.id)).toBeTruthy();
    });
  });
});
