const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const autoSync = require('../src/services/zohoAutoSyncService');

/**
 * The automatic trail sync (Sep 1, 2026).
 *
 * What these guard, in order of how much they'd hurt to get wrong:
 *  - the poller must not spend Zoho API calls on orders that can never change
 *    (terminal ones) or that were never pushed to Zoho at all;
 *  - a failing order must be stamped anyway, or it sorts to the front of every
 *    subsequent batch and starves the queue behind it;
 *  - the page-open path must respect a cooldown, because the frontend
 *    re-fetches on a timer and one open tab would otherwise be a permanent
 *    stream of reads against the live org.
 */
describe('Zoho auto-sync', () => {
  let medrep;
  let customer;
  const ids = [];

  const makeOrder = async (
    { ref, status = 'ready_for_draft_invoice', soId = 'ZSO-AUTO', lastReconciled = null }
  ) => {
    const existing = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    if (existing) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    const r = await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_sync_status, last_reconciled_at)
         VALUES (?, ?, ?, ?, 'direct', 1000, 'Manila', ?, 'synced', ?)`
      )
      .run(ref, customer.id, medrep.id, status, soId, lastReconciled);
    ids.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  beforeAll(async () => {
    medrep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    customer = await db.prepare("SELECT id FROM customers WHERE type = 'direct' LIMIT 1").get();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    autoSync.stop();
  });

  describe('pickBatch', () => {
    test('skips terminal orders and anything never pushed to Zoho', async () => {
      const live = await makeOrder({ ref: 'AUTO-LIVE-1' });
      const done = await makeOrder({ ref: 'AUTO-DONE-1', status: 'completed' });
      const gone = await makeOrder({ ref: 'AUTO-DEL-1', status: 'deleted' });
      const voided = await makeOrder({ ref: 'AUTO-CAN-1', status: 'cancelled' });

      const noSo = await makeOrder({ ref: 'AUTO-NOSO-1' });
      await db.prepare('UPDATE orders SET zoho_so_id = NULL WHERE id = ?').run(noSo);

      const picked = (await autoSync.pickBatch(100)).map((o) => o.id);
      expect(picked).toContain(live);
      expect(picked).not.toContain(done);
      expect(picked).not.toContain(gone);
      expect(picked).not.toContain(voided);
      expect(picked).not.toContain(noSo);
    });

    test('least-recently-reconciled first, never-reconciled ahead of everything', async () => {
      const never = await makeOrder({ ref: 'AUTO-NEVER' });
      const old = await makeOrder({ ref: 'AUTO-OLD', lastReconciled: '2026-01-01T00:00:00.000Z' });
      const fresh = await makeOrder({ ref: 'AUTO-FRESH', lastReconciled: new Date().toISOString() });

      const order = (await autoSync.pickBatch(100)).map((o) => o.id);
      expect(order.indexOf(never)).toBeLessThan(order.indexOf(old));
      expect(order.indexOf(old)).toBeLessThan(order.indexOf(fresh));
    });

    test('honours the batch limit', async () => {
      expect(await autoSync.pickBatch(2)).toHaveLength(2);
    });
  });

  describe('reconcileOne', () => {
    test('stamps last_reconciled_at on success', async () => {
      const id = await makeOrder({ ref: 'AUTO-OK-1' });
      jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
        code: 0,
        message: 'success',
        salesorder: { salesorder_id: 'ZSO-AUTO', salesorder_number: 'SO-1', status: 'draft' }
      });

      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      await autoSync.reconcileOne(order, 'auto_sync');

      expect((await db.prepare('SELECT last_reconciled_at FROM orders WHERE id = ?').get(id)).last_reconciled_at).toBeTruthy();
    });

    test('stamps last_reconciled_at even when Zoho is unreachable', async () => {
      // Otherwise the failing order stays at the head of the queue and every
      // future tick burns the whole batch retrying it.
      const id = await makeOrder({ ref: 'AUTO-FAIL-1' });
      jest.spyOn(zoho, 'getSalesOrder').mockRejectedValue(new Error('ECONNREFUSED'));

      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      const result = await autoSync.reconcileOne(order, 'auto_sync');

      expect(result.ok).toBe(false);
      expect((await db.prepare('SELECT last_reconciled_at FROM orders WHERE id = ?').get(id)).last_reconciled_at).toBeTruthy();
    });

    test('actually backfills the trail — a confirmed SO reaches the order', async () => {
      const id = await makeOrder({ ref: 'AUTO-CONF-1', status: 'so_created' });
      jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
        code: 0,
        message: 'success',
        salesorder: { salesorder_id: 'ZSO-AUTO', salesorder_number: 'SO-AUTO-9', status: 'confirmed' }
      });

      const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      const result = await autoSync.reconcileOne(order, 'auto_sync');

      expect(result.ok).toBe(true);
      expect(result.action).toBe('SO_CONFIRMED_BACKFILLED');
      // Sep 1, 2026 (8): confirmation hands the order to Finance for account
      // verification, which is a step earlier than invoicing.
      expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(id)).status).toBe('ready_for_finance_verified');

      const event = await db
        .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_CONFIRMED'")
        .get(id);
      expect(event).toBeDefined();
      // Sep 10, 2026: the actor is ZOHO, not the thing that triggered the
      // sync. This used to assert 'Auto Sync', which was the same mistake in a
      // politer form — a Sales Order confirmed by a person in Zoho was
      // credited to whatever noticed it, and on a manual sync that read
      // "confirmed in Zoho — By: Fhaye (opened the order)".
      //
      // What triggered the sync is not lost, it moved to where it belongs:
      // metadata.syncedBy / syncedAt, alongside the source that was already
      // there.
      expect(event.actor_name).toBe('Zoho');
      expect(event.actor_id).toBeNull();
      const meta = JSON.parse(event.metadata);
      expect(meta.source).toBe('auto_sync');
      expect(meta.syncedBy).toBe('Auto Sync');
      expect(meta.syncedAt).toBeTruthy();
    });
  });

  describe('runOnce', () => {
    test('one bad order does not stop the rest of the batch', async () => {
      const bad = await makeOrder({ ref: 'AUTO-BAD', lastReconciled: '2020-01-01T00:00:00.000Z' });
      const good = await makeOrder({ ref: 'AUTO-GOOD', lastReconciled: '2020-01-02T00:00:00.000Z' });

      jest.spyOn(zoho, 'getSalesOrder').mockImplementation(async () => {
        throw new Error('boom');
      });

      const results = await autoSync.runOnce({ limit: 2 });
      expect(results).toHaveLength(2);
      for (const id of [bad, good]) {
        expect((await db.prepare('SELECT last_reconciled_at FROM orders WHERE id = ?').get(id)).last_reconciled_at).toBeTruthy();
      }
    });
  });

  describe('refresh when the order is opened', () => {
    const request = require('supertest');
    const app = require('../src/app');

    const login = async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' });
      return res.body.data.token;
    };

    test('opening an order pulls Zoho and returns the updated trail in the same response', async () => {
      const id = await makeOrder({ ref: 'AUTO-OPEN-1', status: 'so_created' });
      const token = await login();

      const spy = jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
        code: 0,
        message: 'success',
        salesorder: { salesorder_id: 'ZSO-AUTO', salesorder_number: 'SO-OPEN-1', status: 'confirmed' }
      });

      const res = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      // The response must reflect the reconcile, not the pre-reconcile row —
      // otherwise the user sees stale data and has to refresh anyway.
      expect(res.body.data.order.status).toBe('ready_for_finance_verified');
      expect(res.body.data.events.some((e) => e.event_type === 'ZOHO_SO_CONFIRMED')).toBe(true);
    });

    test('re-opening inside the cooldown does not call Zoho again', async () => {
      const id = await makeOrder({ ref: 'AUTO-OPEN-2', status: 'so_created' });
      const token = await login();

      const spy = jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({
        code: 0,
        message: 'success',
        salesorder: { salesorder_id: 'ZSO-AUTO', salesorder_number: 'SO-OPEN-2', status: 'draft' }
      });

      await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`);
      expect(spy).toHaveBeenCalledTimes(1);

      // The frontend re-fetches on a timer; without the throttle this is where
      // an idle open tab starts costing a Zoho read every few seconds.
      await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`);
      await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('Zoho being down still returns the order rather than an error page', async () => {
      const id = await makeOrder({ ref: 'AUTO-OPEN-3', status: 'so_created' });
      const token = await login();
      jest.spyOn(zoho, 'getSalesOrder').mockRejectedValue(new Error('ETIMEDOUT'));

      const res = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.order.getmeds_order_id).toBe('AUTO-OPEN-3');
    });
  });

  describe('shouldRefreshOnOpen', () => {
    test('yes when never reconciled', async () => {
      expect(await autoSync.shouldRefreshOnOpen({ zoho_so_id: 'X', status: 'ready_for_draft_invoice', last_reconciled_at: null })).toBe(true);
    });

    test('no inside the cooldown', async () => {
      expect(
        await autoSync.shouldRefreshOnOpen({
          zoho_so_id: 'X',
          status: 'ready_for_draft_invoice',
          last_reconciled_at: new Date().toISOString()
        })
      ).toBe(false);
    });

    test('yes once the cooldown has elapsed', async () => {
      const stale = new Date(Date.now() - autoSync.OPEN_COOLDOWN_MS - 1000).toISOString();
      expect(await autoSync.shouldRefreshOnOpen({ zoho_so_id: 'X', status: 'ready_for_draft_invoice', last_reconciled_at: stale })).toBe(true);
    });

    test('never for terminal orders or orders with no Zoho Sales Order', async () => {
      expect(await autoSync.shouldRefreshOnOpen({ zoho_so_id: 'X', status: 'completed', last_reconciled_at: null })).toBe(false);
      expect(await autoSync.shouldRefreshOnOpen({ zoho_so_id: 'X', status: 'deleted', last_reconciled_at: null })).toBe(false);
      expect(await autoSync.shouldRefreshOnOpen({ zoho_so_id: null, status: 'ready_for_draft_invoice', last_reconciled_at: null })).toBe(false);
    });
  });
});

/**
 * Replaying an order that ALREADY exists in Zoho several stages along — the
 * "central hub for orders we didn't create" case.
 *
 * Sep 1, 2026 (6). Three separate defects surfaced the first time this was
 * tried for real, none of which app-created orders could ever have exposed,
 * because their events always arrive one at a time and in order:
 *
 *  1. reconcileOrder backfills ONE checkpoint per call, so a single pass left
 *     the trail looking half-built with no sign more was pending.
 *  2. The branches ran newest-first, so repeated passes walked the pipeline
 *     BACKWARDS — confirmed, dispatched, invoiced, packed — each applying its
 *     own transition and stranding a shipped order at 'picking_packing'.
 *  3. The invoice branch matched on "does Zoho have an invoice" rather than
 *     "is there anything new to record", so once the invoice was known it kept
 *     matching, did nothing, and — being an else-if chain — permanently
 *     blocked the package and shipment branches behind it.
 */
describe('replaying a Zoho order that is already several stages along', () => {
  const { reconcileOrder, reconcileOrderFully } = require('../src/services/zohoReconcileService');

  let orderId;
  let medrep;
  let customer;

  const ZOHO_SO = {
    salesorder_id: 'ZS-REPLAY',
    salesorder_number: 'SO-REPLAY-1',
    status: 'confirmed',
    total: 4200,
    invoices: [{ invoice_id: 'INV-R', invoice_number: 'INV-REPLAY-1', status: 'sent' }],
    packages: [
      {
        package_id: 'PKG-R',
        package_number: 'PKG-REPLAY-1',
        status: 'shipped',
        shipment_order: { shipment_id: 'SH-R', carrier: 'Lalamove', tracking_number: 'TRK-REPLAY-1' }
      }
    ]
  };

  beforeEach(async () => {
    medrep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    customer = await db.prepare('SELECT id FROM customers LIMIT 1').get();
    const existing = await db.prepare("SELECT id FROM orders WHERE getmeds_order_id = 'ZOHO-SO-REPLAY-1'").get();
    if (existing) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    orderId = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_sync_status)
         VALUES ('ZOHO-SO-REPLAY-1', ?, ?, 'so_created', 'credit', 4200, 'Manila', 'ZS-REPLAY', 'SO-REPLAY-1', 'synced')`
      )
      .run(customer.id, medrep.id)).lastInsertRowid;
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ code: 0, message: 'success', salesorder: ZOHO_SO });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  test('one pass records only the first checkpoint — which is why callers use ...Fully', async () => {
    const result = await reconcileOrder({ orderId, actorName: 'T', source: 'zoho_import' });
    expect(result.action).toBe('SO_CONFIRMED_BACKFILLED');
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).status).toBe('ready_for_finance_verified');
  });

  test('the full reconcile rebuilds every stage, in the order they happened', async () => {
    const result = await reconcileOrderFully({ orderId, actorName: 'T', source: 'zoho_import' });

    expect(result.actions).toEqual([
      'SO_CONFIRMED_BACKFILLED',
      'INVOICE_BACKFILLED',
      'PACKAGE_BACKFILLED',
      'DISPATCHED_BACKFILLED'
    ]);

    // Shipped but unpaid — tracking_shared, not completed, and definitely not
    // stranded back at picking_packing.
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).status).toBe('tracking_shared');

    const trail = await db
      .prepare('SELECT event_type, old_status, new_status FROM order_events WHERE order_id = ? ORDER BY id')
      .all(orderId);
    expect(trail.map((e) => e.event_type)).toEqual([
      'ZOHO_SO_CONFIRMED',
      'ZOHO_INVOICE_SENT',
      'ZOHO_PACKAGE_CREATED',
      'ZOHO_DISPATCHED',
      'TRACKING_ENTERED'
    ]);

    // Every hop must join up — one entry's new_status is the next one's old.
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i].old_status).toBe(trail[i - 1].new_status);
    }
  });

  test('running it again is a no-op — no duplicate entries', async () => {
    await reconcileOrderFully({ orderId, actorName: 'T', source: 'zoho_import' });
    const countBefore = (await db.prepare('SELECT COUNT(*) n FROM order_events WHERE order_id = ?').get(orderId)).n;

    const again = await reconcileOrderFully({ orderId, actorName: 'T', source: 'zoho_import' });
    expect(again.actions).toEqual([]);
    expect(again.action).toBe('NOTHING_NEW');
    expect((await db.prepare('SELECT COUNT(*) n FROM order_events WHERE order_id = ?').get(orderId)).n).toBe(countBefore);
  });
});

