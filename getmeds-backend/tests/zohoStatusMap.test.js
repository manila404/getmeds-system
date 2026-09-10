/**
 * Sep 10, 2026 — an order's status mirrors Zoho.
 *
 * What this pins down, from the live org: 44,263 orders reported `fulfilled`
 * by Zoho and 15,105 reported `shipped` were all sitting at
 * 'ready_for_finance_verified' in this app, and not one order had ever been
 * marked completed. The import read `salesorder.status` alone, and the
 * reconcile tried to recover the rest by looking for packages and a tracking
 * number — which plenty of shipped orders in this org simply do not have.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { statusFromZoho, zohoStatusFields, FINANCE_VERIFICATION_NOTE } = require('../src/services/zohoStatusMap');

/** A Sales Order as the LIST endpoint returns it — all four axes present. */
const so = (over = {}) => ({
  salesorder_id: 'SOID-STATUS-1',
  salesorder_number: 'SO-STATUS-1',
  status: 'draft',
  order_status: 'draft',
  invoiced_status: '',
  paid_status: '',
  shipped_status: '',
  ...over
});

describe('Zoho status -> our workflow status', () => {
  describe('the four axes, not the rollup', () => {
    test('a draft Sales Order is so_created', () => {
      expect(statusFromZoho(so())).toBe('so_created');
    });

    test('open with nothing else done is awaiting Finance verification', () => {
      // The one stage that is OURS — Zoho has no equivalent. See
      // FINANCE_VERIFICATION_NOTE.
      expect(statusFromZoho(so({ status: 'confirmed', order_status: 'open' }))).toBe(
        'ready_for_finance_verified'
      );
    });

    test('invoiced but not shipped is ready for dispatch', () => {
      expect(
        statusFromZoho(so({ status: 'invoiced', order_status: 'open', invoiced_status: 'invoiced', paid_status: 'unpaid', shipped_status: 'not_shipped' }))
      ).toBe('ready_for_dispatch');
    });

    test('shipped is dispatched', () => {
      expect(
        statusFromZoho(so({ status: 'shipped', order_status: 'open', invoiced_status: 'invoiced', paid_status: 'paid', shipped_status: 'shipped' }))
      ).toBe('dispatched');
    });

    test('fulfilled and closed is completed', () => {
      // Confirmed with the business: this is genuinely done.
      expect(
        statusFromZoho(so({ status: 'fulfilled', order_status: 'closed', invoiced_status: 'invoiced', paid_status: 'paid', shipped_status: 'fulfilled' }))
      ).toBe('completed');
    });

    test('a fulfilled order with NO package is still completed', () => {
      // The case that broke everything. SO-61582 in the live org is invoiced,
      // paid and shipped_status=fulfilled with zero packages and no tracking
      // number — the shipment lives on the Sales Order as shipment_date +
      // delivery_method. The old logic needed a package to call it shipped, so
      // it never completed, and 44,263 orders looked unstarted.
      const order = so({
        status: 'fulfilled', order_status: 'closed',
        invoiced_status: 'invoiced', paid_status: 'paid', shipped_status: 'fulfilled',
        packages: [], invoices: [{ invoice_number: 'INV-1', status: 'paid' }],
        shipment_date: '2026-04-15', delivery_method: 'Lalamove'
      });
      expect(statusFromZoho(order)).toBe('completed');
    });

    test('a voided order is cancelled', () => {
      expect(statusFromZoho(so({ status: 'void' }))).toBe('cancelled');
    });

    test('nothing to go on returns null, so the caller leaves the order alone', () => {
      // Moving an order on no evidence is worse than leaving it where it is.
      expect(statusFromZoho({})).toBeNull();
      expect(statusFromZoho(so({ status: '', order_status: '' }))).toBeNull();
    });

    test('the most advanced axis wins', () => {
      // A fulfilled order is also invoiced and also shipped; the furthest point
      // reached is the one worth showing.
      expect(
        statusFromZoho(so({ status: 'fulfilled', order_status: 'closed', invoiced_status: 'invoiced', shipped_status: 'fulfilled' }))
      ).toBe('completed');
    });
  });

  describe('the axes are stored as Zoho reports them', () => {
    test('all four are captured and lower-cased', () => {
      const fields = zohoStatusFields(so({ status: 'Fulfilled', order_status: 'CLOSED', invoiced_status: 'Invoiced', paid_status: 'Paid', shipped_status: 'Fulfilled' }));
      expect(fields).toEqual({
        zoho_so_status: 'fulfilled',
        zoho_order_status: 'closed',
        zoho_invoiced_status: 'invoiced',
        zoho_paid_status: 'paid',
        zoho_shipped_status: 'fulfilled'
      });
    });

    test('a blank axis is stored as null, not an empty string', () => {
      // A draft Sales Order genuinely has no invoiced/paid/shipped status yet.
      const fields = zohoStatusFields(so());
      expect(fields.zoho_invoiced_status).toBeNull();
      expect(fields.zoho_paid_status).toBeNull();
    });
  });

  test('the Finance-verification note says where the check actually happened', () => {
    // An imported order never passed through this app's verification step, and
    // must not look as though it had — nor as though the control was skipped.
    expect(FINANCE_VERIFICATION_NOTE).toMatch(/google/i);
    expect(FINANCE_VERIFICATION_NOTE).toMatch(/thread/i);
  });
});

