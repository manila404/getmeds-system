/**
 * The Finance queue separates imported Zoho orders from orders raised here.
 *
 * Sep 12, 2026.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * The Zoho import brought 60,817 historical Sales Orders into this database.
 * They arrived carrying real statuses, and four of those are the ones the
 * Finance queue selects on — so Finance opened their page to 138 imported
 * orders and the 4 they were actually meant to act on. Nothing threw, nothing
 * was missing: the work was simply buried at roughly 35 to 1.
 *
 * ── What is pinned here ───────────────────────────────────────────────────
 *
 *   - the default tab shows only orders raised in this app
 *   - imported orders are SEPARATED, never dropped: they remain reachable,
 *     and the counts are computed over the whole queue so each tab can state
 *     the other's size honestly
 *   - "imported" is decided by a positive ZOHO- test, so an unrecognised
 *     prefix stays visible to Finance rather than silently vanishing
 *
 * That last one is the point worth defending. Getting it backwards — testing
 * for 'GM-' and treating everything else as imported — would hide live orders
 * the moment anyone minted a new reference format, and it would hide them in
 * the one place nobody would think to look.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const origin = require('../src/services/orderOrigin');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('order origin', () => {
  test('only a ZOHO- reference counts as imported', () => {
    expect(origin.isImportedRef('ZOHO-12345')).toBe(true);
    expect(origin.isImportedRef('GM-20260911-0003')).toBe(false);
  });

  test('an unrecognised prefix is treated as raised here, not imported', () => {
    // The safe direction: a new prefix defaults to visible-and-actionable.
    // The opposite default would hide live orders from Finance.
    expect(origin.isImportedRef('PPTEST-1')).toBe(false);
    expect(origin.isImportedRef('')).toBe(false);
    expect(origin.isImportedRef(null)).toBe(false);
    expect(origin.isImportedRef(undefined)).toBe(false);
  });

  test('an unknown origin falls back to the default rather than erroring', () => {
    expect(origin.normalizeOrigin('nonsense')).toBe('getmeds');
    expect(origin.normalizeOrigin(undefined)).toBe('getmeds');
    expect(origin.normalizeOrigin('ZOHO')).toBe('zoho');
    expect(origin.normalizeOrigin('all')).toBe('all');
  });

  test('all is the only origin with no WHERE fragment', () => {
    expect(origin.originSql('all')).toBe('');
    expect(origin.originSql('zoho')).toContain('LIKE');
    expect(origin.originSql('getmeds')).toContain('NOT');
  });
});

describe('GET /api/finance/queue?origin=', () => {
  let financeToken;
  let importedId, raisedHereId;
  const createdOrderIds = [];

  const FINANCE_STATUS = 'ready_for_finance_verified';

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');

    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;

    const make = async (ref) => {
      const id = (await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status,
                               customer_type, total_amount, delivery_address)
           VALUES (?, ?, ?, ?, 'direct', 1500, '1 Origin St')`
        )
        .run(ref, customerId, medrepId, FINANCE_STATUS)).lastInsertRowid;
      createdOrderIds.push(id);
      return id;
    };

    const stamp = Date.now();
    importedId = await make(`ZOHO-ORIGIN-${stamp}`);
    raisedHereId = await make(`GM-ORIGIN-${stamp}`);
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  const queue = async (q = '') => {
    const res = await request(app).get(`/api/finance/queue${q}`).set(auth(financeToken));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('the default tab shows orders raised here and not imported ones', async () => {
    const data = await queue();
    expect(data.origin).toBe('getmeds');
    const ids = data.orders.map((o) => o.id);
    expect(ids).toContain(raisedHereId);
    expect(ids).not.toContain(importedId);
  });

  test('imported orders are separated, not dropped', async () => {
    // The distinction the whole change rests on: they are still reachable,
    // because an imported order is often exactly the one being asked about.
    const data = await queue('?origin=zoho');
    const ids = data.orders.map((o) => o.id);
    expect(ids).toContain(importedId);
    expect(ids).not.toContain(raisedHereId);
  });

  test('all returns both', async () => {
    const ids = (await queue('?origin=all')).orders.map((o) => o.id);
    expect(ids).toContain(importedId);
    expect(ids).toContain(raisedHereId);
  });

  test('counts cover the whole queue, so each tab can state the other size', async () => {
    const here = await queue('?origin=getmeds');
    const zoho = await queue('?origin=zoho');

    // Identical on both tabs: they are deliberately computed without the
    // origin filter, or a tab could never show what is on the other one.
    expect(here.counts).toEqual(zoho.counts);
    expect(here.counts.getmeds).toBe(here.orders.length);
    expect(zoho.counts.zoho).toBe(zoho.orders.length);
    expect(here.counts.total).toBe(here.counts.getmeds + here.counts.zoho);
  });

  test('an unknown origin serves the default tab rather than erroring', async () => {
    const data = await queue('?origin=nonsense');
    expect(data.origin).toBe('getmeds');
    expect(data.orders.map((o) => o.id)).not.toContain(importedId);
  });
});
