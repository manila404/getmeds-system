/**
 * Oct 8, 2026 — a waiting customer whose email Zoho refused.
 *
 * A rep typed "n/A" into the required Email Address and Zoho answered "Invalid value
 * passed for Email Address", leaving the customer stuck under Needs attention with no
 * way to correct it. Creation now refuses a non-email, and Management can fix the
 * email of a waiting customer, which also corrects the payload the push replays.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const customerCreate = require('../src/services/customerCreateService');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ids = [];
let managerToken, medrepToken;

async function login(email) {
  return (await request(app).post('/api/auth/login').send({ email, password: 'demo123' })).body.data.token;
}

async function heldCustomer({ status = 'failed', zohoContactId = null } = {}) {
  const name = `Email Fix Hospital ${stamp}-${ids.length}`;
  const payload = { display_name: name, email: 'n/A', category: 'hospital', phone: '+639170000000' };
  await db.prepare(
    `INSERT INTO customers (name, type, category, email, contact_number, source, is_active, zoho_contact_id,
                            zoho_sync_status, zoho_sync_error, zoho_pending_payload)
     VALUES (?, 'credit', 'hospital', 'n/A', 'N/A', 'local', 1, ?, ?, 'Invalid value passed for Email Address', ?)`
  ).run(name, zohoContactId, status, JSON.stringify(payload));
  const id = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(name)).id;
  ids.push(id);
  return id;
}
const fix = (id, email, token = managerToken) =>
  request(app).post(`/api/customers/${id}/pending-email`).set('Authorization', `Bearer ${token}`).send({ email });
const row = (id) => db.prepare('SELECT email, zoho_sync_status, zoho_sync_error, zoho_pending_payload FROM customers WHERE id = ?').get(id);

beforeAll(async () => {
  managerToken = await login('manager@getmeds.ph');
  medrepToken = await login('medrep@getmeds.ph');
});

afterAll(async () => {
  for (const id of ids) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
});

describe('creating a customer', () => {
  test('a placeholder such as "n/A" in Email Address is refused', () => {
    const problems = customerCreate.validate({ category: 'hospital', display_name: 'X', email: 'n/A' });
    expect(problems.some((p) => /real email/i.test(p))).toBe(true);
  });

  test('a real email passes the email check', () => {
    const problems = customerCreate.validate({ category: 'hospital', display_name: 'X', email: 'records@hospital.com.ph' });
    expect(problems.some((p) => /email/i.test(p))).toBe(false);
  });
});

describe('pushing to Zoho', () => {
  const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');
  const sent = async (email) => {
    const adapter = Object.create(LiveZohoAdapter.prototype);
    let body;
    adapter._request = async (_m, _p, opts) => { body = opts.body; return { contact: { contact_id: '1' } }; };
    await adapter.createContact({ display_name: 'X Hospital', email, phone: '+639170000000', contact_number: '+639170000000', category: 'hospital' });
    return body;
  };

  test('an email Zoho cannot parse is left out, and the customer is still created', async () => {
    const body = await sent('n/A');
    expect(body.email).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('n/A');
  });

  test('a real email is still sent', async () => {
    expect((await sent('records@hospital.com.ph')).email).toBe('records@hospital.com.ph');
  });
});

describe('fixing the email of a waiting customer', () => {
  test('saves the email in the row and the stored payload, and queues it again', async () => {
    const id = await heldCustomer();
    const res = await fix(id, ' records@stdominic.com.ph ');
    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r.email).toBe('records@stdominic.com.ph');
    expect(JSON.parse(r.zoho_pending_payload).email).toBe('records@stdominic.com.ph');
    expect(r.zoho_sync_status).toBe('pending');
    expect(r.zoho_sync_error).toBeNull();
  });

  test('another placeholder is refused and nothing changes', async () => {
    const id = await heldCustomer();
    const res = await fix(id, 'N/A');
    expect(res.status).toBe(400);
    const r = await row(id);
    expect(r.email).toBe('n/A');
    expect(r.zoho_sync_status).toBe('failed');
  });

  test('a blank email removes it, so the customer is pushed without one', async () => {
    const id = await heldCustomer();
    const res = await fix(id, '');
    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r.email).toBeNull();
    expect(JSON.parse(r.zoho_pending_payload).email).toBe('');
    expect(r.zoho_sync_status).toBe('pending');
  });

  test('a customer already in Zoho is not touched', async () => {
    const id = await heldCustomer({ status: 'synced', zohoContactId: `ZC-${stamp}` });
    expect((await fix(id, 'a@b.com')).status).toBe(404);
    expect((await row(id)).email).toBe('n/A');
  });

  test('a MedRep cannot do it', async () => {
    const id = await heldCustomer();
    expect((await fix(id, 'a@b.com', medrepToken)).status).toBe(403);
  });
});
