// Must be set before src/app (and the controller under it) is required —
// the timeout is read once, at module load.
process.env.ZOHO_OPEN_REFRESH_TIMEOUT_MS = '150';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

/**
 * GET /api/orders/:id must ALWAYS return the order.
 *
 * Sep 1, 2026 (4), written after this broke for real. Refreshing an order from
 * Zoho when someone opens it was added as a convenience; it was not wrapped,
 * and on a database that hadn't been migrated yet the stamp write threw "no
 * such column: last_reconciled_at". The exception escaped the handler and the
 * Order Detail page rendered "Failed to load order" — the page whose whole
 * purpose is showing the order was taken down by an optional extra.
 *
 * The contract these lock in: showing the order is guaranteed, refreshing it
 * is best-effort. A missing column, a Zoho outage, or a Zoho call that simply
 * never comes back must each degrade to "here is the order as we have it".
 */
describe('Order detail survives anything the Zoho refresh does', () => {
  let token;
  let orderId;
  const cleanup = [];

  beforeAll(async () => {
    const medrep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    const customer = await db.prepare('SELECT id FROM customers LIMIT 1').get();
    const existing = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get('OPEN-RESIL-1');
    if (existing) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    orderId = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_sync_status)
         VALUES ('OPEN-RESIL-1', ?, ?, 'so_created', 'credit', 500, 'Manila', 'ZSO-RESIL', 'synced')`
      )
      .run(customer.id, medrep.id)).lastInsertRowid;
    cleanup.push(orderId);

    const login = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    token = login.body.data.token;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Clear the cooldown so each test actually exercises the refresh path.
    await db.prepare('UPDATE orders SET last_reconciled_at = NULL WHERE id = ?').run(orderId);
  });

  afterAll(async () => {
    for (const id of cleanup) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  test('a Zoho call that never returns does not hang the page', async () => {
    // Never resolves. Without the timeout the request would hang until the
    // socket gave up and the user would sit on a spinner.
    jest.spyOn(zoho, 'getSalesOrder').mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const res = await request(app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.body.data.order.getmeds_order_id).toBe('OPEN-RESIL-1');
    expect(elapsed).toBeLessThan(3000); // the 150ms budget plus ordinary overhead
  });

  test('a Zoho error does not fail the page', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockRejectedValue(new Error('ECONNRESET'));
    const res = await request(app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.getmeds_order_id).toBe('OPEN-RESIL-1');
  });

  test('a synchronous throw inside the refresh does not fail the page', async () => {
    jest.spyOn(zoho, 'getSalesOrder').mockImplementation(() => {
      throw new TypeError('exploded before returning a promise');
    });
    const res = await request(app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.getmeds_order_id).toBe('OPEN-RESIL-1');
  });

  /**
   * The exact production failure: server on new code, database not migrated.
   *
   * Sep 3, 2026: rewritten for PostgreSQL. The SQLite version built a temp
   * database file from schema.sql with the column stripped by regex. The
   * Postgres equivalent is more direct and more honest — apply the real schema,
   * then DROP the column — which SQLite could not do at all, and which is the
   * same reason src/db/migrate.js had to rebuild whole tables.
   *
   * Still a child process: src/db/pg.js memoises one pool per process, and this
   * suite's own database HAS the column.
   */
  test('an un-migrated database (no last_reconciled_at) still serves the order', async () => {
    const BACKEND = path.join(__dirname, '..');
    const { Client } = require('pg');

    const baseUrl = process.env.DATABASE_URL;
    const nomigUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/getmeds_nomig_test$1');
    const adminUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS getmeds_nomig_test WITH (FORCE)');
      await admin.query('CREATE DATABASE getmeds_nomig_test');
    } finally {
      await admin.end();
    }

    try {
      const c = new Client({ connectionString: nomigUrl });
      await c.connect();
      try {
        await c.query(fs.readFileSync(path.join(BACKEND, 'src/db/schema.pg.sql'), 'utf8'));
        await c.query('ALTER TABLE orders DROP COLUMN last_reconciled_at');
        const cols = await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name='last_reconciled_at'"
        );
        expect(cols.rows).toHaveLength(0);
      } finally {
        await c.end();
      }

      execFileSync(process.execPath, [path.join(BACKEND, 'src/db/seed.js')], {
        cwd: BACKEND,
        env: { ...process.env, DATABASE_URL: nomigUrl, ZOHO_MODE: 'mock' },
        encoding: 'utf8',
      });

      const script = `
        const request = require('supertest');
        const app = require('${path.join(BACKEND, 'src/app.js').replace(/\\/g, '\\\\')}');
        const db = require('${path.join(BACKEND, 'src/db/database.js').replace(/\\/g, '\\\\')}');
        (async () => {
          await db.init();
          const u = await db.prepare("SELECT id FROM users WHERE role='medrep' LIMIT 1").get();
          // seed.js no longer creates demo customers (Sep 2) - the mirror is
          // Zoho's job - so this fixture makes its own instead of assuming one.
          const cr = await db.prepare("INSERT INTO customers (name, type) VALUES ('NOMIG Test Customer','credit')").run();
          const orow = await db.prepare("INSERT INTO orders (getmeds_order_id,customer_id,medrep_id,status,customer_type,total_amount,delivery_address,zoho_so_id) VALUES ('NOMIG-1',?,?,'so_created','credit',100,'Manila','ZSO-NOMIG')").run(cr.lastInsertRowid, u.id);
          const l = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
          const r = await request(app).get('/api/orders/' + orow.lastInsertRowid).set('Authorization', 'Bearer ' + l.body.data.token);
          process.stdout.write('RESULT:' + r.status + ':' + (r.body?.data?.order?.getmeds_order_id || ''));
          process.exit(0);
        })();
      `;

      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: BACKEND,
        env: { ...process.env, DATABASE_URL: nomigUrl, ZOHO_MODE: 'mock' },
        encoding: 'utf8',
      });

      expect(out).toContain('RESULT:200:NOMIG-1');
    } finally {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query('DROP DATABASE IF EXISTS getmeds_nomig_test WITH (FORCE)');
      } finally {
        await cleanup.end();
      }
    }
  }, 60000);
});
