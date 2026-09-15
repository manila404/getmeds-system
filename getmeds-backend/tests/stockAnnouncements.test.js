/**
 * Sep 15, 2026 — Dispatch's stock announcements.
 *
 * Confirmed with the business: about a product, with a message; shown to
 * MedReps and Management until Dispatch resolves it. A newer one about the
 * same product supersedes the open one.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('stock announcements', () => {
  let dispatchToken;
  let medrepToken;
  let productId;

  beforeAll(async () => {
    dispatchToken = await loginAs('dispatch@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    productId = (await db.prepare('SELECT id FROM products LIMIT 1').get()).id;
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM stock_announcements WHERE product_id = ?').run(productId);
  });

  const post = (body, token = dispatchToken) =>
    request(app).post('/api/stock-announcements').set(auth(token)).send(body);
  const open = async (token = medrepToken) =>
    (await request(app).get('/api/stock-announcements').set(auth(token))).body.data.announcements.filter((a) => a.product_id === productId);

  test('Dispatch posts one, and a MedRep sees it with the product named', async () => {
    const res = await post({ product_id: productId, kind: 'out_of_stock', message: 'Next delivery Sep 20' });
    expect(res.status).toBe(201);
    const list = await open();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(expect.objectContaining({ kind: 'out_of_stock', message: 'Next delivery Sep 20' }));
    expect(list[0].product_name).toBeTruthy();
    expect(list[0].created_by_name).toBeTruthy();
  });

  test('a newer one about the same product replaces the open one', async () => {
    await post({ product_id: productId, kind: 'out_of_stock' });
    await post({ product_id: productId, kind: 'back_in_stock' });
    const list = await open();
    expect(list.map((a) => a.kind)).toEqual(['back_in_stock']);
  });

  test('resolving takes it off the dashboards', async () => {
    const created = (await post({ product_id: productId, kind: 'low_stock' })).body.data.announcement;
    const res = await request(app).post(`/api/stock-announcements/${created.id}/resolve`).set(auth(dispatchToken));
    expect(res.status).toBe(200);
    expect(await open()).toHaveLength(0);
    expect((await request(app).post(`/api/stock-announcements/${created.id}/resolve`).set(auth(dispatchToken))).status).toBe(404);
  });

  test('a MedRep cannot post, and a bad kind or product is refused', async () => {
    expect((await post({ product_id: productId, kind: 'out_of_stock' }, medrepToken)).status).toBe(403);
    expect((await post({ product_id: productId, kind: 'gone' })).status).toBe(400);
    expect((await post({ product_id: 99999999, kind: 'out_of_stock' })).status).toBe(404);
    expect((await post({ kind: 'out_of_stock' })).status).toBe(400);
  });
});
