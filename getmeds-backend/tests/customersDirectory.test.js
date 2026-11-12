/**
 * Coverage for the Aug 27, 2026 Clients Directory feature:
 *  - GET /api/customers now supports pagination (default 25/page, matching
 *    the Inventory page), plus ?search/?category/?type filters.
 *  - PATCH /api/customers/:id/category sets/clears a purely local
 *    classification tag (doctor/hospital/distributor/pwd) and never
 *    touches `type` (credit/direct) or Zoho.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

describe('Customers — Clients Directory (pagination, filters, category)', () => {
  let adminToken;
  let medrepToken;
  const seededIds = [];

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = adminRes.body.data.token;

    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;

    // Seed enough local customers to exercise pagination beyond one page.
    const insert = db.prepare(`
      INSERT INTO customers (name, type, contact_person, contact_number, source, is_active)
      VALUES (?, 'direct', ?, ?, 'local', 1)
    `);
    for (let i = 0; i < 30; i++) {
      const info = await insert.run(`Directory Test Client ${String(i).padStart(2, '0')}`, 'Test Contact', '09170000000');
      seededIds.push(info.lastInsertRowid);
    }
  });

  afterAll(async () => {
    for (const id of seededIds) {
      await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
  });

  // Nov 12, 2026: was 'MedRep cannot view the Clients Directory'. MedReps and Team Leads now read
  // it (read-only, narrowed fields) — see the 'sales viewers' describe at the bottom. Roles that
  // still have no business here are asserted below instead.
  test('RBAC: Finance and Dispatch still cannot view the Clients Directory', async () => {
    for (const email of ['finance@getmeds.ph', 'dispatch@getmeds.ph']) {
      const login = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
      if (login.status !== 200) continue; // seed account absent in this environment
      const res = await request(app).get('/api/customers').set('Authorization', `Bearer ${login.body.data.token}`);
      expect(res.status).toBe(403);
    }
  });

  test('GET /api/customers defaults to 25 per page and reports pagination metadata', async () => {
    const res = await request(app)
      .get('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.customers.length).toBe(25);
    expect(res.body.data.pagination.limit).toBe(25);
    expect(res.body.data.pagination.page).toBe(1);
    expect(res.body.data.pagination.total).toBeGreaterThanOrEqual(30);
    expect(res.body.data.pagination.pages).toBeGreaterThan(1);
  });

  test('GET /api/customers?page=2 returns the next page, no overlap with page 1', async () => {
    const page1 = await request(app)
      .get('/api/customers?page=1&limit=25')
      .set('Authorization', `Bearer ${adminToken}`);
    const page2 = await request(app)
      .get('/api/customers?page=2&limit=25')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(page2.status).toBe(200);
    const page1Ids = new Set(page1.body.data.customers.map((c) => c.id));
    const overlap = page2.body.data.customers.filter((c) => page1Ids.has(c.id));
    expect(overlap.length).toBe(0);
  });

  test('GET /api/customers?search filters by name', async () => {
    const res = await request(app)
      .get('/api/customers?search=Directory Test Client 05')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.customers.length).toBe(1);
    expect(res.body.data.customers[0].name).toBe('Directory Test Client 05');
  });

  test('PATCH /api/customers/:id/category sets a category without touching type', async () => {
    const target = seededIds[0];
    const res = await request(app)
      .patch(`/api/customers/${target}/category`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'doctor' });

    expect(res.status).toBe(200);
    expect(res.body.data.customer.category).toBe('doctor');
    expect(res.body.data.customer.type).toBe('direct');
  });

  test('PATCH /api/customers/:id/category rejects an invalid category', async () => {
    const target = seededIds[1];
    const res = await request(app)
      .patch(`/api/customers/${target}/category`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'not-a-real-category' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CATEGORY');
  });

  test('Patient is a category: it can be set, filtered on, and is stored', async () => {
    const target = seededIds[2];
    const set = await request(app)
      .patch(`/api/customers/${target}/category`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'patient' });
    expect(set.status).toBe(200);
    expect(set.body.data.customer.category).toBe('patient');

    const list = await request(app)
      .get('/api/customers?category=patient')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.customers.some((c) => c.id === target)).toBe(true);
    expect(list.body.data.customers.every((c) => c.category === 'patient')).toBe(true);
  });

  test('PATCH /api/customers/:id/category with null clears an existing category', async () => {
    const target = seededIds[0];
    const res = await request(app)
      .patch(`/api/customers/${target}/category`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: null });

    expect(res.status).toBe(200);
    expect(res.body.data.customer.category).toBeNull();
  });

  test('GET /api/customers?category=doctor filters to only that category', async () => {
    const target = seededIds[2];
    await request(app)
      .patch(`/api/customers/${target}/category`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'hospital' });

    const res = await request(app)
      .get('/api/customers?category=hospital')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.customers.every((c) => c.category === 'hospital')).toBe(true);
    expect(res.body.data.customers.some((c) => c.id === target)).toBe(true);
  });

  test('RBAC: MedRep cannot set a customer category', async () => {
    const res = await request(app)
      .patch(`/api/customers/${seededIds[3]}/category`)
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({ category: 'pwd' });
    expect(res.status).toBe(403);
  });
});

/**
 * Aug 27, 2026 (2): GET /api/customers/stats — one grouped local query
 * replacing the 4 separate `?limit=1` round trips the Clients Directory
 * page used to make for its KPI cards.
 */
