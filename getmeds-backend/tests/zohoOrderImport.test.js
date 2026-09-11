/**
 * Sep 9, 2026 — "retrieve every Sales Order that exists in Zoho".
 *
 * Covers services/zohoOrderImportService.js and the two endpoints on top of
 * it. The three things worth asserting, because each of them is a way this
 * feature could go quietly wrong rather than loudly:
 *
 *   1. An order raised in Zoho and never seen here is ADOPTED, with Zoho's own
 *      history mirrored into its trail — not just a row with a status on it.
 *   2. Running it twice does not duplicate anything. This is the one that
 *      matters most: the button invites repeated pressing (that is how a large
 *      history is imported), so a non-idempotent import would double every
 *      trail on the second click.
 *   3. A Sales Order whose reference_number matches an order already here is
 *      LINKED to it, not adopted as a second copy of it.
 *
 * Runs against the mock adapter (ZOHO_MODE=mock, set in tests/setupEnv.js), so
 * nothing here touches a real Zoho org.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const {
  importSalesOrders,
  enrichPendingDetail,
  countAwaitingDetail
} = require('../src/services/zohoOrderImportService');

const SALESPERSON = 'TEST | Admin User';

/** Every order this file created, so the shared scratch database is left clean. */
const createdOrderIds = [];
const createdCustomerIds = [];
const createdProductIds = [];

async function eventsFor(orderId) {
  return db
    .prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id')
    .all(orderId);
}

async function orderByZohoSoId(salesorderId) {
  return db.prepare('SELECT * FROM orders WHERE zoho_so_id = ?').get(String(salesorderId));
}

