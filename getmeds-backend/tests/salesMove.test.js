/**
 * Move / change role in the Sales department. Oct 30, 2026 (Aaron).
 * Every switch is previewed first and applied together. See services/salesMoveService.js.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const userIds = [], channelIds = [], orderIds = [];
let adminToken, boss, lead, rep1, rep2, successor, chA, chB;
const NAME_A = `AAA | REP1 ${stamp}`, NAME_B = `BBB | NEW ${stamp}`, NAME_A2 = `AAA | REP2 ${stamp}`;

async function mkUser(name, role, teamLeadId = null, title = null) {
  const hash = (await db.prepare('SELECT password_hash FROM users LIMIT 1').get()).password_hash;
  const email = `${name.toLowerCase()}-${stamp}@move.test`;
  await db.prepare('INSERT INTO users (name, email, password_hash, role, is_active, team_lead_id, sales_title, division) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
    .run(`${name} ${stamp}`, email, hash, role, teamLeadId, title, 'CLIDP');
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
  userIds.push(id);
  return id;
}
async function mkChannel(name) {
  await db.prepare('INSERT INTO sales_channels (name, head_name, sort_order) VALUES (?, ?, 99)').run(name, name);
  const id = (await db.prepare('SELECT id FROM sales_channels WHERE name = ?').get(name)).id;
  channelIds.push(id);
  return id;
}
async function mkTerritory(channelId, zoho, managerUserId = null) {
  await db.prepare('INSERT INTO sales_managers (channel_id, name, user_id, acts_as_head, sort_order) VALUES (?, ?, ?, false, 1)').run(channelId, `M ${zoho}`, managerUserId);
  const m = await db.prepare('SELECT id FROM sales_managers WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(channelId);
  await db.prepare('INSERT INTO sales_territories (manager_id, zoho_salesperson, person_label, is_vacant) VALUES (?, ?, ?, false)').run(m.id, zoho, zoho);
}
async function mkOrder(owner, status, key) {
  const c = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  const ref = `GM-MOVE-${stamp}-${key}`;
  await db.prepare("INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address) VALUES (?, ?, ?, ?, 'credit', 100, 'x')")
    .run(ref, c, owner, status);
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  orderIds.push(id);
  return id;
}
const call = (method, id, path = '', body) => request(app)[method](`/api/admin/users/${id}/sales-move${path}`).set({ Authorization: `Bearer ${adminToken}` }).send(body);
const ownerOf = async (oid) => (await db.prepare('SELECT medrep_id FROM orders WHERE id = ?').get(oid)).medrep_id;
const namesOf = async (uid) => (await db.prepare('SELECT salesperson, is_primary FROM user_salespersons WHERE user_id = ? ORDER BY is_primary DESC, salesperson').all(uid));

beforeAll(async () => {
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@getmeds.ph', password: 'demo123' })).body.data.token;
  boss = await mkUser('Boss', 'team_lead');
  lead = await mkUser('Lead', 'team_lead', boss, 'Team Leader');
  rep1 = await mkUser('RepOne', 'medrep', lead);
  rep2 = await mkUser('RepTwo', 'medrep', lead);
  successor = await mkUser('Succ', 'medrep', boss);
  chA = await mkChannel(`CH-A ${stamp}`);
  chB = await mkChannel(`CH-B ${stamp}`);
  await mkTerritory(chA, NAME_A, lead);
  await mkTerritory(chA, NAME_A2);
  await mkTerritory(chB, NAME_B);
  await db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, 1)').run(rep1, NAME_A);
  await db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, 1)').run(rep2, NAME_A2);
});

afterAll(async () => {
  for (const id of orderIds) { await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id); await db.prepare('DELETE FROM orders WHERE id = ?').run(id); }
  for (const c of channelIds) {
    await db.prepare('DELETE FROM sales_territories WHERE manager_id IN (SELECT id FROM sales_managers WHERE channel_id = ?)').run(c);
    await db.prepare('DELETE FROM sales_managers WHERE channel_id = ?').run(c);
    await db.prepare('DELETE FROM sales_channels WHERE id = ?').run(c);
  }
  for (const id of userIds) { await db.prepare('DELETE FROM user_salespersons WHERE user_id = ?').run(id); await db.prepare('DELETE FROM notifications WHERE recipient_id = ?').run(id); }
  await db.prepare('UPDATE users SET team_lead_id = NULL WHERE id = ANY(?)').run([userIds]);
  for (const id of [...userIds].reverse()) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
});

describe('what they hold', () => {
  test('describe lists their people, Team Lead row and Zoho names', async () => {
    const res = await call('get', lead);
    expect(res.status).toBe(200);
    expect(res.body.data.people.map((p) => p.id).sort()).toEqual([rep1, rep2].sort());
    expect(res.body.data.lead_rows.map((r) => r.channel_id)).toEqual([chA]);
  });

  test('outside Sales is refused', async () => {
    const admin = await db.prepare("SELECT id FROM users WHERE email = 'admin@getmeds.ph'").get();
    expect((await call('get', admin.id)).status).toBe(409);
  });
});

describe('Team Lead -> MedRep', () => {
  test('blocked until their people have somewhere to go; preview saves nothing', async () => {
    const res = await call('post', lead, '/preview', { role: 'medrep' });
    expect(res.status).toBe(200);
    expect(res.body.data.errors.join(' ')).toMatch(/Choose the Team Lead they move to/);
    expect((await call('post', lead, '/apply', { role: 'medrep' })).status).toBe(400);
    expect((await db.prepare('SELECT role FROM users WHERE id = ?').get(lead)).role).toBe('team_lead');
  });

  test('applied: people move, the Team Lead row is unlinked, the title is cleared', async () => {
    const body = { role: 'medrep', people_to: boss, primary_salesperson: NAME_B };
    const preview = await call('post', lead, '/preview', body);
    expect(preview.body.data.errors).toEqual([]);
    expect(preview.body.data.switches.map((s) => s.action)).toEqual(expect.arrayContaining(['SWITCH', 'MOVE', 'OFF', 'ON']));
    const res = await call('post', lead, '/apply', body);
    expect(res.status).toBe(200);
    const me = await db.prepare('SELECT role, sales_title FROM users WHERE id = ?').get(lead);
    expect(me).toEqual({ role: 'medrep', sales_title: null });
    for (const r of [rep1, rep2]) expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(r)).team_lead_id).toBe(boss);
    expect(await db.prepare('SELECT 1 AS x FROM sales_managers WHERE user_id = ?').get(lead)).toBeFalsy();
    expect((await namesOf(lead)).map((n) => n.salesperson)).toEqual([NAME_B]);
  });
});

describe('MedRep changes department, handing over', () => {
  test('new main name and division; old name and orders still to act on go to the successor; shipped orders stay', async () => {
    const draft = await mkOrder(rep1, 'draft', 'd');
    const held = await mkOrder(rep1, 'on_hold', 'h');
    const shipped = await mkOrder(rep1, 'tracking_shared', 's');
    const body = { primary_salesperson: NAME_B, names: { [NAME_A]: 'hand' }, hand_to: successor, orders: 'hand' };
    const res = await call('post', rep1, '/apply', body);
    expect(res.status).toBe(200);
    expect((await namesOf(rep1)).map((n) => n.salesperson)).toEqual([NAME_B]);
    expect((await namesOf(successor)).map((n) => n.salesperson)).toEqual([NAME_A]);
    expect(await ownerOf(draft)).toBe(successor);
    expect(await ownerOf(held)).toBe(successor);
    expect(await ownerOf(shipped)).toBe(rep1);
    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'ORDER_REASSIGNED'").get(draft);
    expect(ev.notes).toMatch(/Moved from RepOne/);
  });

  test('an old name can be left vacant instead', async () => {
    const res = await call('post', rep2, '/apply', { primary_salesperson: NAME_B, names: { [NAME_A2]: 'vacant' } });
    expect(res.status).toBe(200);
    const t = await db.prepare('SELECT is_vacant FROM sales_territories WHERE zoho_salesperson = ?').get(NAME_A2);
    expect(Boolean(t.is_vacant)).toBe(true);
  });

  test('a MedRep cannot be left with no Zoho name', async () => {
    const res = await call('post', successor, '/preview', { names: { [NAME_A]: 'vacant' } });
    expect(res.body.data.errors.join(' ')).toMatch(/at least one Zoho name/);
  });
});

describe('MedRep -> Team Lead', () => {
  test('gets the title and a Team Lead row in the chosen channel', async () => {
    const res = await call('post', successor, '/apply', { role: 'team_lead', lead_channel_id: chB });
    expect(res.status).toBe(200);
    const me = await db.prepare('SELECT role, sales_title FROM users WHERE id = ?').get(successor);
    expect(me).toEqual({ role: 'team_lead', sales_title: 'Team Leader' });
    expect(await db.prepare('SELECT 1 AS x FROM sales_managers WHERE user_id = ? AND channel_id = ?').get(successor, chB)).toBeTruthy();
  });
});
