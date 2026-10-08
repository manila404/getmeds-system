/**
 * Oct 8, 2026 — a new customer with details missing goes to Management, not to Zoho.
 *
 * A MedRep may leave out the email, TIN or license details (a rep with no email had
 * typed "n/A" to get past the required field, and Zoho refused the customer). The
 * customer is saved and the order can go on, but it is held: Management sees what is
 * missing and chooses to push it as new anyway, link it to a customer Zoho already has,
 * or delete it. The bulk push never sends it on its own.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const customerCreate = require('../src/services/customerCreateService');

const ids = [];
let medrepToken, managerToken;
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const hospital = (overrides = {}) => {
  const phone = `+63917${String(uniq()).slice(-7)}`;
  return {
    category: 'hospital',
    display_name: `Lacking Hospital ${uniq()}`,
    company_name: 'x',
    email: 'records@hospital.ph',
    phone,
    contact_number: phone,
    tin: '000-111-222-000',
    license_owner: 'Owner',
    lto_license_number: `LTO-${uniq()}`,
    lto_type: 'Hospital',
    license_issuance_date: '2026-01-01',
    license_expiry_date: '2027-01-01',
    billing_address: { address: '1 Review St', city: 'Manila', phone },
    shipping_same_as_billing: true,
    ...overrides
  };
};

async function create(body) {
  const res = await request(app).post('/api/customers').set(auth(medrepToken)).send(body);
  const row = await db.prepare('SELECT * FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1').get(body.display_name);
  if (row) ids.push(row.id);
  return { res, row };
}

beforeAll(async () => {
  medrepToken = (await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' })).body.data.token;
  managerToken = (await request(app).post('/api/auth/login').send({ email: 'manager@getmeds.ph', password: 'demo123' })).body.data.token;
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  for (const id of ids) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
});

describe('what counts as missing', () => {
  test('email, TIN and the license fields, for a hospital', () => {
    expect(customerCreate.lackingDetails(hospital())).toEqual([]);
    expect(customerCreate.lackingDetails(hospital({ email: '', tin: '', lto_type: '' }))).toEqual(['Email', 'TIN', 'LTO Type']);
  });

  test('"n/A" in email counts as missing', () => {
    expect(customerCreate.lackingDetails(hospital({ email: 'n/A' }))).toEqual(['Email']);
  });

  test('only email, for a doctor; nothing for a patient', () => {
    expect(customerCreate.lackingDetails({ category: 'doctor', email: '' })).toEqual(['Email']);
    expect(customerCreate.lackingDetails({ category: 'patient', email: '' })).toEqual([]);
  });
});

describe('a MedRep creating a customer', () => {
  test('with everything filled in, it goes straight to Zoho', async () => {
    const spy = jest.spyOn(zoho, 'createContact');
    const { res, row } = await create(hospital());
    expect(res.status).toBe(201);
    expect(res.body.data.held).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(row.zoho_contact_id).toBeTruthy();
  });

  test('with details missing, it is saved and held, and Zoho is not asked', async () => {
    const spy = jest.spyOn(zoho, 'createContact');
    const { res, row } = await create(hospital({ email: '', tin: '' }));
    expect(res.status).toBe(201);
    expect(res.body.data.held).toBe(true);
    expect(res.body.data.lacking).toEqual(['Email', 'TIN']);
    expect(spy).not.toHaveBeenCalled();
    expect(row.zoho_contact_id).toBeNull();
    expect(row.zoho_sync_status).toBe('pending');
  });

  test('a typed non-email is refused, so they either type a real one or leave it blank', async () => {
    const { res } = await create(hospital({ email: 'n/A' }));
    expect(res.status).toBe(400);
  });
});

describe('Management reviewing it', () => {
  test('the waiting list shows what is missing', async () => {
    const { row } = await create(hospital({ email: '', lto_type: '' }));
    const res = await request(app).get('/api/customers/pending').set(auth(managerToken));
    const mine = res.body.data.customers.find((c) => c.id === row.id);
    expect(mine.lacking).toEqual(['Email', 'LTO Type']);
    expect(mine.zoho_pending_payload).toBeUndefined();
  });

  test('the bulk push holds it back for review', async () => {
    const { row } = await create(hospital({ email: '' }));
    const spy = jest.spyOn(zoho, 'createContact');
    const out = await customerCreate.syncHeldCustomer(row.id);
    expect(out.ok).toBe(false);
    expect(out.needsReview).toBe(true);
    expect(out.lacking).toEqual(['Email']);
    expect(spy).not.toHaveBeenCalled();
  });

  test('"push as new anyway" creates it in Zoho', async () => {
    const { row } = await create(hospital({ email: '' }));
    const res = await request(app).post(`/api/customers/${row.id}/push`).set(auth(managerToken)).send({ confirm_new: true });
    expect(res.status).toBe(200);
    const after = await db.prepare('SELECT zoho_contact_id, zoho_sync_status FROM customers WHERE id = ?').get(row.id);
    expect(after.zoho_contact_id).toBeTruthy();
  });

  test('a push without confirming is still held back', async () => {
    const { row } = await create(hospital({ email: '' }));
    const res = await request(app).post(`/api/customers/${row.id}/push`).set(auth(managerToken)).send({});
    expect(res.status).toBe(409);
  });
});

describe('Management opening and editing it', () => {
  const open = (id, token = managerToken) => request(app).get(`/api/customers/${id}/pending`).set(auth(token));
  const save = (id, details, token = managerToken) => request(app).patch(`/api/customers/${id}/pending`).set(auth(token)).send({ details });

  test('opens with everything the MedRep entered, and what is missing', async () => {
    const body = hospital({ email: '', tin: '' });
    const { row } = await create(body);
    const res = await open(row.id);
    expect(res.status).toBe(200);
    expect(res.body.data.details.lto_license_number).toBe(body.lto_license_number);
    expect(res.body.data.lacking).toEqual(['Email', 'TIN']);
  });

  test('saving the missing details completes it, in the row and in what the push sends', async () => {
    const { row } = await create(hospital({ email: '', tin: '' }));
    const res = await save(row.id, { email: 'records@complete.ph', tin: '123-456-789-000' });
    expect(res.status).toBe(200);
    expect(res.body.data.lacking).toEqual([]);
    const after = await db.prepare('SELECT email, tin, zoho_pending_payload, zoho_sync_status FROM customers WHERE id = ?').get(row.id);
    expect(after.email).toBe('records@complete.ph');
    expect(after.tin).toBe('123-456-789-000');
    expect(JSON.parse(after.zoho_pending_payload).email).toBe('records@complete.ph');
    expect(after.zoho_sync_status).toBe('pending');
    // Nothing missing now, so the bulk push sends it.
    const out = await customerCreate.syncHeldCustomer(row.id, { allowMatches: true });
    expect(out.ok).toBe(true);
  });

  test('a fake email is refused when saving', async () => {
    const { row } = await create(hospital({ email: '' }));
    expect((await save(row.id, { email: 'n/A' })).status).toBe(400);
  });

  test('missing details are not recorded as a Zoho error', async () => {
    const { row } = await create(hospital({ email: '' }));
    expect(row.zoho_sync_error).toBeNull();
  });

  test('a MedRep cannot open or edit it', async () => {
    const { row } = await create(hospital({ email: '' }));
    expect((await open(row.id, medrepToken)).status).toBe(403);
    expect((await save(row.id, { email: 'a@b.com' }, medrepToken)).status).toBe(403);
  });
});
