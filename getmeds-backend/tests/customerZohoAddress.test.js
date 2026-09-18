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
const zoho = require('../src/integrations/zoho');

describe('GET /api/customers/:id/address-from-zoho', () => {
  let medrepToken;
  const cleanupCustomerIds = [];

  beforeAll(async () => {
    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;
  });

  afterAll(async () => {
    for (const id of cleanupCustomerIds) {
      await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
  });

  test('a customer synced from Zoho (has zoho_contact_id) gets its address filled in from the Get-a-Contact detail call', async () => {
    const insert = await db.prepare(`
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
    const stored = await db.prepare('SELECT address FROM customers WHERE id = ?').get(customerId);
    expect(stored.address).toContain('Quezon City');
  });

  test('a local-only customer (never synced from Zoho) returns its stored address without calling Zoho', async () => {
    const insert = await db.prepare(`
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

  // Sep 18, 2026: a name (or email) corrected straight in Zoho — not through
  // this app's own edit paths — has to reach the local row the moment a
  // MedRep picks that customer, not only on the next admin-triggered Sync
  // from Zoho. orders.controller.js never stores its own copy of a
  // customer's name (always a live JOIN), so fixing it here is enough for
  // every order this customer has, past and future, to show the correction.
  test("a name corrected in Zoho is picked up here, on selection — not just on the next bulk sync", async () => {
    // CONTACT-FIX-1002, not 1001 — the earlier test in this file already
    // has a row on 1001 that only cleans up in afterAll, and zoho_contact_id
    // is unique locally.
    const insert = await db.prepare(`
      INSERT INTO customers (name, type, zoho_contact_id, source, is_active)
      VALUES ('Juana Dela Cruz TYPO', 'direct', 'CONTACT-FIX-1002', 'zoho', 1)
    `).run();
    const customerId = insert.lastInsertRowid;
    cleanupCustomerIds.push(customerId);

    // The edit made "straight in Zoho".
    await zoho.updateContact('CONTACT-FIX-1002', { contact_name: 'Juana Dela Cruz (Corrected)', email: 'juana.corrected@example.com' });

    const res = await request(app)
      .get(`/api/customers/${customerId}/address-from-zoho`)
      .set('Authorization', `Bearer ${medrepToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Juana Dela Cruz (Corrected)');
    expect(res.body.data.email).toBe('juana.corrected@example.com');

    const stored = await db.prepare('SELECT name, email FROM customers WHERE id = ?').get(customerId);
    expect(stored.name).toBe('Juana Dela Cruz (Corrected)');
    expect(stored.email).toBe('juana.corrected@example.com');
  });

  test('an unknown customer id returns 404', async () => {
    const res = await request(app)
      .get('/api/customers/999999/address-from-zoho')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(404);
  });
});