describe('Customers — GET /api/customers/stats', () => {
  let adminToken;
  let medrepToken;
  const seededIds = [];

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = adminRes.body.data.token;
    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;

    const insert = db.prepare(`
      INSERT INTO customers (name, type, category, source, is_active)
      VALUES (?, ?, ?, 'local', 1)
    `);
    seededIds.push((await insert.run('Stats Test Credit Doctor', 'credit', 'doctor')).lastInsertRowid);
    seededIds.push((await insert.run('Stats Test Direct Uncategorized', 'direct', null)).lastInsertRowid);
  });

  afterAll(async () => {
    for (const id of seededIds) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  });

  test('returns total/credit/direct/uncategorized counts in a single request', async () => {
    const res = await request(app)
      .get('/api/customers/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { total, credit, direct, uncategorized } = res.body.data;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(credit).toBeGreaterThanOrEqual(1);
    expect(direct).toBeGreaterThanOrEqual(1);
    expect(uncategorized).toBeGreaterThanOrEqual(1);

    // Cross-check against the paginated list endpoint's own totals so the
    // two never silently drift apart.
    const listRes = await request(app)
      .get('/api/customers?limit=1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(total).toBe(listRes.body.data.pagination.total);
  });

  test('RBAC: MedRep cannot view client stats', async () => {
    const res = await request(app)
      .get('/api/customers/stats')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(403);
  });
});


/**
 * Nov 12, 2026: MedReps and Team Leads read the Clients Directory, read-only.
 *
 * What must hold, and why each is asserted separately:
 *  - they can list it (the feature),
 *  - the row is cut down to the allow-list (a TIN or Zoho id leaking to a rep is silent: the
 *    page looks fine and nobody notices until someone reads the network tab),
 *  - ?mine=1 narrows to customers on orders in their scope (a MedRep: their own; a Team Lead:
 *    their team's),
 *  - every write and sync route stays closed to them.
 */
