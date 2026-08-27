const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const MockZohoAdapter = require('../src/integrations/zoho/MockZohoAdapter');
const zoho = require('../src/integrations/zoho');

describe('Inventory & Stock Synchronization API', () => {
  let adminToken;
  let medrepToken;

  beforeAll(async () => {
    const adminRes = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = adminRes.body.data.token;

    const medrepRes = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrepRes.body.data.token;
  });

  test('GET /api/inventory/status returns status and product comparison', async () => {
    const res = await request(app)
      .get('/api/inventory/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('products');
    expect(res.body.data).toHaveProperty('summary');
    expect(Array.isArray(res.body.data.products)).toBe(true);
  });

  // Aug 27, 2026: 'sync-push' (created/edited items in Zoho) was removed —
  // inventory is read-only towards Zoho now. Confirm it's actually gone.
  test('POST /api/inventory/sync-push no longer exists (route removed — inventory is read-only towards Zoho)', async () => {
    const res = await request(app)
      .post('/api/inventory/sync-push')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  test('POST /api/inventory/sync-pull pulls stock from Zoho', async () => {
    const res = await request(app)
      .post('/api/inventory/sync-pull')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // Aug 27, 2026: a real Zoho item with no local counterpart used to be
  // silently dropped — "Pull from Zoho" against a real org with hundreds of
  // items but only the 10-item demo seed locally would report "0 updated"
  // and nothing would actually show up as selectable in the order form.
  // Now it's created locally (never written back to Zoho).
  describe('sync-pull creates new local products for unmatched Zoho items', () => {
    afterAll(() => {
      db.prepare(`DELETE FROM products WHERE zoho_item_id LIKE 'ITEM-FIX-%'`).run();
    });

    test('the 3 mock-fixture items (none match the demo seed by SKU/name) are created as new local products', async () => {
      db.prepare(`DELETE FROM products WHERE zoho_item_id LIKE 'ITEM-FIX-%'`).run();

      const res = await request(app)
        .post('/api/inventory/sync-pull')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(3);

      const created = db.prepare(`SELECT * FROM products WHERE zoho_item_id LIKE 'ITEM-FIX-%' ORDER BY sku`).all();
      expect(created).toHaveLength(3);
      const skus = created.map((p) => p.sku);
      expect(skus).toEqual(expect.arrayContaining(['AMOX-500-CAP', 'PARA-500-TAB', 'LOSA-50-TAB']));
      // Nothing here ever calls a Zoho write method — listItems() is a GET.
      const amox = created.find((p) => p.sku === 'AMOX-500-CAP');
      expect(amox.unit_price).toBe(8.5);
      expect(amox.is_active).toBe(1);
    });

    test('running it again does not duplicate — matches by zoho_item_id and updates instead', async () => {
      const before = db.prepare(`SELECT COUNT(*) as n FROM products WHERE zoho_item_id LIKE 'ITEM-FIX-%'`).get().n;
      expect(before).toBe(3);

      const res = await request(app)
        .post('/api/inventory/sync-pull')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(0);
      expect(res.body.data.updated).toBeGreaterThanOrEqual(3);

      const after = db.prepare(`SELECT COUNT(*) as n FROM products WHERE zoho_item_id LIKE 'ITEM-FIX-%'`).get().n;
      expect(after).toBe(3);
    });
  });

  test('POST /api/inventory/adjust adjusts stock level and reflects locally', async () => {
    const product = db.prepare('SELECT * FROM products LIMIT 1').get();
    const initialStock = product.stock;

    const res = await request(app)
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        product_id: product.id,
        delta: 10,
        reason: 'Restock batch #101'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.new_stock).toBe(initialStock + 10);

    const updated = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
    expect(updated.stock).toBe(initialStock + 10);
  });

  test('RBAC: MedRep cannot call admin inventory mutation endpoints', async () => {
    const product = db.prepare('SELECT * FROM products LIMIT 1').get();
    const res = await request(app)
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${medrepToken}`)
      .send({ product_id: product.id, delta: 1 });

    expect(res.status).toBe(403);
  });

  /**
   * Aug 27, 2026 (2): GET /api/inventory/status used to call zoho.listItems()
   * live on every request — a full multi-page Zoho pull on every page view
   * and every 30s auto-refresh. It's now a pure local read comparing
   * `stock` against a `zoho_stock` snapshot stamped by sync-pull, so the
   * page never blocks on Zoho.
   */
  describe('GET /api/inventory/status is local-only (no live Zoho call)', () => {
    test('does not call zoho.listItems — status stays fast/available even if Zoho would fail', async () => {
      const spy = jest.spyOn(zoho, 'listItems');

      const res = await request(app)
        .get('/api/inventory/status')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('sync-pull stamps zoho_stock/zoho_price; a later local-only adjust is what status reports as a mismatch (not a fresh Zoho call)', async () => {
      await request(app).post('/api/inventory/sync-pull').set('Authorization', `Bearer ${adminToken}`);

      const product = db.prepare(`SELECT * FROM products WHERE zoho_item_id IS NOT NULL LIMIT 1`).get();
      expect(product).toBeDefined();
      expect(product.zoho_stock).not.toBeNull();

      // Freshly synced — local stock should equal the stored Zoho snapshot.
      const statusAfterSync = await request(app)
        .get('/api/inventory/status')
        .set('Authorization', `Bearer ${adminToken}`);
      const row = statusAfterSync.body.data.products.find((p) => p.id === product.id);
      expect(row.sync_status).toBe('in_sync');
      expect(row.zoho_stock).toBe(product.zoho_stock);

      // Local-only adjust (never touches Zoho or the stored zoho_stock
      // snapshot) should now show as a mismatch, entirely from local data.
      await request(app)
        .post('/api/inventory/adjust')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ product_id: product.id, delta: 7, reason: 'test drift' });

      const statusAfterAdjust = await request(app)
        .get('/api/inventory/status')
        .set('Authorization', `Bearer ${adminToken}`);
      const rowAfter = statusAfterAdjust.body.data.products.find((p) => p.id === product.id);
      expect(rowAfter.sync_status).toBe('mismatch');
      expect(rowAfter.zoho_stock).toBe(product.zoho_stock); // snapshot unchanged
      expect(rowAfter.local_stock).toBe(product.stock + 7);
    });
  });
});
