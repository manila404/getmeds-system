/**
 * Sep 10, 2026 (Phase 2) — the trail is Zoho's record, not our reconstruction.
 *
 * Every line below is real wording taken from the live org's Comments &
 * History, tallied across 18 randomly sampled orders: 620 entries, of which
 * 417 were Zoho Inventory automation and 96 were a bare "Sales Order
 * updated." with no indication of what changed.
 */
const db = require('../src/db/database');
const { classify, ingestHistory } = require('../src/services/zohoHistoryService');
const { reconcileOrderFully } = require('../src/services/zohoReconcileService');
const { toIsoWithTime } = require('../src/services/zohoDates');

const orderIds = [];
let customer, rep;

/** Real history, newest-first, exactly as Zoho returns it. */
const HISTORY = [
  { comment_id: 'c7', date: '2026-09-10', time: '8:31 AM', commented_by: 'Zoho Inventory', description: 'The custom function status_update has been executed by the workflow CRM_status_update.' },
  { comment_id: 'c6', date: '2026-09-10', time: '8:30 AM', commented_by: 'Aman Bishnoi', description: 'Package PKG-52370 shipped' },
  { comment_id: 'c5', date: '2026-09-10', time: '8:30 AM', commented_by: 'Aman Bishnoi', description: 'Package PKG-52370 created' },
  { comment_id: 'c4', date: '2026-09-10', time: '8:30 AM', commented_by: 'Aman Bishnoi', description: 'Sales order converted to invoice INV-12842298' },
  { comment_id: 'c3', date: '2026-09-10', time: '8:29 AM', commented_by: 'Aman Bishnoi', description: 'Sales Order marked as open' },
  { comment_id: 'c2', date: '2026-09-10', time: '8:10 AM', commented_by: 'Bianca', description: 'Sales Order updated.' },
  { comment_id: 'c1', date: '2026-09-10', time: '8:10 AM', commented_by: 'Aman Bishnoi', description: 'Sales Order created for PHP5,000.00' }
];

