/**
 * Finance sees every stage; Finance may still only confirm.
 *
 * Sep 12, 2026.
 *
 * ── The change ────────────────────────────────────────────────────────────
 *
 * /api/finance/queue used to select four statuses — the ones Finance acts on
 * or has just acted on. That made an order invisible on the Finance screen
 * right up until the moment it needed confirming, and invisible again
 * afterwards, so "where did that order go" had no answer anywhere Finance
 * could look.
 *
 * It now returns every stage, which is the same picture a MedRep has of their
 * own orders. What Finance can DO is untouched: verify, and nothing else.
 * Seeing is not acting, and these tests hold those two apart.
 *
 * ── The invariant worth guarding ──────────────────────────────────────────
 *
 * Every status in the state machine belongs to exactly one stage group. Miss
 * one and orders at that status appear in no card, match no filter chip, and
 * are counted by nothing — present in the list but unreachable by any control
 * on the page. Which is the failure this whole change exists to fix, so it
 * would be a particularly poor way to reintroduce it.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const stages = require('../src/services/financeStages');
const stateMachine = require('../src/workflow/stateMachine');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('finance stage groups', () => {
  test('every status in the workflow belongs to a stage', () => {
    const ungrouped = stateMachine.allStatuses().filter((s) => !stages.ALL_GROUPED.includes(s));
    expect(ungrouped).toEqual([]);
  });

  test('no stage claims a status the workflow does not have', () => {
    const all = stateMachine.allStatuses();
    expect(stages.ALL_GROUPED.filter((s) => !all.includes(s))).toEqual([]);
  });

  test('no status belongs to two stages at once', () => {
    // Double-counting would make the cards sum to more than the list holds.
    const seen = new Set();
    const duplicated = stages.ALL_GROUPED.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
    expect(duplicated).toEqual([]);
  });

  test('only one stage is actionable, and it is the one Finance verifies', () => {
    // The whole permission story in one assertion: widening what Finance can
    // SEE must never widen what they can act on.
    expect(stages.ACTIONABLE).toEqual(['ready_for_finance_verified']);
  });

  test('an unknown stage resolves to no statuses', () => {
    expect(stages.statusesForStage('nonsense')).toEqual([]);
    expect(stages.statusesForStage(undefined)).toEqual([]);
  });
});

/**
 * The sidebar and the server have to agree on the stage keys.
 *
 * Sep 12, 2026. The "Finance Confirmation" group builds one nav item per stage
 * from the frontend's own constants file, and each links to
 * /finance?stage=<key>. The server validates that key independently and shows
 * everything when it does not recognise one.
 *
 * Those two behaviours combine badly: a key that exists only on the frontend
 * produces a nav item that silently shows the unfiltered list, looking like a
 * page that ignores you rather than an error anyone would report. Read across
 * the boundary here because that is the only place the mismatch is visible.
 */
