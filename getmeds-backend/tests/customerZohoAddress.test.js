/**
 * Aug 27, 2026: Zoho's List Contacts response (what customers.controller.js's
 * bulk syncFromZoho pulls) never includes billing_address — only the
 * single "Get a Contact" detail call does. This meant a synced customer's
 * local `address` column stayed NULL forever and the MedRep order form
 * never auto-filled it, even though the address clearly exists in Zoho.
 * GET /api/customers/:id/address-from-zoho (customers.controller.js's
 * getZohoAddress, backed by the new ZohoAdapter.getContact — still a pure
 * read, no Zoho write anywhere) fixes this on a per-customer, on-demand
 * basis, called when a MedRep actually selects that customer.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

describe('GET /api/customers/:id/address-from-zoho', () => {
  let medrepToken;
  const cleanupCustomerIds = [];

  beforeAll(async () => {
    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;
  });

  afterAll(() => {
    for (const id of cleanupCustomerIds) {
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
  });

  test('a customer synced from Zoho (has zoho_contact_id) gets its address filled in from the Get-a-Contact detail call', async () => {
    const insert = db.prepare(`
      INSERT INTO customers (name, type, zoho_contact_id, source, is_active)
      VALUES ('St. Luke Medical Center (Fixture)', 'credit', 'CONTACT-FIX-1001', 'zoho', 1)
    `).run();
    const customerId = insert.lastInsertRowid;
    cleanupCustomerIds.push(customerId);

    const res = await request(app)
      .get(`/api/customers/${customerId}/address-from-zoho`)
      .set('Authorization', `Bearer ${medrepToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.synced_from_zoho).toBe(true);
    expect(res.body.data.address).toContain('Quezon City');

    // Cached locally so a re-selection later doesn't need another Zoho call.
    const stored = db.prepare('SELECT address FROM customers WHERE id = ?').get(customerId);
    expect(stored.address).toContain('Quezon City');
  });

  test('a local-only customer (never synced from Zoho) returns its stored address without calling Zoho', async () => {
    const insert = db.prepare(`
      INSERT INTO customers (name, type, source, address, is_active)
      VALUES ('Local Only Pharmacy', 'direct', 'local', '123 Local St', 1)
    `).run();
    const customerId = insert.lastInsertRowid;
    cleanupCustomerIds.push(customerId);

    const res = await request(app)
      .get(`/api/customers/${customerId}/address-from-zoho`)
      .set('Authorization', `Bearer ${medrepToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.synced_from_zoho).toBe(false);
    expect(res.body.data.address).toBe('123 Local St');
  });

  test('an unknown customer id returns 404', async () => {
    const res = await request(app)
      .get('/api/customers/999999/address-from-zoho')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(404);
  });
});