async function seedOrder(ref) {
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_sync_status, zoho_so_id, zoho_so_number,
                           sales_order_date, created_at, updated_at)
       VALUES (?, ?, ?, 'so_created', 'direct', 5000, 'See Zoho', 'synced', ?, 'SO-67270', '2026-09-10', ?, ?)`
    )
    .run(ref, customer.id, rep.id, `SOID-${ref}`, now, now);
  orderIds.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

const trail = (id) =>
  db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC').all(id);

describe('Zoho Comments & History as the trail', () => {
  beforeAll(async () => {
    customer = await db.prepare('SELECT * FROM customers LIMIT 1').get();
    rep = await db.prepare("SELECT * FROM users WHERE LOWER(role)='medrep' LIMIT 1").get();
  });

  afterAll(async () => {
    for (const id of orderIds) {
      await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM dispatch_records WHERE order_id = ?').run(id);
      await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
  });

  describe('classifying what Zoho writes', () => {
    test.each([
      ['Sales Order created for PHP5,000.00', 'ZOHO_SO_CREATED'],
      ['Sales Order marked as open', 'ZOHO_SO_CONFIRMED'],
      ['Sales order converted to invoice INV-12842298', 'ZOHO_INVOICE_SENT'],
      ['Sales order converted to invoice 2MG-SI000002087', 'ZOHO_INVOICE_SENT'],
      ['Package PKG-52370 created', 'ZOHO_PACKAGE_CREATED'],
      ['Package PKG-52370 shipped', 'ZOHO_DISPATCHED'],
      ['Package(s) PKG-44593 delivered', 'ZOHO_DELIVERED'],
      ['This Sales Order has been fulfilled', 'ZOHO_SO_FULFILLED'],
      ['Attachment added', 'ZOHO_ATTACHMENT_ADDED'],
      ['Sales Order updated. Amount changed from PHP100 to PHP200', 'ZOHO_SO_EDITED']
    ])('%s -> %s', (line, type) => {
      const v = classify(line);
      expect(v.kind).toBe('milestone');
      expect(v.type).toBe(type);
    });

    test.each([
      'The custom function status_update has been executed by the workflow CRM_status_update.',
      'The Workflow Package_Update_29 was not executed as it was triggered by custom function(s) [x]',
      'Could not execute Custom Function(s) [status_update]. Reached the maximum limit for custom function triggered',
      'Custom Function package_term_update28 failed to execute for the workflow Package_Update_29.'
    ])('automation is dropped: %s', (line) => {
      expect(classify(line).kind).toBe('automation');
    });

    test('a bare "Sales Order updated." says nothing and is dropped', () => {
      // 96 of the 620 sampled entries. Real person, real timestamp, no
      // indication of what changed — a row and no information.
      expect(classify('Sales Order updated.').kind).toBe('contentless');
      // But one that DOES say what changed is kept.
      expect(classify('Sales Order updated. Amount changed from PHP1 to PHP2').kind).toBe('milestone');
    });

    test('wording nobody has seen before is "unknown", not silently binned', () => {
      // Zoho can add phrasing this module has never met. Counting it as
      // unknown rather than lumping it in with the workflow chatter is how
      // anyone would find out.
      expect(classify('Some brand new wording Zoho invented').kind).toBe('unknown');
    });
  });

  describe('ingesting a real order history', () => {
    let id;
    let events;

    beforeAll(async () => {
      id = await seedOrder('ZOHO-HISTTEST-1');
      await ingestHistory({ orderId: id, salesorderId: 'SOID-ZOHO-HISTTEST-1', comments: HISTORY });
      events = await trail(id);
    });

    test('keeps the milestones and drops the noise', () => {
      const types = events.map((e) => e.event_type);
      expect(types).toEqual([
        'ZOHO_SO_CREATED',
        'ZOHO_SO_CONFIRMED',
        'ZOHO_INVOICE_SENT',
        'ZOHO_PACKAGE_CREATED',
        'ZOHO_DISPATCHED'
      ]);
    });

    test('reads oldest-first, though Zoho hands them over newest-first', () => {
      const stamps = events.map((e) => e.created_at);
      expect([...stamps].sort()).toEqual(stamps);
    });

    test('carries the real person, not "Zoho"', () => {
      // The whole point of Phase 2. The inference could only ever say "Zoho".
      const created = events.find((e) => e.event_type === 'ZOHO_SO_CREATED');
      expect(created.actor_name).toBe('Aman Bishnoi');
      expect(created.actor_id).toBeNull();
    });

    test('carries Zoho\'s own timestamp, to the minute', () => {
      const confirmed = events.find((e) => e.event_type === 'ZOHO_SO_CONFIRMED');
      expect(confirmed.created_at).toBe(toIsoWithTime('2026-09-10', '8:29 AM'));
    });

    test('records how much was filtered, so nothing is silently invisible', () => {
      const meta = JSON.parse(events[0].metadata);
      expect(meta.skipped.automation).toBe(1);
      expect(meta.skipped.contentless).toBe(1);
      expect(meta.zohoDescription).toBe('Sales Order created for PHP5,000.00');
    });

    test('re-ingesting adds nothing', async () => {
      const before = (await trail(id)).length;
      const res = await ingestHistory({ orderId: id, salesorderId: 'SOID-ZOHO-HISTTEST-1', comments: HISTORY });
      expect(res.written).toBe(0);
      expect((await trail(id)).length).toBe(before);
    });
  });

  describe('history and inference cooperating', () => {
    test('the reconcile does not re-record what history already established', async () => {
      // The reason ingestHistory emits the SAME event types the reconcile
      // uses. History runs first and writes the real, Zoho-timestamped
      // confirmation; the reconcile's alreadyLogged guard then sees it and
      // stands down, instead of adding a second one dated by guesswork.
      const id2 = await seedOrder('ZOHO-HISTTEST-2');
      await ingestHistory({ orderId: id2, salesorderId: 'SOID-ZOHO-HISTTEST-2', comments: HISTORY });

      const confirmedBefore = (await trail(id2)).filter((e) => e.event_type === 'ZOHO_SO_CONFIRMED');
      expect(confirmedBefore).toHaveLength(1);
      expect(confirmedBefore[0].actor_name).toBe('Aman Bishnoi');

      await reconcileOrderFully({
        orderId: id2,
        actorName: 'Someone (opened the order)',
        source: 'page_open',
        salesorder: {
          salesorder_id: 'SOID-ZOHO-HISTTEST-2',
          salesorder_number: 'SO-67270',
          status: 'shipped',
          date: '2026-09-10',
          created_time: '2026-09-10T08:10:00+0800',
          invoices: [{ invoice_id: 'i1', invoice_number: 'INV-12842298', date: '2026-09-10', status: 'paid' }],
          packages: [{ package_id: 'p1', package_number: 'PKG-52370', date: '2026-09-10', shipment_date: '2026-09-10', status: 'shipped' }]
        }
      });

      const after = await trail(id2);
      const confirmed = after.filter((e) => e.event_type === 'ZOHO_SO_CONFIRMED');
      // Still exactly one, and still the real person's — not overwritten or
      // duplicated by the reconstruction.
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].actor_name).toBe('Aman Bishnoi');

      const packed = after.filter((e) => e.event_type === 'ZOHO_PACKAGE_CREATED');
      expect(packed).toHaveLength(1);
      expect(packed[0].actor_name).toBe('Aman Bishnoi');
    });
  });

  test('an order with no readable history is left to the inference', async () => {
    const id3 = await seedOrder('ZOHO-HISTTEST-3');
    const res = await ingestHistory({ orderId: id3, salesorderId: 'SOID-ZOHO-HISTTEST-3', comments: [] });
    expect(res.written).toBe(0);
    expect(await trail(id3)).toHaveLength(0);
  });
});
