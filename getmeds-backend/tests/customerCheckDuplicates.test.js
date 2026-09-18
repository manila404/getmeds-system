/**
 * Sep 18, 2026 — "does a customer that looks like this already exist?",
 * asked from the New Customer modal BEFORE anything is created.
 *
 * createCustomer's own duplicate check (findDuplicates) only ever caught an
 * EXACT name or LTO licence, and blocked outright with no way past it. This
 * endpoint runs the fuzzy matcher already trusted for the held-customer-to-
 * Zoho push review (see customerDuplicateReview.test.js) one step earlier —
 * a typo, a shared phone, a matching TIN — as a dismissible warning, while
 * the two EXACT reasons stay non-overridable, since createCustomer would
 * refuse them regardless.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const tag = () => `Cd${uniq()}`;
const created = [];
let medrepToken;
let dispatchToken;

async function insertZohoCustomer({ name, tin = null, phone = null, lto = null }) {
  await db
    .prepare(
      `INSERT INTO customers (name, type, contact_number, address, source, zoho_contact_id, tin, lto_license_number,
                              is_active, created_at, zoho_sync_status)
       VALUES (?, 'direct', ?, '1 Check St', 'zoho', ?, ?, ?, 1, ?, 'synced')`
    )
    .run(name, phone, `ZC-CHK-${uniq()}`, tin, lto, new Date().toISOString());
  const row = await db.prepare('SELECT * FROM customers WHERE name = ? ORDER BY id DESC LIMIT 1').get(name);
  created.push(row.id);
  return row;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const check = (body, token = medrepToken) => request(app).post('/api/customers/check-duplicates').set(auth(token)).send(body);

describe('POST /api/customers/check-duplicates', () => {
  beforeAll(async () => {
    const m = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = m.body.data.token;
    const d = await request(app).post('/api/auth/login').send({ email: 'dispatch@getmeds.ph', password: 'demo123' });
    dispatchToken = d.body.data.token;
  });

  afterAll(async () => {
    for (const id of created) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  test('nothing to check against — empty', async () => {
    const res = await check({ display_name: `${tag()} Nobody Like This` });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.matches).toEqual([]);
  });

  test('a similar (not identical) name is a match, and overridable', async () => {
    const t = tag();
    const inZoho = await insertZohoCustomer({ name: `${t} 1ST SPECIALTY PHARMA` });
    const res = await check({ display_name: `${t} 1ST SPECIALITY PHARMA` });
    expect(res.statusCode).toBe(200);
    const match = res.body.data.matches.find((m) => m.id === inZoho.id);
    expect(match).toBeTruthy();
    expect(match.matched).toContain('similar_name');
    expect(match.overridable).toBe(true);
  });

  test('an identical name is a match, and NOT overridable — createCustomer refuses it regardless', async () => {
    const t = tag();
    const inZoho = await insertZohoCustomer({ name: `${t} Exact Match Pharmacy` });
    const res = await check({ display_name: ` ${t} EXACT MATCH PHARMACY ` });
    const match = res.body.data.matches.find((m) => m.id === inZoho.id);
    expect(match.matched).toContain('same_name');
    expect(match.overridable).toBe(false);
  });

  test('a matching LTO licence is NOT overridable — Zoho enforces it as unique', async () => {
    const t = tag();
    const lto = `LTO-CHK-${uniq()}`;
    const inZoho = await insertZohoCustomer({ name: `${t} Licence Holder Drugstore`, lto });
    const res = await check({ display_name: `${t} Something Entirely Different`, lto_license_number: lto });
    const match = res.body.data.matches.find((m) => m.id === inZoho.id);
    expect(match.matched).toContain('lto');
    expect(match.overridable).toBe(false);
  });

  test('a matching TIN alone (different name) is overridable', async () => {
    const t = tag();
    const inZoho = await insertZohoCustomer({ name: `${t} Alpha Medical`, tin: '123456789-001' });
    const res = await check({ display_name: `${t} Omega Clinic`, tin: '123-456-789-000' });
    const match = res.body.data.matches.find((m) => m.id === inZoho.id);
    expect(match.matched).toContain('tin');
    expect(match.overridable).toBe(true);
  });

  test('nothing is created and Zoho is never called — read-only', async () => {
    const t = tag();
    await insertZohoCustomer({ name: `${t} Read Only Pharmacy` });
    const before = (await db.prepare("SELECT COUNT(*) AS c FROM customers WHERE source = 'zoho'").get()).c;
    const spy = jest.spyOn(zoho, 'createContact');
    try {
      await check({ display_name: `${t} Read Only Pharmacy` });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const after = (await db.prepare("SELECT COUNT(*) AS c FROM customers WHERE source = 'zoho'").get()).c;
    expect(after).toBe(before);
  });

  test('Dispatch cannot call this — same roles as creating a customer', async () => {
    const res = await check({ display_name: `${tag()} Whoever` }, dispatchToken);
    expect(res.statusCode).toBe(403);
  });

  // Confirms the actual promise the `overridable` flag makes: "create anyway"
  // on a SOFT match really does succeed through createCustomer's own
  // (unrelated, exact-only) check — the two checks were built separately and
  // must not quietly disagree with each other.
  test('a soft match (TIN only, different name) really does create successfully — createCustomer does not also block it', async () => {
    const t = tag();
    await insertZohoCustomer({ name: `${t} Alpha Medical Two`, tin: '223456789-001' });
    const pre = await check({ display_name: `${t} Omega Clinic Two`, tin: '223-456-789-000' });
    const match = pre.body.data.matches.find((m) => m.name === `${t} Alpha Medical Two`);
    expect(match.overridable).toBe(true);

    const res = await request(app)
      .post('/api/customers')
      .set(auth(medrepToken))
      .send({
        display_name: `${t} Omega Clinic Two`,
        contact_number: '+639170000001',
        phone: '+639170000001',
        tin: '223-456-789-000',
        billing_address: { address: '1 Different Ave', phone: '+639170000001' }
      });
    expect(res.statusCode).toBe(201);
    created.push(res.body.data.customer.id);
  });
});
