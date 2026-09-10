/**
 * Sep 10, 2026 — the audit trail records when things HAPPENED, not when we
 * looked.
 *
 * The bug this pins down, from a real order: SO-59395 was raised on 31 Jan
 * 2026, invoiced, paid, packed and shipped that same day. Its trail showed
 * Confirmed, Invoice Sent, Payment Received and Packed all at 08:08 on 10 Sep
 * — the moment of the sync — attributed to "Fhaye (opened the order)", who had
 * done none of those things.
 *
 * Every checkpoint below is driven off a Sales Order with dates in the past,
 * so a regression to "now" fails loudly rather than looking plausible.
 */
const db = require('../src/db/database');
const { reconcileOrderFully } = require('../src/services/zohoReconcileService');
const { toIso, toIsoWithTime, firstIso } = require('../src/services/zohoDates');

const SO_DATE = '2026-01-31';
const SO_CREATED = '2026-01-31T16:17:52+0800';
const EDITED_AT = '2026-02-11T15:58:56+0800';

const orderIds = [];
let customer, rep;

/** A Sales Order shaped exactly like the live one, dates and all. */
const salesorder = (overrides = {}) => ({
  salesorder_id: 'SOID-TRAIL-1',
  salesorder_number: 'SO-59395',
  status: 'shipped',
  date: SO_DATE,
  created_time: SO_CREATED,
  last_modified_time: EDITED_AT,
  shipment_date: SO_DATE,
  total: 19500,
  invoices: [
    { invoice_id: 'INVID-1', invoice_number: 'INV-12837510', date: SO_DATE, status: 'paid', total: 19500 }
  ],
  packages: [
    { package_id: 'PKGID-1', package_number: 'PKG-44593', date: SO_DATE, shipment_date: SO_DATE, status: 'shipped', carrier: 'VICTORY LINER', tracking_number: 'TRK-1' }
  ],
  ...overrides
});

