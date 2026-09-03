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

  test('RBAC: MedRep cannot view the Clients Directory', async () => {
    const res = await request(app)
      .get('/api/customers')
      .set('Authorization', `Bearer ${medrepToken}`);
    expect(res.status).toBe(403);
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