/**
 * Sep 1, 2026 (6): a Sales Order whose Zoho status is already past 'confirmed'.
 *
 * Found on the first real import: SO-66890 came back as 'shipped'. Only
 * 'confirmed'/'open' were recognised, so the order never left 'so_created' —
 * and every downstream guard excludes so_created, so the shipment branch wrote
 * "DISPATCHED" into the trail while the status stayed at so_created. An order
 * reading as barely started and shipped simultaneously.
 */
describe('a Zoho Sales Order already past confirmed', () => {
  const { reconcileOrderFully } = require('../src/services/zohoReconcileService');
  const PACKAGES = [{
    package_id: 'P1', package_number: 'PKG-1', status: 'shipped',
    shipment_order: { carrier: 'Lalamove', tracking_number: 'TRK-1' }
  }];

  let orderId;

  const seed = async salesorder => {
    const medrep = await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();
    const customer = await db.prepare('SELECT id FROM customers LIMIT 1').get();
    const existing = await db.prepare("SELECT id FROM orders WHERE getmeds_order_id = 'ZOHO-PAST-CONF'").get();
    if (existing) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(existing.id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    }
    orderId = (await db.prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_sync_status)
       VALUES ('ZOHO-PAST-CONF', ?, ?, 'so_created', 'credit', 100, 'Manila', 'ZS-PC', 'SO-PC', 'synced')`
    ).run(customer.id, medrep.id)).lastInsertRowid;
    jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ code: 0, message: 'success', salesorder });
  };

  afterEach(async () => {
    jest.restoreAllMocks();
    if (orderId) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(orderId);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(orderId);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    }
  });

  test('status "shipped" with no invoice still rebuilds the whole trail', async () => {
    await seed({ salesorder_id: 'ZS-PC', salesorder_number: 'SO-PC', status: 'shipped', packages: PACKAGES });
    const r = await reconcileOrderFully({ orderId, actorName: 'Import', source: 'zoho_import' });

    expect(r.actions).toContain('SO_CONFIRMED_BACKFILLED');
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).status).toBe('tracking_shared');
  });

  test('status "shipped" with an invoice rebuilds the finance stages too', async () => {
    await seed({
      salesorder_id: 'ZS-PC', salesorder_number: 'SO-PC', status: 'shipped',
      invoices: [{ invoice_id: 'I1', invoice_number: 'INV-1', status: 'sent' }],
      packages: PACKAGES
    });
    const r = await reconcileOrderFully({ orderId, actorName: 'Import', source: 'zoho_import' });

    expect(r.actions).toEqual([
      'SO_CONFIRMED_BACKFILLED', 'INVOICE_BACKFILLED', 'PACKAGE_BACKFILLED', 'DISPATCHED_BACKFILLED'
    ]);
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).status).toBe('tracking_shared');
  });

  test.each(['fulfilled', 'partially_shipped', 'closed', 'invoiced'])(
    'status "%s" counts as confirmed', async (status) => {
      await seed({ salesorder_id: 'ZS-PC', salesorder_number: 'SO-PC', status });
      const r = await reconcileOrderFully({ orderId, actorName: 'Import', source: 'zoho_import' });
      expect(r.actions).toContain('SO_CONFIRMED_BACKFILLED');
      expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).status).toBe('ready_for_finance_verified');
    }
  );

  test('a genuine draft is left alone at so_created', async () => {
    await seed({ salesorder_id: 'ZS-PC', salesorder_number: 'SO-PC', status: 'draft' });
    const r = await reconcileOrderFully({ orderId, actorName: 'Import', source: 'zoho_import' });
    expect(r.actions).toEqual([]);
    expect((await db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId)).status).toBe('so_created');
  });
});
