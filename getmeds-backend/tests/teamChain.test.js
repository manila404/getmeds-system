/**
 * The sales structure's team chain (Aaron sheet 12.13, step 2). Oct 6, 2026.
 *
 * Manager > Team Leader > Leader > MedRep, all through users.team_lead_id:
 *   Javed > Honey > Shiela > Marwin        and        Honey > Benjie > Antonnete
 *  - everyone ABOVE sees an order (Shiela, Honey and Javed see Marwin's); nobody beside does;
 *  - an order can be raised for anyone BELOW, including a Leader (Honey for Shiela),
 *    never sideways (Shiela for Benjie's MedRep) and a MedRep never for a Leader;
 *  - a loop in the Team Lead settings is refused, and could not hang the lookup anyway;
 *  - the title (Manager / Team Leader / Leader) is Admin-set and display only;
 *  - a resent Zoho order takes the order's own Division / Sub-division.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { teamMedrepIds } = require('../src/services/teamScopeService');
const { buildZohoSalesOrderPayload } = require('../src/services/zohoPayloadBuilder');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const created = { users: [], orders: [] };
const P = {};
const T = {};
let adminToken, customer, product;

const savedGate = { ids: process.env.ZOHO_TEST_CUSTOMER_IDS, id: process.env.ZOHO_TEST_CUSTOMER_ID };
const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}`);
  return res.body.data.token;
}
async function person(key, role, leadKey = null) {
  const seed = await db.prepare("SELECT password_hash FROM users WHERE email = 'admin@getmeds.ph'").get();
  const email = `chain-${key}-${stamp}@example.test`;
  const info = await db.prepare(
    `INSERT INTO users (name, email, password_hash, role, is_active, approval_status, created_at, team_lead_id)
     VALUES (?, ?, ?, ?, 1, 'approved', ?, ?)`
  ).run(`Chain ${key} ${stamp}`, email, seed.password_hash, role, new Date().toISOString(), leadKey ? P[leadKey] : null);
  P[key] = info.lastInsertRowid;
  created.users.push(info.lastInsertRowid);
  T[key] = await login(email);
}
async function plant(key, ownerKey, raisedByKey = null) {
  const now = new Date().toISOString();
  const info = await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type, total_amount,
                         delivery_address, created_at, updated_at, division, sub_division)
     VALUES (?, ?, ?, ?, 'pending_management_approval', 'direct', 100, '1 Chain St', ?, ?, 'STC', 'MD TELESALES')`
  ).run(`GM-CHAIN-${stamp}-${key}`, customer.id, P[ownerKey], raisedByKey ? P[raisedByKey] : null, now, now);
  created.orders.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}
const raise = (token, forKey) => request(app).post('/api/orders').set(auth(token)).send({
  customer_id: customer.id, items: [{ product_id: product.id, quantity: 1, rate: 25 }],
  delivery_address: '1 Chain St, Manila', is_draft: true, medrep_id: P[forKey]
}).then((res) => { if (res.body?.data?.order?.id) created.orders.push(res.body.data.order.id); return res; });
const listIds = async (token) => (await request(app).get('/api/management/orders?limit=5000').set(auth(token))).body.data.orders.map((o) => o.id);

beforeAll(async () => {
  delete process.env.ZOHO_TEST_CUSTOMER_IDS;
  delete process.env.ZOHO_TEST_CUSTOMER_ID;
  adminToken = await login('admin@getmeds.ph');
  customer = await db.prepare('SELECT * FROM customers WHERE zoho_contact_id IS NOT NULL AND is_active = 1 LIMIT 1').get();
  product = await db.prepare('SELECT * FROM products WHERE is_active = 1 LIMIT 1').get();
  await person('javed', 'team_lead');
  await person('honey', 'team_lead', 'javed');
  await person('shiela', 'team_lead', 'honey');
  await person('benjie', 'team_lead', 'honey');
  await person('marwin', 'medrep', 'shiela');
  await person('antonnete', 'medrep', 'benjie');
  await person('outsider', 'medrep');
  P.marwinOrder = await plant('M', 'marwin');
  P.antonOrder = await plant('A', 'antonnete');
  P.outsiderOrder = await plant('O', 'outsider');
});

afterAll(async () => {
  restore('ZOHO_TEST_CUSTOMER_IDS', savedGate.ids);
  restore('ZOHO_TEST_CUSTOMER_ID', savedGate.id);
  for (const id of created.orders) {
    for (const t of ['notifications', 'order_events', 'order_items']) await db.prepare(`DELETE FROM ${t} WHERE order_id = ?`).run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  await db.prepare(`UPDATE users SET team_lead_id = NULL WHERE id IN (${created.users.map(() => '?').join(',')})`).run(...created.users);
  for (const id of [...created.users].reverse()) {
    await db.prepare('DELETE FROM notifications WHERE recipient_id = ?').run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
});

describe('who is on whose team', () => {
  test('the whole chain below, at any depth, and nobody beside or above', async () => {
    const has = async (k) => new Set(await teamMedrepIds(P[k]));
    const javed = await has('javed'), honey = await has('honey'), shiela = await has('shiela');
    for (const k of ['honey', 'shiela', 'benjie', 'marwin', 'antonnete']) expect(javed.has(P[k])).toBe(true);
    for (const k of ['shiela', 'benjie', 'marwin', 'antonnete']) expect(honey.has(P[k])).toBe(true);
    expect([...shiela]).toEqual([P.marwin]);
    expect(honey.has(P.javed)).toBe(false);
    expect(javed.has(P.outsider)).toBe(false);
  });

  test("a loop in the settings cannot hang the lookup", async () => {
    await db.prepare('UPDATE users SET team_lead_id = ? WHERE id = ?').run(P.marwin, P.javed); // Javed under Marwin: a loop
    try {
      const ids = await teamMedrepIds(P.honey);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(P.honey);
    } finally {
      await db.prepare('UPDATE users SET team_lead_id = NULL WHERE id = ?').run(P.javed);
    }
  });

  test("everyone above sees Marwin's order; Benjie beside does not; nobody sees the outsider's", async () => {
    for (const k of ['shiela', 'honey', 'javed']) expect(await listIds(T[k])).toContain(P.marwinOrder);
    expect(await listIds(T.benjie)).not.toContain(P.marwinOrder);
    expect(await listIds(T.benjie)).toContain(P.antonOrder);
    for (const k of ['shiela', 'honey', 'javed', 'benjie']) expect(await listIds(T[k])).not.toContain(P.outsiderOrder);
    expect((await request(app).get(`/api/orders/${P.marwinOrder}`).set(auth(T.honey))).status).toBe(200);
    expect((await request(app).get(`/api/orders/${P.marwinOrder}`).set(auth(T.benjie))).status).toBe(403);
  });
});

describe('who can raise an order for whom', () => {
  test('down the chain is allowed, including a Leader: Honey for Shiela, Shiela for Marwin, Javed for Antonnete', async () => {
    const a = await raise(T.honey, 'shiela');
    expect(a.status).toBe(201);
    expect((await db.prepare('SELECT medrep_id, raised_by_id FROM orders WHERE id = ?').get(a.body.data.order.id)))
      .toEqual({ medrep_id: P.shiela, raised_by_id: P.honey });
    expect((await raise(T.shiela, 'marwin')).status).toBe(201);
    expect((await raise(T.javed, 'antonnete')).status).toBe(201);
  });

  test('sideways and upwards are refused: Shiela for Benjie or his MedRep, Shiela for Honey', async () => {
    for (const k of ['benjie', 'antonnete', 'honey']) {
      const r = await raise(T.shiela, k);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_MEDREP');
    }
  });

  test('a MedRep still raises only for MedReps, never for a Leader', async () => {
    expect((await raise(T.marwin, 'antonnete')).status).toBe(201); // unchanged for now (Aaron, Oct 6)
    expect((await raise(T.marwin, 'shiela')).status).toBe(400);
  });

  test("a Leader can pick themselves", async () => {
    expect((await raise(T.shiela, 'shiela')).status).toBe(201);
  });

  test("the order form's picker lists Leaders below, and only those", async () => {
    const names = async (k) => (await request(app).get('/api/orders/meta/medreps').set(auth(T[k]))).body.data.medreps.map((m) => m.id);
    const honey = await names('honey');
    for (const k of ['shiela', 'benjie', 'marwin', 'antonnete']) expect(honey).toContain(P[k]);
    expect(await names('shiela')).toEqual([P.marwin]);
    expect(await names('marwin')).not.toContain(P.shiela);
  });
});

describe('Admin settings', () => {
  const patch = (key, body, token = adminToken) => request(app).patch(`/api/admin/users/${P[key]}`).set(auth(token)).send(body);

  test('a Leader can have a Team Lead; a loop is refused and nothing changes', async () => {
    expect((await patch('benjie', { team_lead_id: P.javed })).status).toBe(200);
    expect((await patch('benjie', { team_lead_id: P.honey })).status).toBe(200);
    const loop = await patch('honey', { team_lead_id: P.shiela }); // Shiela is under Honey
    expect(loop.status).toBe(400);
    expect(loop.body.error.code).toBe('TEAM_LEAD_LOOP');
    expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(P.honey)).team_lead_id).toBe(P.javed);
  });

  test('the title is set by Admin, checked, and shown in the users list', async () => {
    expect((await patch('shiela', { sales_title: 'Leader' })).body.data.user.sales_title).toBe('Leader');
    expect((await patch('shiela', { sales_title: 'Boss' })).status).toBe(400);
    expect((await patch('shiela', { sales_title: 'Leader' }, T.honey)).status).toBe(403);
    const list = (await request(app).get('/api/admin/users').set(auth(adminToken))).body.data;
    const rows = Array.isArray(list) ? list : list.users;
    expect(rows.find((u) => u.id === P.shiela).sales_title).toBe('Leader');
    expect((await patch('shiela', { sales_title: null })).body.data.user.sales_title).toBe(null);
  });
});

test("a resent Zoho order takes the order's own Division and Sub-division, not the account's", async () => {
  await db.prepare("UPDATE users SET division = 'B2B', sub_division = 'KALAW' WHERE id = ?").run(P.marwin);
  const payload = await buildZohoSalesOrderPayload(P.marwinOrder);
  expect(payload.division).toBe('STC');
  expect(payload.sub_division).toBe('MD TELESALES');
});

describe('My Team tabs (step 3)', () => {
  const { teamGroups } = require('../src/services/teamScopeService');
  const ordersIn = async (k, group) =>
    (await request(app).get(`/api/management/orders?limit=5000&team_group=${encodeURIComponent(group)}`).set(auth(T[k]))).body.data.orders.map((o) => o.id);

  beforeAll(async () => {
    await person('fhaye', 'medrep', 'honey');
    await db.prepare("UPDATE users SET division = 'B2C' WHERE id = ?").run(P.fhaye);
    P.fhayeOrder = await plant('F', 'fhaye');
  });

  test("Honey gets one tab per Leader plus her own direct reps; Javed (one team under him) gets none", async () => {
    const g = await teamGroups(P.honey);
    expect(g.map((x) => x.key)).toEqual([`mine:B2C`, `lead:${P.benjie}`, `lead:${P.shiela}`]);
    expect(g.find((x) => x.key === `lead:${P.shiela}`).ids.sort()).toEqual([P.shiela, P.marwin].sort());
    expect(await teamGroups(P.javed)).toEqual([]);
    const summary = await request(app).get('/api/management/summary').set(auth(T.honey));
    expect(summary.body.data.scope.groups.map((x) => x.label)).toEqual(['My team: B2C', `Chain benjie ${stamp}'s team`, `Chain shiela ${stamp}'s team`]);
  });

  test("a tab shows only that group's orders; All still shows everything", async () => {
    const shiela = await ordersIn('honey', `lead:${P.shiela}`);
    expect(shiela).toContain(P.marwinOrder);
    expect(shiela).not.toContain(P.antonOrder);
    expect(shiela).not.toContain(P.fhayeOrder);
    expect(await ordersIn('honey', 'mine:B2C')).toEqual([P.fhayeOrder]);
    const all = await listIds(T.honey);
    for (const id of [P.marwinOrder, P.antonOrder, P.fhayeOrder]) expect(all).toContain(id);
  });

  test("a tab can never widen what someone sees: an unknown or someone else's group shows nothing", async () => {
    expect(await ordersIn('honey', 'lead:999999')).toEqual([]);
    expect(await ordersIn('shiela', `lead:${P.benjie}`)).toEqual([]);
    expect(await ordersIn('benjie', 'mine:B2C')).toEqual([]);
  });

  test('the summary cards and activity follow the tab too', async () => {
    const all = await request(app).get('/api/management/summary').set(auth(T.honey));
    const one = await request(app).get(`/api/management/summary?team_group=${encodeURIComponent('mine:B2C')}`).set(auth(T.honey));
    expect(one.status).toBe(200);
    expect(one.body.data.total_orders).toBeLessThan(all.body.data.total_orders);
    expect((await request(app).get(`/api/management/activity?team_group=lead:999999`).set(auth(T.honey))).body.data.events).toEqual([]);
  });
});
