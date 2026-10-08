/**
 * The KPI page API (/api/kpi) with monthly targets. Oct 5, 2026 (Aaron sheet 13.1.2).
 *
 *  - off unless GETMEDS_KPI_PAGE=true: every route is a 404, for everyone;
 *  - Admin only (for now), decided in services/kpiPermissions.js;
 *  - the booked total equals Finance's own Sales Summary for the same month, and the
 *    numbers are the ones the CSV export gives (same calculation);
 *  - the running month is flagged as "so far"; a month not started yet is refused;
 *  - targets: one per person per month, unchanged saves are not logged, clearing works,
 *    copy-last-month never overwrites, and every change is in the change log.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const db = require('../src/db/database');
const kpi = require('../scripts/kpi-export-month');
const { currentMonth } = require('../src/services/kpiService');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const MONTH = '2026-06';
const ids = { users: [], orders: [] };
let adminToken, managerToken, medrepToken, customerId, rep1, rep2, plainAdminId;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const mkUser = async (key, role) => {
  const email = `kpip-${key}-${stamp}@example.test`;
  await db.prepare(
    `INSERT INTO users (name, email, password_hash, role, first_name, last_name, is_active) VALUES (?, ?, ?, ?, 'K', ?, 1)`
  ).run(`KPIP ${key} ${stamp}`, email, bcrypt.hashSync('x', 4), role, key);
  const row = await db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
  ids.users.push(row.id);
  return row;
};
async function bookedOrder(ref, owner, total, verifiedAt) {
  const gm = `GM-KPIP-${stamp}-${ref}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, submitted_at, created_at)
     VALUES (?, ?, ?, 'ready_for_dispatch', 'credit', ?, '1 Test St', ?, ?)`
  ).run(gm, customerId, owner.id, total, verifiedAt, verifiedAt);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(gm)).id;
  ids.orders.push(id);
  await db.prepare("INSERT INTO order_events (order_id, event_type, created_at) VALUES (?, 'FINANCE_VERIFIED', ?)").run(id, verifiedAt);
}
const on = () => { process.env.GETMEDS_KPI_PAGE = 'true'; };
const off = () => { delete process.env.GETMEDS_KPI_PAGE; };

beforeAll(async () => {
  adminToken = await loginAs('admin@getmeds.ph');
  managerToken = await loginAs('manager@getmeds.ph');
  medrepToken = await loginAs('medrep@getmeds.ph');
  plainAdminId = (await db.prepare("SELECT id FROM users WHERE email = 'admin@getmeds.ph'").get()).id;
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`KPIP customer ${stamp}`, `KPIP-${stamp}`);
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`KPIP customer ${stamp}`)).id;
  rep1 = await mkUser('rep1', 'medrep');
  rep2 = await mkUser('rep2', 'medrep');
  await bookedOrder('A', rep1, 1200, '2026-06-10T03:00:00.000Z');
  await bookedOrder('B', rep1, 800, '2026-06-30T15:59:00.000Z');   // 11:59 PM Manila, 30 June: June
  await bookedOrder('C', rep2, 500, '2026-06-30T16:00:00.000Z');   // midnight Manila, 1 July: not June
});

afterEach(off);

afterAll(async () => {
  off();
  for (const id of ids.orders) {
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  for (const id of ids.users) {
    await db.prepare('DELETE FROM kpi_target_changes WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM kpi_targets WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
});

describe('the switch', () => {
  test('off by default: every KPI route is a 404, even for Admin and without a login', async () => {
    for (const [method, url] of [['get', '/api/kpi'], ['get', '/api/kpi/status'], ['get', '/api/kpi/targets'], ['put', `/api/kpi/targets/${MONTH}`], ['get', '/api/kpi/target-changes']]) {
      expect((await request(app)[method](url).set(auth(adminToken))).status).toBe(404);
      expect((await request(app)[method](url)).status).toBe(404);
    }
  });
  test('a value other than exactly "true" leaves it off', async () => {
    process.env.GETMEDS_KPI_PAGE = 'yes';
    expect((await request(app).get('/api/kpi/status').set(auth(adminToken))).status).toBe(404);
  });
});

describe('who may use it (Admin only for now)', () => {
  test('no login is 401; Management and MedRep are 403; Admin gets in', async () => {
    on();
    expect((await request(app).get('/api/kpi/status')).status).toBe(401);
    expect((await request(app).get('/api/kpi').set(auth(managerToken))).status).toBe(403);
    expect((await request(app).get('/api/kpi').set(auth(medrepToken))).status).toBe(403);
    expect((await request(app).put(`/api/kpi/targets/${MONTH}`).set(auth(managerToken)).send({ targets: [{ user_id: rep1.id, target_php: 1 }] })).status).toBe(403);
    const s = await request(app).get('/api/kpi/status').set(auth(adminToken));
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ enabled: true, canSetTargets: true, currentMonth: currentMonth() });
  });
});

describe('the KPI numbers', () => {
  test('booked total equals Finance > Sales Summary for the same month, and the people add up to it', async () => {
    on();
    const res = await request(app).get('/api/kpi').query({ month: MONTH }).set(auth(adminToken));
    expect(res.status).toBe(200);
    const fin = await request(app).get('/api/finance/sales-summary').query({ date_from: '2026-06-01', date_to: '2026-06-30' }).set(auth(adminToken));
    expect(fin.status).toBe(200);
    expect(res.body.data.totalBooked).toBeCloseTo(fin.body.data.forecast.total, 2);
    expect(res.body.data.exportedBooked).toBeCloseTo(res.body.data.totalBooked, 2);
    expect(res.body.data.partial).toBe(false);
  });

  test('the Philippine month boundary: 11:59 PM on the 30th counts, midnight does not', async () => {
    on();
    const res = await request(app).get('/api/kpi').query({ month: MONTH }).set(auth(adminToken));
    const p1 = res.body.data.people.find((p) => p.email === rep1.email);
    const p2 = res.body.data.people.find((p) => p.email === rep2.email);
    expect(p1).toMatchObject({ booked_php: 2000, booked_orders: 2 });
    expect(p2).toMatchObject({ booked_php: 0, booked_orders: 0 });
  });

  test('the page and the CSV export give the same numbers', async () => {
    on();
    const page = (await request(app).get('/api/kpi').query({ month: MONTH }).set(auth(adminToken))).body.data;
    const file = await kpi.runReadOnly(process.env.DATABASE_URL, MONTH, () => []);
    const pick = (r) => r.people.map((p) => [p.email, p.booked_php, p.booked_orders, p.orders, p.orders_held, p.channel, p.target_php]).sort();
    expect(pick(page)).toEqual(pick(file));
    expect(page.channels).toEqual(file.channels);
    expect(page.teams).toEqual(file.teams);
  });

  test('this month is shown "so far"; a month not started yet and a bad month are refused', async () => {
    on();
    const now = await request(app).get('/api/kpi').set(auth(adminToken));
    expect(now.status).toBe(200);
    expect(now.body.data.month).toBe(currentMonth());
    expect(now.body.data.partial).toBe(true);
    const [y, m] = currentMonth().split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    expect((await request(app).get('/api/kpi').query({ month: next }).set(auth(adminToken))).status).toBe(400);
    expect((await request(app).get('/api/kpi').query({ month: '2026-13' }).set(auth(adminToken))).status).toBe(400);
  });
});

describe('targets', () => {
  const put = (month, targets) => request(app).put(`/api/kpi/targets/${month}`).set(auth(adminToken)).send({ targets });

  test('set a target: it shows on the KPI page with % of target, and the change is logged', async () => {
    on();
    const r = await put(MONTH, [{ user_id: rep1.id, target_php: '4,000' }]);
    expect(r.status).toBe(200);
    expect(r.body.data.changed).toBe(1);
    const page = (await request(app).get('/api/kpi').query({ month: MONTH }).set(auth(adminToken))).body.data;
    expect(page.people.find((p) => p.email === rep1.email)).toMatchObject({ target_php: 4000, pct_of_target: 50 });
    const list = (await request(app).get('/api/kpi/targets').query({ month: MONTH }).set(auth(adminToken))).body.data.people;
    expect(list.find((p) => p.user_id === rep1.id)).toMatchObject({ target_php: 4000, set_by_name: expect.any(String) });
  });

  test('saving the same value again changes and logs nothing; clearing removes it and is logged', async () => {
    on();
    expect((await put(MONTH, [{ user_id: rep1.id, target_php: 4000 }])).body.data.changed).toBe(0);
    expect((await put(MONTH, [{ user_id: rep1.id, target_php: '' }])).body.data.changed).toBe(1);
    expect(await db.prepare('SELECT 1 FROM kpi_targets WHERE user_id = ? AND month = ?').get(rep1.id, MONTH)).toBeFalsy();
    const log = (await request(app).get('/api/kpi/target-changes').query({ month: MONTH }).set(auth(adminToken))).body.data.changes
      .filter((c) => c.user_id === rep1.id);
    expect(log.map((c) => [c.source, c.old_target_php, c.new_target_php])).toEqual([['clear', 4000, null], ['set', null, 4000]]);
    expect(log[0].changed_by_name).toBeTruthy();
  });

  test('bad input is refused and nothing is saved', async () => {
    on();
    expect((await put(MONTH, [{ user_id: rep1.id, target_php: -5 }])).status).toBe(400);
    expect((await put(MONTH, [{ user_id: rep1.id, target_php: 'abc' }])).status).toBe(400);
    expect((await put(MONTH, [{ user_id: plainAdminId, target_php: 100 }])).status).toBe(400);   // not a salesperson
    expect((await put(MONTH, [{ user_id: rep1.id, target_php: 1 }, { user_id: rep1.id, target_php: 2 }])).status).toBe(400);
    expect((await put('2026-6', [{ user_id: rep1.id, target_php: 1 }])).status).toBe(400);
    expect(await db.prepare('SELECT 1 FROM kpi_targets WHERE user_id = ? AND month = ?').get(rep1.id, MONTH)).toBeFalsy();
  });

  test('copy last month fills only people with no target yet — it never overwrites', async () => {
    on();
    await put('2026-04', [{ user_id: rep1.id, target_php: 1000 }, { user_id: rep2.id, target_php: 2000 }]);
    await put('2026-05', [{ user_id: rep2.id, target_php: 9999 }]);
    const r = await request(app).post('/api/kpi/targets/2026-05/copy').set(auth(adminToken)).send({ from: '2026-04' });
    expect(r.status).toBe(200);
    const got = async (u) => Number((await db.prepare('SELECT target_php FROM kpi_targets WHERE user_id = ? AND month = ?').get(u.id, '2026-05')).target_php);
    expect(await got(rep1)).toBe(1000);
    expect(await got(rep2)).toBe(9999);
    const again = await request(app).post('/api/kpi/targets/2026-05/copy').set(auth(adminToken)).send({ from: '2026-04' });
    expect(again.body.data.added).toBe(0);
    const copyLog = (await request(app).get('/api/kpi/target-changes').query({ month: '2026-05' }).set(auth(adminToken))).body.data.changes
      .filter((c) => c.user_id === rep1.id);
    expect(copyLog.map((c) => c.source)).toEqual(['copy']);
  });

  test('the CSV export reads the same targets from the table once it exists', async () => {
    on();
    await put(MONTH, [{ user_id: rep2.id, target_php: 3000 }]);
    const file = await kpi.runReadOnly(process.env.DATABASE_URL, MONTH, () => { throw new Error('must not read targets.csv'); });
    expect(file.people.find((p) => p.email === rep2.email).target_php).toBe(3000);
  });
});

describe('pre-fill targets from the sales sheet (Oct 8, 2026)', () => {
  const M = '2026-03';
  let ch, mg, repA, repB;
  beforeAll(async () => {
    repA = await mkUser('sheetA', 'medrep');
    repB = await mkUser('sheetB', 'medrep');
    await db.prepare("INSERT INTO sales_channels (name, head_name) VALUES (?, 'H')").run(`SHEET CH ${stamp}`);
    ch = (await db.prepare('SELECT id FROM sales_channels WHERE name = ?').get(`SHEET CH ${stamp}`)).id;
    await db.prepare('INSERT INTO sales_managers (channel_id, name) VALUES (?, ?)').run(ch, 'Sheet lead');
    mg = (await db.prepare('SELECT id FROM sales_managers WHERE channel_id = ?').get(ch)).id;
    const terr = (sp, amount, vacant = false) => db.prepare('INSERT INTO sales_territories (manager_id, zoho_salesperson, person_label, is_vacant, target_amount) VALUES (?, ?, ?, ?, ?)').run(mg, `${sp} ${stamp}`, sp, vacant, amount);
    const link = (u, sp, primary) => db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, ?)').run(u.id, `${sp} ${stamp}`, primary ? 1 : 0);
    await terr('STC | ONE', 300000); await terr('URO | ONE', 200000); await terr('B&B | TWO', 150000); await terr('STC | VACANT', 500000, true);
    await link(repA, 'STC | ONE', true); await link(repA, 'URO | ONE', false); await link(repB, 'B&B | TWO', true);
  });
  afterAll(async () => {
    for (const u of [repA, repB]) await db.prepare('DELETE FROM user_salespersons WHERE user_id = ?').run(u.id);
    await db.prepare('DELETE FROM sales_territories WHERE manager_id = ?').run(mg);
    await db.prepare('DELETE FROM sales_managers WHERE id = ?').run(mg);
    await db.prepare('DELETE FROM sales_channels WHERE id = ?').run(ch);
  });
  const call = (apply, token = adminToken) => request(app).post(`/api/kpi/targets/${M}/from-structure`).set(auth(token)).send({ apply });
  const mine = (r) => r.body.data.proposals.filter((p) => [repA.id, repB.id].includes(p.user_id));

  test('the preview sums each person’s territories, leaves vacant ones out, and saves nothing', async () => {
    on();
    const r = await call(false);
    expect(r.status).toBe(200);
    expect(mine(r).find((p) => p.user_id === repA.id)).toMatchObject({ target_php: 500000, action: 'add' });
    expect(mine(r).find((p) => p.user_id === repB.id)).toMatchObject({ target_php: 150000, action: 'add' });
    expect(r.body.data.vacant.target_php).toBeGreaterThanOrEqual(500000);
    expect(await db.prepare('SELECT 1 FROM kpi_targets WHERE user_id = ? AND month = ?').get(repA.id, M)).toBeFalsy();
  });

  test('apply fills only people with no target, never overwrites, and logs it as from the sales sheet', async () => {
    on();
    await request(app).put(`/api/kpi/targets/${M}`).set(auth(adminToken)).send({ targets: [{ user_id: repB.id, target_php: 99000 }] });
    const r = await call(true);
    expect(r.status).toBe(200);
    const got = async (u) => Number((await db.prepare('SELECT target_php FROM kpi_targets WHERE user_id = ? AND month = ?').get(u.id, M)).target_php);
    expect(await got(repA)).toBe(500000);
    expect(await got(repB)).toBe(99000);
    const log = await db.prepare("SELECT source FROM kpi_target_changes WHERE user_id = ? AND month = ?").all(repA.id, M);
    expect(log.map((x) => x.source)).toEqual(['structure']);
    expect((await call(true)).body.data.added).toBe(0);
  });

  test('only Admin may use it', async () => {
    on();
    expect((await call(false, managerToken)).status).toBe(403);
  });
});
