/**
 * Sep 26, 2026 — logEvent leaves out an event dated before the oldest partition
 * instead of throwing, and writes everything else as before. See
 * services/orderEventCoverage.js.
 */
jest.mock('../src/services/orderEventCoverage', () => ({
  isCovered: jest.fn(async (iso) => String(iso) >= '2026-03-01T00:00:00.000Z'),
  coverageFloor: jest.fn(async () => '2026-03-01T00:00:00.000Z'),
  noteSkipped: jest.fn(),
  resetCoverageCache: jest.fn(),
}));

const db = require('../src/db/database');
const { logEvent } = require('../src/services/auditService');
const coverage = require('../src/services/orderEventCoverage');

let orderId;
const count = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?').get(orderId)).n);

describe('logEvent and old-dated events', () => {
  beforeAll(async () => {
    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const medrepId = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    const ref = `GM-OLDEV-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'completed', 'direct', 1, 'x')`
      )
      .run(ref, customerId, medrepId);
    orderId = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(orderId);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  test('an event dated in 2023 is skipped, without an error', async () => {
    await expect(
      logEvent({ orderId, eventType: 'ZOHO_SO_CONFIRMED', actorName: 'Zoho', notes: 'old', occurredAt: '2023-10-12T08:12:50.000Z' })
    ).resolves.toBeUndefined();
    expect(await count()).toBe(0);
    expect(coverage.noteSkipped).toHaveBeenCalled();
  });

  test('an event dated now, or an event with no date, is written as always', async () => {
    await logEvent({ orderId, eventType: 'ORDER_NOTE', actorName: 'A', notes: 'no date' });
    await logEvent({ orderId, eventType: 'ZOHO_SO_CONFIRMED', actorName: 'Zoho', notes: 'recent', occurredAt: '2026-09-25T02:00:00.000Z' });
    expect(await count()).toBe(2);
  });
});