describe('Customers — Clients Directory for sales viewers (MedRep / Team Lead)', () => {
  const created = { users: [], orders: [], customers: [] };
  let medrepToken;
  let medrepId;
  let leadToken;
  let outsiderToken;
  let tiedId;
  let otherId;
  let teamTiedId;

  const login = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
    if (res.status !== 200) throw new Error(`Login failed for ${email}`);
    return res.body.data.token;
  };
  const makeUser = async (role, email, name, teamLeadId = null) => {
    const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
    const info = await db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, is_active, created_at, approval_status, team_lead_id)
         VALUES (?, ?, ?, ?, 1, ?, 'approved', ?)`
      )
      .run(name, email, seed.password_hash, role, new Date().toISOString(), teamLeadId);
    created.users.push(info.lastInsertRowid);
    return info.lastInsertRowid;
  };
  const makeCustomer = async (name) => {
    const info = await db
      .prepare(
        `INSERT INTO customers (name, type, contact_person, contact_number, source, is_active, tin, zoho_contact_id, credit_limit)
         VALUES (?, 'direct', 'Contact', '09171234567', 'zoho', 1, 'TIN-SECRET-123', ?, 5000)`
      )
      .run(name, `ZOHO-SECRET-ID-${name.replace(/\s+/g, '-')}`);
    created.customers.push(info.lastInsertRowid);
    return info.lastInsertRowid;
  };
  const plantOrder = async (key, customerId, medrepId) => {
    const now = new Date().toISOString();
    const info = await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type,
                             total_amount, delivery_address, delivery_notes, zoho_sync_status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'pending_management_approval', 'direct', 100, 'Dir Test St', 'n', 'pending', ?, ?)`
      )
      .run(`GM-DIRVIEW-${key}`, customerId, medrepId, now, now);
    created.orders.push(info.lastInsertRowid);
  };

  beforeAll(async () => {
    medrepToken = await login('medrep@getmeds.ph');
    medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;

    const leadId = await makeUser('team_lead', 'dirview.lead@getmeds.ph', 'Dir View Lead');
    const memberId = await makeUser('medrep', 'dirview.member@getmeds.ph', 'Dir View Member', leadId);
    await makeUser('medrep', 'dirview.outsider@getmeds.ph', 'Dir View Outsider');
    leadToken = await login('dirview.lead@getmeds.ph');
    outsiderToken = await login('dirview.outsider@getmeds.ph');

    tiedId = await makeCustomer('DirView Tied Pharmacy');
    otherId = await makeCustomer('DirView Untied Pharmacy');
    teamTiedId = await makeCustomer('DirView Team Pharmacy');
    await plantOrder('own', tiedId, medrepId);
    await plantOrder('team', teamTiedId, memberId);
  });

  afterAll(async () => {
    for (const id of created.orders) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of created.customers) await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    // Newest first: members point at the lead through team_lead_id, so they go before it.
    for (const id of [...created.users].reverse()) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  test('a MedRep can list the directory', async () => {
    const res = await request(app).get('/api/customers?search=DirView').set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.customers.map((c) => c.id)).toEqual(expect.arrayContaining([tiedId, otherId, teamTiedId]));
  });

  test('a MedRep gets only the allow-listed fields: no TIN, Zoho id or credit figures', async () => {
    const res = await request(app).get('/api/customers?search=DirView').set('Authorization', `Bearer ${medrepToken}`);
    const row = res.body.data.customers.find((c) => c.id === tiedId);
    expect(row.name).toBe('DirView Tied Pharmacy');
    for (const hidden of ['tin', 'zoho_contact_id', 'credit_limit', 'outstanding_receivable', 'source', 'zoho_pending_payload']) {
      expect(row).not.toHaveProperty(hidden);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/TIN-SECRET-123|ZOHO-SECRET-ID/);
  });

  test('?mine=1 returns only customers on the MedRep\'s own orders', async () => {
    const res = await request(app).get('/api/customers?mine=1&search=DirView').set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.customers.map((c) => c.id);
    expect(ids).toContain(tiedId);
    expect(ids).not.toContain(otherId);
    expect(ids).not.toContain(teamTiedId);
  });

  test('?mine=1 for a MedRep with no orders is empty, never the whole directory', async () => {
    const res = await request(app).get('/api/customers?mine=1').set('Authorization', `Bearer ${outsiderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.customers).toEqual([]);
    expect(res.body.data.pagination.total).toBe(0);
  });

  test('?mine=1 for a Team Lead covers their team\'s orders, not unrelated customers', async () => {
    const res = await request(app).get('/api/customers?mine=1&search=DirView').set('Authorization', `Bearer ${leadToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.customers.map((c) => c.id);
    expect(ids).toContain(teamTiedId);
    expect(ids).not.toContain(tiedId); // another MedRep's, outside this lead's team
    expect(ids).not.toContain(otherId);
  });

  test('sales viewers cannot force the inactive list', async () => {
    const res = await request(app).get('/api/customers?status=inactive').set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.customers.every((c) => c.is_active === 1)).toBe(true);
  });

  test('every write, sync and detail route stays closed to them', async () => {
    for (const token of [medrepToken, leadToken]) {
      const auth = { Authorization: `Bearer ${token}` };
      expect((await request(app).get('/api/customers/stats').set(auth)).status).toBe(403);
      expect((await request(app).get(`/api/customers/${tiedId}/details`).set(auth)).status).toBe(403);
      expect((await request(app).patch(`/api/customers/${tiedId}/category`).set(auth).send({ category: 'pwd' })).status).toBe(403);
      expect((await request(app).patch(`/api/customers/${tiedId}/tin`).set(auth).send({ tin: '1' })).status).toBe(403);
      expect((await request(app).post('/api/customers/sync-from-zoho/start?mode=quick').set(auth)).status).toBe(403);
    }
  });
});