describe('Zoho Sales Order import', () => {
  let adminToken;
  let medrepToken;

  beforeAll(async () => {
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
    adminToken = admin.body.data.token;
    const medrep = await request(app).post('/api/auth/login').send({ email: 'medrep@getmeds.ph', password: 'demo123' });
    medrepToken = medrep.body.data.token;

    // A local product carrying a Zoho item id, so the line-item matching path
    // is exercised rather than every line falling through to "unmatched".
    const p = await db
      .prepare(
        `INSERT INTO products (name, sku, unit_price, unit, stock, is_active, zoho_item_id)
         VALUES ('IMPORT Losartan 50mg', 'IMP-LOSA-50', 12.0, 'tab', 50, 1, 'ITEM-FIX-0003')`
      )
      .run();
    createdProductIds.push(p.lastInsertRowid);
  });

  afterAll(async () => {
    // Delete in foreign-key order — events and items, then orders, then the
    // customers and products those orders pointed at. Anything else fails on
    // orders_customer_id_fkey / order_items_product_id_fkey.
    //
    // And by PATTERN, not by tracked id: the import's first tier adopts every
    // Sales Order the mock holds in one batched INSERT, so most of the rows
    // this suite creates were never handed back to it to remember. Only this
    // suite creates ZOHO-% orders on the scratch database.
    const rows = await db
      .prepare("SELECT id FROM orders WHERE getmeds_order_id LIKE 'ZOHO-%' OR getmeds_order_id LIKE 'GM-IMPORTTEST-%'")
      .all();
    const ids = [...new Set([...createdOrderIds, ...rows.map((o) => o.id)])];

    for (const id of ids) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    await db.prepare("DELETE FROM customers WHERE zoho_contact_id LIKE 'CONTACT-FIX-%'").run();
    for (const id of createdProductIds) {
      await db.prepare('DELETE FROM products WHERE id = ?').run(id);
    }
  });

  test('adopts a Sales Order that exists only in Zoho, and mirrors its history into the trail', async () => {
    const created = await zoho.createSalesOrder({
      getmeds_order_id: 'NOT-A-LOCAL-ORDER-1',
      customer_name: 'St. Luke Medical Center (Fixture)',
      customer_type: 'credit',
      zoho_customer_id: 'CONTACT-FIX-1001',
      salesperson_name: SALESPERSON,
      total_amount: 240,
      delivery_address: '279 E Rodriguez Sr. Ave, Quezon City',
      items: [{ zoho_item_id: 'ITEM-FIX-0003', sku: 'LOSA-50-TAB', name: 'Losartan 50mg Tablet', quantity: 20, unit_price: 12, subtotal: 240 }]
    });
    const soId = created.salesorder.salesorder_id;

    const summary = await importSalesOrders({ mode: 'full' });
    expect(summary.imported).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);

    const order = await orderByZohoSoId(soId);
    expect(order).toBeTruthy();
    createdOrderIds.push(order.id);
    createdCustomerIds.push(order.customer_id);

    // Adopted orders are named after the Zoho Sales Order, never given a GM- id
    // — an imported order must never be mistakable for one this app raised.
    expect(order.getmeds_order_id).toBe(`ZOHO-${created.salesorder.salesorder_number}`);
    expect(order.status).toBe('so_created');
    expect(order.total_amount).toBe(240);

    // Zoho's Salesperson is recorded ON the order. An adopted order's
    // medrep_id is the admin that ran the import, so a reader that joins
    // through users to name the salesperson would name that admin against
    // every imported order — which is what the Management Dashboard did.
    expect(order.salesperson).toBe(SALESPERSON);

    // The line item matched a local product, so it is a real order line rather
    // than a note about a line that could not be matched.
    const items = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(20);

    const events = await eventsFor(order.id);
    const types = events.map((e) => e.event_type);

    // Both halves of the trail: this app's account of the import, and Zoho's
    // own history read across.
    //
    // Sep 10, 2026: the history no longer lands as a generic 'ZOHO_LOG'. It is
    // classified into the same milestone types the reconcile uses, which is
    // what stops the two paths recording the same confirmation twice — see
    // services/zohoHistoryService.js.
    expect(types).toContain('ORDER_IMPORTED_FROM_ZOHO');
    expect(types).toContain('ZOHO_SO_CREATED');

    const log = events.find((e) => e.event_type === 'ZOHO_SO_CREATED');
    expect(log.notes).toBeTruthy();
    // The Zoho comment id is what makes re-import idempotent, so it has to be
    // on the row, not merely used and thrown away.
    expect(JSON.parse(log.metadata).zohoCommentId).toBeTruthy();
    // actor_id stays null on purpose — the person named is a Zoho user, and
    // users(id) is this app's own table.
    expect(log.actor_id).toBeNull();
    expect(log.actor_name).toBeTruthy();
  });

  test('adopts EVERY Sales Order even when the detail budget covers only one', async () => {
    // The point of the two-tier import. Zoho has 65,000+ Sales Orders in the
    // real org and pulling each one's detail is two API calls, so the detail
    // budget can only ever cover a slice — but the Orders list must still show
    // all of them. Adoption runs off the list walk that already happened and
    // is deliberately NOT bounded by that budget.
    const made = [];
    for (let i = 0; i < 3; i++) {
      const created = await zoho.createSalesOrder({
        getmeds_order_id: `NOT-A-LOCAL-ORDER-BULK-${i}`,
        customer_name: 'Juana Dela Cruz (Fixture)',
        customer_type: 'direct',
        zoho_customer_id: 'CONTACT-FIX-1002',
        salesperson_name: SALESPERSON,
        total_amount: 50 + i,
        delivery_address: 'Unit 402, Greenhills Tower',
        items: [{ name: 'Paracetamol 500mg Tablet', quantity: 1, unit_price: 50 + i, subtotal: 50 + i }]
      });
      made.push(created.salesorder);
    }

    const summary = await importSalesOrders({ mode: 'full', detailLimit: 1 });

    expect(summary.imported).toBe(3);   // all three adopted…
    expect(summary.detailed).toBe(1);   // …but only one got the expensive read
    expect(summary.awaiting_detail).toBeGreaterThanOrEqual(2);

    for (const so of made) {
      const order = await orderByZohoSoId(so.salesorder_id);
      expect(order).toBeTruthy();
      // Adopted from list data alone: real number, customer, total and
      // salesperson, with the address left as the placeholder until its detail
      // is pulled.
      expect(order.getmeds_order_id).toBe(`ZOHO-${so.salesorder_number}`);
      expect(order.total_amount).toBe(Number(so.total));
      expect(order.salesperson).toBe(SALESPERSON);

      const types = (await eventsFor(order.id)).map((e) => e.event_type);
      expect(types).toContain('ORDER_IMPORTED_FROM_ZOHO');
    }

    // Exactly one of the three carries its detail so far; the other two are
    // waiting their turn, not broken.
    let withDetail = 0;
    for (const so of made) {
      const o = await orderByZohoSoId(so.salesorder_id);
      if (o.zoho_detail_synced_at) withDetail++;
    }
    expect(withDetail).toBe(1);
  });

  test('a repeated run takes the NEXT batch of orders needing detail', async () => {
    const before = await db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id IS NOT NULL AND zoho_detail_synced_at IS NULL")
      .get();
    expect(before.c).toBeGreaterThan(0);

    const summary = await importSalesOrders({ mode: 'full', detailLimit: 1 });

    // Nothing new to adopt — everything is already here — but the detail
    // backlog moved by one. This is what makes repeated presses of the button
    // converge on a large history instead of re-taking the same slice.
    expect(summary.imported).toBe(0);
    expect(summary.detailed).toBe(1);

    const after = await db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id IS NOT NULL AND zoho_detail_synced_at IS NULL")
      .get();
    expect(after.c).toBe(before.c - 1);
  });

  test('creates a local customer for a Zoho contact this app has never seen', async () => {
    // Named explicitly rather than "the most recent ZOHO- order" — several
    // tests here adopt orders, so "most recent" is whatever ran last.
    const customer = await db
      .prepare("SELECT * FROM customers WHERE zoho_contact_id = 'CONTACT-FIX-1001'")
      .get();

    expect(customer).toBeTruthy();
    // Tagged the same way the Clients Directory sync tags its rows, so the next
    // customer sync upserts onto this row instead of creating a duplicate.
    expect(customer.source).toBe('zoho');
    expect(customer.name).toBe('St. Luke Medical Center (Fixture)');
  });

  test('a second full import adopts nothing it already has', async () => {
    const before = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE getmeds_order_id LIKE 'ZOHO-%'").get();

    // A generous detail budget, so this is purely about adoption.
    const summary = await importSalesOrders({ mode: 'full', detailLimit: 50 });

    expect(summary.imported).toBe(0);
    // log_entries is NOT asserted to be zero: the order still waiting for its
    // detail gets its Zoho history on this run, which is the whole point of
    // the budget carrying over. Adoption is what must not repeat.

    const after = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE getmeds_order_id LIKE 'ZOHO-%'").get();
    expect(after.c).toBe(before.c);

    // And every order now has its detail, so a further run has nothing left to
    // spend the budget on either.
    const stillWaiting = await db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id IS NOT NULL AND zoho_detail_synced_at IS NULL")
      .get();
    expect(stillWaiting.c).toBe(0);
  });

  test('a quick sync re-reads what it is given and still writes no duplicates', async () => {
    // Quick mode processes everything the watermark walk returns, existing
    // orders included — a changed order is worth re-reading. The mock has no
    // watermark, so this exercises the "already here, refresh it" path over
    // every Sales Order in the fixture.
    const order = await db
      .prepare("SELECT * FROM orders WHERE getmeds_order_id LIKE 'ZOHO-%' ORDER BY id DESC LIMIT 1")
      .get();
    const before = await eventsFor(order.id);

    const summary = await importSalesOrders({ mode: 'quick' });

    expect(summary.imported).toBe(0);
    expect(summary.already_present).toBeGreaterThanOrEqual(1);
    expect(summary.log_entries).toBe(0);
    expect(await eventsFor(order.id)).toHaveLength(before.length);
  });

  test('links a Sales Order to the local order it belongs to instead of adopting a duplicate', async () => {
    // An order raised HERE whose Zoho Sales Order id was never written back —
    // the shape you get when the Zoho call succeeded and its response was lost.
    const customer = await db.prepare("SELECT * FROM customers WHERE source = 'local' LIMIT 1").get();
    const medrep = await db.prepare("SELECT * FROM users WHERE role = 'medrep' LIMIT 1").get();
    const localRef = 'GM-IMPORTTEST-0001';

    const inserted = await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_sync_status)
         VALUES (?, ?, ?, 'so_pending', 'direct', 100, '1 Test St', 'pending')`
      )
      .run(localRef, customer.id, medrep.id);
    createdOrderIds.push(inserted.lastInsertRowid);

    const created = await zoho.createSalesOrder({
      getmeds_order_id: localRef, // becomes reference_number on the Zoho record
      customer_name: customer.name,
      customer_type: 'direct',
      zoho_customer_id: 'CONTACT-FIX-1002',
      salesperson_name: SALESPERSON,
      total_amount: 100,
      delivery_address: '1 Test St',
      items: [{ name: 'Paracetamol 500mg Tablet', quantity: 1, unit_price: 100, subtotal: 100 }]
    });

    // Adoption skips anything matched by reference number, so this order is
    // re-linked by the pass that runs before it — never adopted as a second
    // ZOHO- copy of an order this app already raised.
    const summary = await importSalesOrders({ mode: 'full' });
    expect(summary.linked).toBe(1);

    const relinked = await db.prepare('SELECT * FROM orders WHERE id = ?').get(inserted.lastInsertRowid);
    expect(relinked.zoho_so_id).toBe(created.salesorder.salesorder_id);
    expect(relinked.getmeds_order_id).toBe(localRef); // still its own id, not ZOHO-…

    // And no second order was invented for the same Sales Order.
    const count = await db
      .prepare('SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id = ?')
      .get(created.salesorder.salesorder_id);
    expect(count.c).toBe(1);

    const types = (await eventsFor(inserted.lastInsertRowid)).map((e) => e.event_type);
    expect(types).toContain('ZOHO_SO_LINKED');
    expect(types).toContain('ZOHO_SO_CREATED');
    // Adoption is what it was spared — it already existed here.
    expect(types).not.toContain('ORDER_IMPORTED_FROM_ZOHO');

    // Tidy up the customer the second fixture contact created.
    const adopted = await db
      .prepare("SELECT id FROM customers WHERE zoho_contact_id = 'CONTACT-FIX-1002'")
      .get();
    if (adopted) createdCustomerIds.push(adopted.id);
  });

  /**
   * Sep 10, 2026 (3c-2). Enriching ~60,000 adopted orders is ~120,000 Zoho
   * GETs against an org with a daily call budget, so it is a campaign run over
   * many passes rather than one button press.
   *
   * That makes the cost of a PASS the thing worth testing. Each pass used to
   * begin by re-walking Zoho's Sales Order list — ~305 requests to re-learn
   * something already sitting in the orders table. Over the whole campaign
   * that is thousands of calls spent on nothing.
   *
   * So the first assertion here is about a call NOT being made. It is the only
   * one that can catch the regression: if enrichPendingDetail ever grows a
   * list walk again, every other assertion in this file still passes and the
   * campaign just quietly costs a third more.
   */
  describe('enrichPendingDetail — filling in detail without re-walking the list', () => {
    /** Put orders back into the "summary-only" state a tier-1 adoption leaves. */
    async function markPending(limit) {
      const rows = await db
        .prepare(
          `SELECT id FROM orders
            WHERE zoho_so_id IS NOT NULL AND getmeds_order_id LIKE 'ZOHO-%'
            ORDER BY id LIMIT ?`
        )
        .all(limit);
      for (const r of rows) {
        await db.prepare('UPDATE orders SET zoho_detail_synced_at = NULL WHERE id = ?').run(r.id);
      }
      return rows.map((r) => r.id);
    }

    async function syncedAt(orderId) {
      const row = await db.prepare('SELECT zoho_detail_synced_at FROM orders WHERE id = ?').get(orderId);
      return row?.zoho_detail_synced_at || null;
    }

    test('asks Postgres for the backlog, not Zoho — no Sales Order list call', async () => {
      const ids = await markPending(2);
      expect(ids.length).toBeGreaterThan(0);

      const listSpy = jest.spyOn(zoho, 'listSalesOrders');
      try {
        const summary = await enrichPendingDetail({ limit: ids.length });
        expect(listSpy).not.toHaveBeenCalled();
        expect(summary.detailed).toBe(ids.length);
      } finally {
        listSpy.mockRestore();
      }

      for (const id of ids) expect(await syncedAt(id)).toBeTruthy();
    });

    test('respects its limit and advances, rather than re-taking the same slice', async () => {
      const ids = await markPending(3);
      expect(ids.length).toBe(3);

      const first = await enrichPendingDetail({ limit: 1 });
      expect(first.detailed).toBe(1);

      // The one it stamped must be out of the backlog, so the next pass reaches
      // a different order. This is the bug that made the original detail budget
      // unable to see past its own first 500.
      const stamped = [];
      for (const id of ids) if (await syncedAt(id)) stamped.push(id);
      expect(stamped.length).toBe(1);

      const second = await enrichPendingDetail({ limit: 1 });
      expect(second.detailed).toBe(1);

      const stampedAfter = [];
      for (const id of ids) if (await syncedAt(id)) stampedAfter.push(id);
      expect(stampedAfter.length).toBe(2);

      await enrichPendingDetail({ limit: 5 });
    });

    test('reports the backlog it leaves behind, counted after the pass', async () => {
      await markPending(2);
      const before = await countAwaitingDetail();
      expect(before).toBeGreaterThanOrEqual(2);

      const summary = await enrichPendingDetail({ limit: 1 });
      // Counted after the writes landed, so it is what is genuinely left —
      // not `before - limit`, which would be wrong the moment a detail fetch
      // fails and leaves its order outstanding.
      expect(summary.awaiting_detail).toBe(before - 1);

      await enrichPendingDetail({ limit: 10 });
    });

    test('a zero budget is a no-op that still makes no Zoho calls', async () => {
      const listSpy = jest.spyOn(zoho, 'listSalesOrders');
      const detailSpy = jest.spyOn(zoho, 'getSalesOrder');
      try {
        const summary = await enrichPendingDetail({ limit: 0 });
        expect(summary.detailed).toBe(0);
        expect(listSpy).not.toHaveBeenCalled();
        expect(detailSpy).not.toHaveBeenCalled();
      } finally {
        listSpy.mockRestore();
        detailSpy.mockRestore();
      }
    });
  });

  describe('endpoints', () => {
    test('POST /api/orders/import-from-zoho/start returns a job id, and rejects a bad mode', async () => {
      const bad = await request(app)
        .post('/api/orders/import-from-zoho/start?mode=everything')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(bad.statusCode).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_MODE');

      const ok = await request(app)
        .post('/api/orders/import-from-zoho/start?mode=quick')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(ok.statusCode).toBe(202);
      expect(ok.body.data.job_id).toBeTruthy();
      expect(ok.body.data.mode).toBe('quick');

      // The job is pollable through the same registry the customers and
      // inventory pulls use — one endpoint, one status shape, three kinds.
      const poll = await request(app)
        .get(`/api/sync-jobs/${ok.body.data.job_id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(poll.statusCode).toBe(200);
      expect(poll.body.data.type).toBe('salesorders');
    });

    test('a MedRep cannot start an import', async () => {
      const res = await request(app)
        .post('/api/orders/import-from-zoho/start?mode=full')
        .set('Authorization', `Bearer ${medrepToken}`);
      expect(res.statusCode).toBe(403);
    });

    test('the management orders list names the Zoho Salesperson, not the importing admin', async () => {
      const res = await request(app)
        .get('/api/management/orders')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      const adopted = res.body.data.orders.find((o) => o.getmeds_order_id.startsWith('ZOHO-'));
      expect(adopted).toBeTruthy();
      expect(adopted.salesperson_name).toBe(SALESPERSON);
      // The admin that ran the import is still the row's owner — it has to be,
      // medrep_id is NOT NULL — it is just no longer what the column shows.
      expect(adopted.medrep_name).toBeTruthy();
      expect(adopted.salesperson_name).not.toBe(adopted.medrep_name);
    });

    test('GET /api/orders/import-from-zoho/status reports what has been imported', async () => {
      // Declared before GET /:id in orders.routes.js — if that ordering is ever
      // lost this returns 404 ("no order with id import-from-zoho"), which is
      // exactly the failure this assertion is here to catch.
      const res = await request(app)
        .get('/api/orders/import-from-zoho/status')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data.imported_orders).toBeGreaterThanOrEqual(1);
      expect(res.body.data.zoho_log_entries).toBeGreaterThanOrEqual(1);
      expect(res.body.data.per_run_limit).toBeGreaterThan(0);
    });
  });
});