describe('Correcting orders already imported', () => {
  const orderIds = [];
  let adminToken, customer, adminUser;

  beforeAll(async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = a.body.data.token;
    adminUser = await db.prepare("SELECT * FROM users WHERE LOWER(role)='admin' LIMIT 1").get();
    customer = await db.prepare('SELECT * FROM customers LIMIT 1').get();
  });

  afterAll(async () => {
    for (const id of orderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  async function seed(ref, status) {
    const now = new Date().toISOString();
    const info = await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_sync_status, zoho_so_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'direct', 100, 'See Zoho', 'synced', ?, ?, ?)`
      )
      .run(ref, customer.id, adminUser.id, status, `SOID-${ref}`, now, now);
    orderIds.push(info.lastInsertRowid);
    return info.lastInsertRowid;
  }

  test('a finished Zoho order stops claiming it awaits Finance verification', async () => {
    const id = await seed('ZOHO-STATUSTEST-1', 'ready_for_finance_verified');
    const { syncStatusesFromList } = require('../src/services/zohoOrderImportService');
    // Exercised through the import's own loadKnownOrders shape.
    const known = {
      byZohoId: new Map([
        ['SOID-ZOHO-STATUSTEST-1', {
          id, getmeds_order_id: 'ZOHO-STATUSTEST-1', status: 'ready_for_finance_verified',
          zoho_order_status: null, zoho_invoiced_status: null, zoho_paid_status: null, zoho_shipped_status: null
        }]
      ]),
      byRef: new Map()
    };

    const res = await syncStatusesFromList(
      [so({ salesorder_id: 'SOID-ZOHO-STATUSTEST-1', status: 'fulfilled', order_status: 'closed', invoiced_status: 'invoiced', paid_status: 'paid', shipped_status: 'fulfilled' })],
      known,
      adminUser
    );

    expect(res.statusChanged).toBe(1);
    const saved = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    expect(saved.status).toBe('completed');
    expect(saved.zoho_paid_status).toBe('paid');
    expect(saved.zoho_shipped_status).toBe('fulfilled');
  });

  test('the correction is recorded, and says where verification really happened', async () => {
    const id = orderIds[orderIds.length - 1];
    const ev = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_STATUS_SYNCED'")
      .all(id);
    expect(ev).toHaveLength(1);
    expect(ev[0].old_status).toBe('ready_for_finance_verified');
    expect(ev[0].new_status).toBe('completed');
    // An order jumping to completed never passed this app's Finance step. The
    // trail should point at the Google thread rather than leave a gap that
    // reads like a skipped control.
    expect(ev[0].notes).toMatch(/google/i);
  });

  test('running it again changes nothing and adds no second entry', async () => {
    const id = orderIds[orderIds.length - 1];
    const { syncStatusesFromList } = require('../src/services/zohoOrderImportService');
    const row = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    const known = { byZohoId: new Map([['SOID-ZOHO-STATUSTEST-1', { ...row }]]), byRef: new Map() };

    const res = await syncStatusesFromList(
      [so({ salesorder_id: 'SOID-ZOHO-STATUSTEST-1', status: 'fulfilled', order_status: 'closed', invoiced_status: 'invoiced', paid_status: 'paid', shipped_status: 'fulfilled' })],
      known,
      adminUser
    );

    expect(res.statusChanged).toBe(0);
    const ev = await db
      .prepare("SELECT COUNT(*) c FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_STATUS_SYNCED'")
      .get(id);
    expect(ev.c).toBe(1);
  });

  test('an order raised in THIS app is never touched', async () => {
    // Those went through the real workflow and their status is the product of
    // it. Only the ZOHO- prefix keeps them out.
    const id = await seed('GM-STATUSTEST-9', 'draft');
    const { syncStatusesFromList } = require('../src/services/zohoOrderImportService');
    const known = {
      byZohoId: new Map([['SOID-GM-STATUSTEST-9', { id, getmeds_order_id: 'GM-STATUSTEST-9', status: 'draft' }]]),
      byRef: new Map()
    };

    const res = await syncStatusesFromList(
      [so({ salesorder_id: 'SOID-GM-STATUSTEST-9', status: 'fulfilled', order_status: 'closed' })],
      known,
      adminUser
    );

    expect(res.statusChanged).toBe(0);
    const saved = await db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
    expect(saved.status).toBe('draft');
  });
});