async function seedImportedOrder(ref) {
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                           total_amount, delivery_address, zoho_sync_status, salesperson,
                           zoho_so_id, zoho_so_number, sales_order_date, created_at, updated_at)
       VALUES (?, ?, ?, 'so_created', 'direct', 19500, 'See Zoho', 'synced', 'TRAIL | Tester',
               'SOID-TRAIL-1', 'SO-59395', ?, ?, ?)`
    )
    .run(ref, customer.id, rep.id, SO_DATE, now, now);
  orderIds.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

const eventsFor = (id) =>
  db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, id').all(id);

describe('Audit trail dates come from Zoho', () => {
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

  describe('the date helper', () => {
    test('reads Zoho\'s two date shapes', () => {
      // A full timestamp keeps its own offset.
      expect(toIso('2026-01-31T16:17:52+0800')).toBe('2026-01-31T08:17:52.000Z');
      // A bare date gets the ORG's midnight, not UTC's — otherwise an order
      // filed on the 31st reads as the 30th for everyone looking at it.
      expect(toIso('2026-01-31')).toBe('2026-01-30T16:00:00.000Z');
    });

    test('returns null rather than guessing', () => {
      // Falling back to "now" for an unreadable date is precisely the bug this
      // module exists to fix: it produces a trail that looks precise and lies.
      expect(toIso('')).toBeNull();
      expect(toIso(null)).toBeNull();
      expect(toIso('not a date')).toBeNull();
    });

    test('falls through candidates in order of precision', () => {
      expect(firstIso(null, '', '2026-01-31')).toBe('2026-01-30T16:00:00.000Z');
      expect(firstIso(undefined, null)).toBeNull();
    });

    test('combines a history entry\'s date and clock time', () => {
      expect(toIsoWithTime('2026-01-31', '4:17 PM')).toBe('2026-01-31T08:17:00.000Z');
      expect(toIsoWithTime('2026-01-31', '12:30 AM')).toBe('2026-01-30T16:30:00.000Z');
    });
  });

  describe('reconciling an order from January', () => {
    let orderId;
    let events;

    beforeAll(async () => {
      orderId = await seedImportedOrder('ZOHO-TRAILTEST-1');
      await reconcileOrderFully({
        orderId,
        actorId: rep.id,
        actorName: 'Fhaye (opened the order)',
        source: 'page_open',
        salesorder: salesorder()
      });
      events = await eventsFor(orderId);
    });

    test('records every checkpoint', () => {
      const types = events.map((e) => e.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'ZOHO_SO_CONFIRMED', 'ZOHO_INVOICE_SENT', 'ZOHO_PAYMENT_VERIFIED', 'ZOHO_PACKAGE_CREATED'
      ]));
    });

    test('dates them in January, not today', () => {
      const today = new Date().toISOString().slice(0, 10);
      for (const e of events) {
        if (e.event_type === 'ORDER_REASSIGNED') continue;
        expect(e.created_at.slice(0, 10)).not.toBe(today);
        expect(e.created_at < '2026-03-01').toBe(true);
      }
    });

    test('the confirmation carries the Sales Order\'s own creation time', () => {
      const e = events.find((x) => x.event_type === 'ZOHO_SO_CONFIRMED');
      expect(e.created_at).toBe(toIso(SO_CREATED));
    });

    test('the invoice carries the invoice date, floored at the order creation', () => {
      // Zoho gives the invoice a bare '2026-01-31', which read literally is
      // midnight — four hours BEFORE the Sales Order it invoices was raised at
      // 16:17. The date is right, the implied time is not, so it is clamped to
      // the Sales Order's own creation. Same day either way; what changes is
      // that the trail no longer reads Invoiced-then-Confirmed.
      const e = events.find((x) => x.event_type === 'ZOHO_INVOICE_SENT');
      expect(e.created_at.slice(0, 10)).toBe('2026-01-31');
      expect(e.created_at).toBe(toIso(SO_CREATED));
    });

    test('the package carries the package date, floored the same way', () => {
      const e = events.find((x) => x.event_type === 'ZOHO_PACKAGE_CREATED');
      expect(e.created_at.slice(0, 10)).toBe('2026-01-31');
      expect(e.created_at).toBe(toIso(SO_CREATED));
    });

    test('a package dated AFTER the order keeps its own date', () => {
      // The clamp is a floor, not a rewrite — it must not drag a genuinely
      // later shipment back to the day the order was raised.
      const { notBefore } = require('../src/services/zohoDates');
      expect(notBefore(toIso('2026-02-05'), toIso(SO_CREATED))).toBe(toIso('2026-02-05'));
    });

    test('an edit carries the exact last_modified_time', async () => {
      // The one checkpoint Zoho timestamps precisely, so it must not be
      // rounded down to the Sales Order's date.
      const id = await seedImportedOrder('ZOHO-TRAILTEST-EDIT');
      await reconcileOrderFully({
        orderId: id,
        actorName: 'Someone (opened the order)',
        source: 'page_open',
        salesorder: salesorder({ intake_terms: 'x' })
      });
      const edited = (await eventsFor(id)).find((e) => e.event_type === 'ZOHO_SO_EDITED');
      if (edited) expect(edited.created_at).toBe(toIso(EDITED_AT));
    });

    test('names Zoho as the actor, not whoever opened the page', () => {
      // "Sales Order confirmed in Zoho — By: Fhaye (opened the order)" claimed
      // Fhaye had confirmed an order she had merely looked at.
      for (const e of events) {
        if (!e.event_type.startsWith('ZOHO_')) continue;
        expect(e.actor_name).toBe('Zoho');
        expect(e.actor_id).toBeNull();
      }
    });

    test('keeps who synced it in metadata, where it belongs', () => {
      // Not lost — moved out of the trail's headline and into the record.
      const e = events.find((x) => x.event_type === 'ZOHO_SO_CONFIRMED');
      const meta = JSON.parse(e.metadata || '{}');
      expect(meta.syncedBy).toBe('Fhaye (opened the order)');
      expect(meta.syncedAt).toBeTruthy();
      expect(meta.source).toBe('page_open');
    });

    test('drops the sync boilerplate from what a person reads', () => {
      for (const e of events) {
        expect(e.notes || '').not.toMatch(/backfilled by manual sync/i);
        expect(e.notes || '').not.toMatch(/the live webhook did not reach this app/i);
      }
    });

    test('nothing is dated before the Sales Order it belongs to', () => {
      // Zoho times the Sales Order to the second but its invoices and packages
      // only to the day, so read literally an invoice dated 31 Jan sits at
      // midnight and the order it invoices sits at 16:17 the same day — the
      // trail then reads Invoiced, Paid, Packed, and only then Confirmed.
      const created = toIso(SO_CREATED);
      for (const e of events) {
        if (e.event_type === 'ORDER_IMPORTED_FROM_ZOHO') continue;
        expect(e.created_at >= created).toBe(true);
      }
    });

    test('the trail reads in the order things actually happened', async () => {
      // The whole point: sorted by created_at, an order raised then invoiced
      // then packed reads in that sequence. With every row stamped "now" they
      // sorted by insertion order instead, which only looked right by luck.
      // Read back the way the app reads it: by date, then by the order the
      // rows were recorded in, so same-day events keep their sequence.
      const ordered = await db
        .prepare('SELECT event_type, created_at FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC')
        .all(orderId);
      const stamps = ordered.map((e) => e.created_at);
      expect([...stamps].sort()).toEqual(stamps);

      const seq = ordered.map((e) => e.event_type);
      expect(seq.indexOf('ZOHO_SO_CONFIRMED')).toBeLessThan(seq.indexOf('ZOHO_INVOICE_SENT'));
      expect(seq.indexOf('ZOHO_INVOICE_SENT')).toBeLessThan(seq.indexOf('ZOHO_PACKAGE_CREATED'));
    });
  });
});
