/**
 * Sep 10, 2026 (2a) — imported timestamps are UTC, like everything else.
 *
 * The import wrote Zoho's `created_time` verbatim:
 *
 *   orders.created_at        "2026-09-09T15:14:00+0800"   <- Zoho local, raw
 *   order_events.created_at  "2026-09-09T07:14:00.000Z"   <- UTC, correct
 *
 * 60,829 rows. Displayed 8 hours out, and — because these columns are TEXT and
 * compare lexicographically — sorted WRONG: '...15:14+0800' lands after
 * '...07:39Z' despite being eight hours earlier. That is why an order's own
 * "imported from Zoho" entry sank below history entries that happened after
 * it, and why the Orders list date filter matched the wrong rows.
 */
const db = require('../src/db/database');
const { toIso } = require('../src/services/zohoDates');

const ZOHO_LOCAL = '2026-09-09T15:14:00+0800';
const SAME_INSTANT_UTC = '2026-09-09T07:14:00.000Z';

describe('Zoho local time is converted to UTC', () => {
  describe('the conversion itself', () => {
    test('an offset timestamp becomes the same instant in UTC', () => {
      expect(toIso(ZOHO_LOCAL)).toBe(SAME_INSTANT_UTC);
    });

    test('the converted value sorts correctly against other UTC values', () => {
      // The whole point. As raw text, the Zoho form sorts LATER than a UTC
      // value it actually precedes.
      const laterSameDay = '2026-09-09T07:39:00.000Z';

      expect(ZOHO_LOCAL < laterSameDay).toBe(false); // broken before
      expect(toIso(ZOHO_LOCAL) < laterSameDay).toBe(true); // correct after
    });

    test('a bare Zoho date lands on the org\'s midnight, not UTC\'s', () => {
      // Otherwise an order filed on the 9th reads as the 8th for everyone.
      expect(toIso('2026-09-09')).toBe('2026-09-08T16:00:00.000Z');
    });
  });

  describe('what the database now stores', () => {
    const ids = [];
    let customer, rep;

    beforeAll(async () => {
      customer = await db.prepare('SELECT * FROM customers LIMIT 1').get();
      rep = await db.prepare("SELECT * FROM users WHERE LOWER(role)='medrep' LIMIT 1").get();
    });

    afterAll(async () => {
      for (const id of ids) {
        await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
        await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      }
    });

    test('Postgres converts an offset timestamp to the same instant', async () => {
      // Mirrors exactly what scripts/repair-timestamp-timezone.js runs, so the
      // repair is verified rather than assumed.
      const row = await db
        ._rawQuery(
          `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc`,
          [ZOHO_LOCAL]
        );
      expect(row[0].utc).toBe(SAME_INSTANT_UTC);
    });

    test('a timestamp already in UTC is unchanged by the conversion', async () => {
      // The repair only selects rows matching the +08 suffix, but if it ever
      // touched a clean row it must be a no-op rather than a shift.
      const row = await db
        ._rawQuery(
          `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc`,
          [SAME_INSTANT_UTC]
        );
      expect(row[0].utc).toBe(SAME_INSTANT_UTC);
    });

    test('an order and its trail sort together once both are UTC', async () => {
      const now = new Date().toISOString();
      const info = await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                               total_amount, delivery_address, zoho_sync_status, created_at, submitted_at, updated_at)
           VALUES ('ZOHO-TZTEST-1', ?, ?, 'so_created', 'direct', 1, 'x', 'synced', ?, ?, ?)`
        )
        .run(customer.id, rep.id, toIso(ZOHO_LOCAL), toIso(ZOHO_LOCAL), now);
      const id = info.lastInsertRowid;
      ids.push(id);

      // The import marker, at the order's own creation, and a history entry
      // 25 minutes later.
      await db
        .prepare(
          `INSERT INTO order_events (order_id, event_type, actor_name, notes, created_at)
           VALUES (?, 'ORDER_IMPORTED_FROM_ZOHO', 'Import', 'imported', ?),
                  (?, 'ZOHO_SO_CONFIRMED', 'Aman Bishnoi', 'confirmed', ?)`
        )
        .run(id, toIso(ZOHO_LOCAL), id, '2026-09-09T07:39:00.000Z');

      const events = await db
        .prepare('SELECT event_type FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC')
        .all(id);

      // Imported first, confirmation second — the order they happened in. With
      // the raw '+0800' value the import sank to the bottom.
      expect(events.map((e) => e.event_type)).toEqual([
        'ORDER_IMPORTED_FROM_ZOHO',
        'ZOHO_SO_CONFIRMED'
      ]);
    });

    test('the date filter stops mis-bucketing orders across the day boundary', async () => {
      // The Orders list bounds a range with '...T00:00:00.000Z' /
      // '...T23:59:59.999Z' and compares as TEXT.
      //
      // Mid-day values happen to fall inside either way, so the damage is at
      // the boundaries — which is most of the working day in Manila, since
      // +08:00 pushes anything before 08:00 local into the PREVIOUS UTC day
      // and anything after 16:00 into the NEXT one.
      const from = '2026-09-09T00:00:00.000Z';
      const to = '2026-09-09T23:59:59.999Z';

      // 02:00 on the 10th in Manila is 18:00 on the 9th in UTC: it belongs in
      // this range, and the raw form is excluded from it.
      const lateEvening = '2026-09-10T02:00:00+0800';
      expect(lateEvening >= from && lateEvening <= to).toBe(false);
      expect(toIso(lateEvening)).toBe('2026-09-09T18:00:00.000Z');
      expect(toIso(lateEvening) >= from && toIso(lateEvening) <= to).toBe(true);

      // And the mirror: 07:00 on the 9th in Manila is 23:00 on the 8th in UTC.
      // The raw form is wrongly INCLUDED in the 9th.
      const earlyMorning = '2026-09-09T07:00:00+0800';
      expect(earlyMorning >= from && earlyMorning <= to).toBe(true);
      expect(toIso(earlyMorning)).toBe('2026-09-08T23:00:00.000Z');
      expect(toIso(earlyMorning) >= from).toBe(false);
    });
  });
});
