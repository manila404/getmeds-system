/**
 * My Own KPI and My Team KPI (/api/kpi/me). Oct 6, 2026 (sales structure, sheet 12.13 step 4).
 *
 *   Lead > Rep1, Rep2          (Outsider is on nobody's team)
 *  - own = orders the person owns: an order the Lead entered for Rep1 is on Rep1's own KPI,
 *    and the Lead's 'entered for others' shows it without counting it twice;
 *  - team = the Lead plus everyone below; the outsider is never in it;
 *  - a target change shows at once (the short cache is dropped);
 *  - off unless GETMEDS_KPI_PAGE=true; only salespeople and team leads may ask.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const MONTH = '2026-05';
const created = { users: [], orders: [] };
const P = {}, T = {};
let adminToken, managerToken, customerId;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const on = () => { process.env.GETMEDS_KPI_PAGE = 'true'; };
const off = () => { delete process.env.GETMEDS_KPI_PAGE; };

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}`);
  return res.body.data.token;
}
async function person(key, role, leadKey = null) {
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  const email = `mine-${key}-${stamp}@example.test`;
  const info = await db.prepare(
    `INSERT INTO users (name, email, password_hash, role, is_active, approval_status, created_at, team_lead_id)
     VALUES (?, ?, ?, ?, 1, 'approved', ?, ?)`
  ).run(`Mine ${key} ${stamp}`, email, seed.password_hash, role, new Date().toISOString(), leadKey ? P[leadKey] : null);
  P[key] = info.lastInsertRowid;
  created.users.push(P[key]);
  T[key] = await login(email);
}
async function booked(ref, ownerKey, total, raisedByKey = null) {
  const gm = `GM-MINE-${stamp}-${ref}`;
  const at = '2026-05-15T03:00:00.000Z';
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type, total_amount, delivery_address, submitted_at, created_at)
     VALUES (?, ?, ?, ?, 'ready_for_dispatch', 'credit', ?, '1 Mine St', ?, ?)`
  ).run(gm, customerId, P[ownerKey], raisedByKey ? P[raisedByKey] : null, total, at, at);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(gm)).id;
  created.orders.push(id);
  await db.prepare("INSERT INTO order_events (order_id, event_type, created_at) VALUES (?, 'FINANCE_VERIFIED', ?)").run(id, at);
}
const me = (k, q = '') => request(app).get(`/api/kpi/me?month=${MONTH}${q}`).set(auth(T[k]));

beforeAll(async () => {
  adminToken = await login('admin@getmeds.ph');
  managerToken = await login('manager@getmeds.ph');
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`Mine customer ${stamp}`, `MINE-${stamp}`);
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`Mine customer ${stamp}`)).id;
  await person('lead', 'team_lead');
  await person('rep1', 'medrep', 'lead');
  await person('rep2', 'medrep', 'lead');
  await person('outsider', 'medrep');
  await booked('A', 'rep1', 1000, 'lead');  // the Lead entered it for Rep1
  await booked('B', 'rep2', 500);
  await booked('C', 'lead', 200);
  await booked('D', 'outsider', 999);
  on();
  const put = (targets) => request(app).put(`/api/kpi/targets/${MONTH}`).set(auth(adminToken)).send({ targets });
  await put([{ user_id: P.rep1, target_php: 2000 }, { user_id: P.lead, target_php: 1000 }]);
});

afterEach(off);
beforeEach(on);

afterAll(async () => {
  off();
  for (const id of created.orders) {
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare(`UPDATE users SET team_lead_id = NULL WHERE id IN (${created.users.map(() => '?').join(',')})`).run(...created.users);
  for (const id of created.users) {
    for (const t of ['kpi_target_changes', 'kpi_targets']) await db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
});

test('a MedRep sees their own KPI only, including the order a Leader entered for them', async () => {
  const r = await me('rep1');
  expect(r.status).toBe(200);
  expect(r.body.data.own).toMatchObject({ booked_php: 1000, booked_orders: 1, target_php: 2000, pct_of_target: 50 });
  expect(r.body.data.team).toBeNull();
});

test("a Lead's own KPI is their own orders; what they entered for others shows separately; the team total counts each order once", async () => {
  const r = await me('lead');
  expect(r.body.data.own).toMatchObject({ booked_php: 200, target_php: 1000, pct_of_target: 20, entered_for_others_php: 1000 });
  expect(r.body.data.team).toMatchObject({ label: 'My team', people: 3, booked_php: 1700, booked_orders: 3, target_php: 3000, people_with_target: 2 });
});

test('the outsider is in no team, and a team tab the Lead does not have shows nothing', async () => {
  const r = await me('lead', '&team_group=lead:999999');
  expect(r.body.data.team).toMatchObject({ booked_php: 0, people: 0 });
  expect((await me('outsider')).body.data.own.booked_php).toBe(999);
});

test('a target change shows at once', async () => {
  await request(app).put(`/api/kpi/targets/${MONTH}`).set(auth(adminToken)).send({ targets: [{ user_id: P.rep2, target_php: 500 }] });
  expect((await me('rep2')).body.data.own).toMatchObject({ target_php: 500, pct_of_target: 100 });
  expect((await me('lead')).body.data.team.target_php).toBe(3500);
});

test('who may ask, and the switch', async () => {
  expect((await request(app).get('/api/kpi/me').set(auth(managerToken))).status).toBe(403);
  const s = await request(app).get('/api/kpi/status').set(auth(T.rep1));
  expect(s.body.data).toMatchObject({ enabled: true, canViewAll: false, canViewOwn: true, canSetTargets: false });
  expect((await request(app).get('/api/kpi').set(auth(T.lead))).status).toBe(403); // the Admin page stays Admin-only
  off();
  expect((await me('rep1')).status).toBe(404);
});