describe('the frontend stage list matches the server', () => {
  const fs = require('fs');
  const path = require('path');
  const frontendConstants = path.join(
    __dirname, '..', '..', 'getmeds-frontend', 'src', 'constants', 'financeStages.js'
  );

  // Skipped rather than failed if the frontend is not checked out beside the
  // backend -- a backend-only clone should not fail its own suite for that.
  const present = fs.existsSync(frontendConstants);
  const maybe = present ? test : test.skip;

  maybe('every key the sidebar can link to is one the server knows', () => {
    const src = fs.readFileSync(frontendConstants, 'utf8');
    const keys = [...src.matchAll(/key: '([a-z]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);

    const serverKeys = stages.STAGE_GROUPS.map((g) => g.key);
    expect(keys.sort()).toEqual(serverKeys.sort());
  });
});

describe('GET /api/finance/queue across every stage', () => {
  let financeToken;
  const createdOrderIds = [];
  const madeByStatus = {};

  // One order at each of a spread of statuses, including several the old
  // four-status queue could never have shown.
  const STATUSES = ['draft', 'so_created', 'ready_for_finance_verified', 'completed', 'on_hold'];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');
    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;

    for (const status of STATUSES) {
      const id = (await db
        .prepare(
          `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status,
                               customer_type, total_amount, delivery_address)
           VALUES (?, ?, ?, ?, 'direct', 1500, '1 Stage St')`
        )
        .run(`GM-STAGE-${status}-${Date.now()}`, customerId, medrepId, status)).lastInsertRowid;
      madeByStatus[status] = id;
      createdOrderIds.push(id);
    }
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  const queue = async (q = '') => {
    const res = await request(app).get(`/api/finance/queue${q}`).set(auth(financeToken));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('statuses the old queue could not show are now listed', async () => {
    const ids = (await queue('?limit=100')).orders.map((o) => o.id);
    // draft and completed were both outside the old four-status window.
    expect(ids).toContain(madeByStatus.draft);
    expect(ids).toContain(madeByStatus.completed);
    expect(ids).toContain(madeByStatus.ready_for_finance_verified);
  });

  test('a stage filter narrows to exactly that stage', async () => {
    const data = await queue('?stage=actionable&limit=100');
    expect(data.stage).toBe('actionable');
    const ids = data.orders.map((o) => o.id);
    expect(ids).toContain(madeByStatus.ready_for_finance_verified);
    expect(ids).not.toContain(madeByStatus.completed);
    expect(ids).not.toContain(madeByStatus.draft);
  });

  test('stats carry a count for every stage group', async () => {
    const { stats } = await queue();
    for (const g of stages.STAGE_GROUPS) {
      expect(stats).toHaveProperty(g.key);
      expect(typeof stats[g.key]).toBe('number');
    }
  });

  test('the stats are computed across stages, not just the filtered one', async () => {
    // Selecting a card must not zero the other cards, or the page's own
    // navigation collapses the moment it is used.
    const filtered = await queue('?stage=actionable');
    expect(filtered.stats.actionable).toBeGreaterThan(0);
    expect(filtered.stats.completed).toBeGreaterThan(0);
  });

  test('the tab counts agree with the list beneath them', async () => {
    /**
     * Sep 12, 2026. The tabs sit directly above the list, so their numbers are
     * read as describing it. They did not: the counts ignored the stage
     * filter, so a stage page showed "Raised in GetMeds (1)" above a list
     * headed "Raised in GetMeds (0)" — two true numbers describing different
     * sets, which reads as the page being broken.
     *
     * Checked on a stage where the two ORIGINS differ, so a version that
     * simply returned the same number twice would still fail.
     */
    for (const stage of ['actionable', 'upstream', 'completed']) {
      const here = await queue(`?origin=getmeds&stage=${stage}`);
      expect(here.counts.getmeds).toBe(here.pagination.total);

      const zoho = await queue(`?origin=zoho&stage=${stage}`);
      expect(zoho.counts.zoho).toBe(zoho.pagination.total);

      // Same stage, either tab: the pair of counts is the same either side.
      expect(here.counts).toEqual(zoho.counts);
      expect(here.counts.total).toBe(here.counts.getmeds + here.counts.zoho);
    }
  });

  test('on the dashboard the counts still cover every stage', async () => {
    // The tabs there mean "everything on that side", which is what makes an
    // empty GetMeds tab beside a large Zoho one readable.
    const dash = await queue();
    const actionable = await queue('?stage=actionable');
    expect(dash.counts.total).toBeGreaterThanOrEqual(actionable.counts.total);
  });

  test('results are paginated, and the total reflects the filter not the page', async () => {
    const data = await queue('?limit=2');
    expect(data.orders.length).toBeLessThanOrEqual(2);
    expect(data.pagination.limit).toBe(2);
    expect(data.pagination.total).toBeGreaterThan(2);
    expect(data.pagination.pages).toBeGreaterThan(1);
  });

  test('paging does not repeat rows', async () => {
    const p1 = await queue('?limit=2&page=1');
    const p2 = await queue('?limit=2&page=2');
    const overlap = p1.orders.map((o) => o.id).filter((id) => p2.orders.some((o) => o.id === id));
    expect(overlap).toEqual([]);
  });

  test('an absurd limit is capped rather than honoured', async () => {
    // Without a cap, ?limit=100000 would pull all 60,948 imported orders.
    const data = await queue('?origin=zoho&limit=100000');
    expect(data.pagination.limit).toBeLessThanOrEqual(100);
  });

  /**
   * Sep 12, 2026: the "needs your confirmation" panel.
   *
   * It exists because the list below it is now mostly finished orders, and the
   * one or two that actually want doing were a card and a click away. Served
   * separately rather than sliced off the list, which is the whole point --
   * a slice would inherit the list's filter and its page, and vanish exactly
   * when someone navigated away to check something.
   */
  describe('the recent-needing-confirmation panel', () => {
    test('carries only orders awaiting Finance', async () => {
      const { recent } = await queue();
      expect(recent.length).toBeGreaterThan(0);
      for (const o of recent) expect(o.status).toBe('ready_for_finance_verified');
    });

    test('survives a stage filter that excludes those orders', async () => {
      // The failure this guards: clicking "Completed" to check something and
      // losing sight of the work.
      const data = await queue('?stage=completed&limit=100');
      expect(data.orders.some((o) => o.status === 'ready_for_finance_verified')).toBe(false);
      expect(data.recent.length).toBeGreaterThan(0);
    });

    test('survives paging', async () => {
      const p1 = await queue('?limit=1&page=1');
      const p2 = await queue('?limit=1&page=2');
      expect(p1.recent.length).toBeGreaterThan(0);
      expect(p2.recent).toEqual(p1.recent);
    });

    test('is capped, and the card carries the real number', async () => {
      const { recent, stats } = await queue();
      expect(recent.length).toBeLessThanOrEqual(5);
      // The panel is a prompt; `stats.actionable` is the count the page shows.
      expect(stats.actionable).toBeGreaterThanOrEqual(recent.length);
    });

    test('follows the origin tab', async () => {
      // An imported order at this status is a historical record, not work, so
      // it must not appear on the GetMeds tab.
      const here = await queue('?origin=getmeds');
      for (const o of here.recent) expect(o.getmeds_order_id.startsWith('ZOHO-')).toBe(false);
    });

    test('carries the columns the panel renders', async () => {
      // It reuses the list's row shape; if that SELECT ever narrows, the panel
      // would render blanks rather than fail.
      const [row] = (await queue()).recent;
      expect(row).toHaveProperty('customer_name');
      expect(row).toHaveProperty('medrep_name');
      expect(row).toHaveProperty('total_amount');
    });
  });

  test('an unknown stage shows everything rather than nothing', async () => {
    const data = await queue('?stage=nonsense&limit=100');
    expect(data.stage).toBeNull();
    expect(data.orders.map((o) => o.id)).toContain(madeByStatus.completed);
  });
});

/**
 * Seeing is not acting.
 *
 * Sep 12, 2026. Widening Finance's view to every order made this worth
 * stating in code: canActOnOrder waves every non-MedRep role through, so
 * Finance could edit any order Zoho had not yet taken -- a draft's notes, its
 * line items, or submitting it on the rep's behalf. Nothing in the UI offered
 * that, so it never happened; but a screen that now lists every order should
 * not be one bug away from letting Finance rewrite one.
 *
 * Their single power over an order is confirming the customer's account.
 */
describe('what a Finance user may change', () => {
  let financeToken, adminToken;
  let draftId;
  const createdOrderIds = [];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');
    adminToken = await loginAs('admin@getmeds.ph');

    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
    const ref = `GM-FINPERM-${Date.now()}`;
    // A draft: nothing in Zoho yet, so no sync guard can stand in for the
    // permission check and make this test pass for the wrong reason.
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status,
                             customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'draft', 'direct', 1500, '1 Perm St')`
      )
      .run(ref, customerId, medrepId);
    draftId = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
    createdOrderIds.push(draftId);
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  test('Finance cannot edit an order details', async () => {
    const res = await request(app)
      .patch(`/api/orders/${draftId}/details`)
      .set(auth(financeToken))
      .send({ delivery_notes: 'finance should not be able to write this' });
    expect(res.status).toBe(403);

    const row = await db.prepare('SELECT delivery_notes FROM orders WHERE id = ?').get(draftId);
    expect(row.delivery_notes).not.toBe('finance should not be able to write this');
  });

  test('Finance cannot submit an order', async () => {
    const res = await request(app).post(`/api/orders/${draftId}/submit`).set(auth(financeToken));
    expect(res.status).toBe(403);
  });

  test('Finance can still READ it', async () => {
    // The distinction the whole change rests on.
    const res = await request(app).get(`/api/orders/${draftId}`).set(auth(financeToken));
    expect(res.status).toBe(200);
  });

  test('admin is unaffected', async () => {
    // The check must not have been tightened into "nobody but the MedRep".
    const res = await request(app)
      .patch(`/api/orders/${draftId}/details`)
      .set(auth(adminToken))
      .send({ delivery_notes: 'admin may' });
    expect(res.status).toBe(200);
  });
});
