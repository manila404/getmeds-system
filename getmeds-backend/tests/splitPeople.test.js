/**
 * Oct 30, 2026 (Aaron): a person who sells in two divisions. Nicka holds "CLIDP | NICKA"
 * (primary) and "MT | 1", and reports to Subir. Each of her orders belongs to the division
 * of the Zoho Salesperson on it: Mhalou (MT Head) sees and counts only her MT | 1 orders,
 * Subir only the CLIDP ones. See services/splitPeopleService.js.
 */
const db = require('../src/db/database');
const teamScope = require('../src/services/teamScopeService');
const { buildExport, currentMonth } = require('../src/services/kpiService');
const structure = require('../src/services/salesStructureService');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const CLIDP_NAME = `CLIDPT | NICKA ${stamp}`;
const MT_NAME = `MTT | 1 ${stamp}`;
let subir, mhalou, nicka, other, chClidp, chMt, orders = {};
const userIds = [], channelIds = [];

async function mkUser(name, role, teamLeadId = null) {
  const hash = (await db.prepare('SELECT password_hash FROM users LIMIT 1').get()).password_hash;
  const email = `${name.toLowerCase()}-${stamp}@split.test`;
  await db.prepare('INSERT INTO users (name, email, password_hash, role, is_active, team_lead_id) VALUES (?, ?, ?, ?, 1, ?)').run(name, email, hash, role, teamLeadId);
  const id = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
  userIds.push(id);
  return id;
}
async function mkChannel(name, headUserId) {
  await db.prepare('INSERT INTO sales_channels (name, head_name, head_user_id, sort_order) VALUES (?, ?, ?, 99)').run(name, name, headUserId);
  const id = (await db.prepare('SELECT id FROM sales_channels WHERE name = ?').get(name)).id;
  channelIds.push(id);
  return id;
}
async function mkTerritory(channelId, managerName, managerUserId, zoho) {
  await db.prepare('INSERT INTO sales_managers (channel_id, name, user_id, acts_as_head, sort_order) VALUES (?, ?, ?, false, 1)').run(channelId, managerName, managerUserId);
  const m = await db.prepare('SELECT id FROM sales_managers WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(channelId);
  await db.prepare('INSERT INTO sales_territories (manager_id, zoho_salesperson, person_label, is_vacant) VALUES (?, ?, ?, false)').run(m.id, zoho, zoho);
}
async function mkOrder(key, salesperson, total) {
  const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  const ref = `GM-SPLIT-${stamp}-${key}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, salesperson, created_at)
     VALUES (?, ?, ?, 'ready_for_dispatch', 'credit', ?, 'x', ?, ?)`
  ).run(ref, customerId, nicka, total, salesperson, new Date().toISOString());
  const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
  await db.prepare("INSERT INTO order_events (order_id, event_type, actor_name, created_at) VALUES (?, 'FINANCE_VERIFIED', 'test', ?)").run(id, new Date().toISOString());
  orders[key] = id;
}
async function visibleTo(viewerId) {
  const scope = await teamScope.teamScopeSql(viewerId, 'o');
  const rows = await db.prepare(`SELECT o.id FROM orders o WHERE o.getmeds_order_id LIKE ? AND ${scope.sql}`).all(`GM-SPLIT-${stamp}-%`, ...scope.params);
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

beforeAll(async () => {
  subir = await mkUser('SubirT', 'team_lead');
  mhalou = await mkUser('MhalouT', 'team_lead');
  nicka = await mkUser('NickaT', 'medrep', subir);
  other = await mkUser('OtherT', 'medrep', subir);
  chClidp = await mkChannel(`CLIDP-T ${stamp}`, null);
  chMt = await mkChannel(`MT-T ${stamp}`, mhalou);
  await mkTerritory(chClidp, 'Subir', null, CLIDP_NAME);
  await mkTerritory(chMt, 'Mhalou', null, MT_NAME);
  await db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, 1)').run(nicka, CLIDP_NAME);
  await db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, 0)').run(nicka, MT_NAME);
  await mkOrder('clidp', CLIDP_NAME, 1000);
  await mkOrder('mt', MT_NAME, 300);
  await mkOrder('blank', null, 50);
});

afterAll(async () => {
  for (const id of Object.values(orders)) {
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  for (const c of channelIds) {
    await db.prepare('DELETE FROM sales_territories WHERE manager_id IN (SELECT id FROM sales_managers WHERE channel_id = ?)').run(c);
    await db.prepare('DELETE FROM sales_managers WHERE channel_id = ?').run(c);
    await db.prepare('DELETE FROM sales_channels WHERE id = ?').run(c);
  }
  await db.prepare('DELETE FROM user_salespersons WHERE user_id = ?').run(nicka);
  for (const id of [...userIds].reverse()) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
});

describe('seeing the orders of someone in two divisions', () => {
  test('her Team Lead (CLIDP, her primary) sees the CLIDP and the blank-salesperson orders, not MT', async () => {
    expect(await visibleTo(subir)).toEqual([orders.clidp, orders.blank].sort((a, b) => a - b));
  });

  test('the MT Head sees only her MT | 1 order', async () => {
    expect(await visibleTo(mhalou)).toEqual([orders.mt]);
  });

  test('opening one order follows the same rule', async () => {
    const u = (id) => ({ id, role: 'team_lead' });
    expect(await teamScope.canAccessOrder(u(mhalou), { id: orders.mt, medrep_id: nicka })).toBe(true);
    expect(await teamScope.canAccessOrder(u(mhalou), { id: orders.clidp, medrep_id: nicka })).toBe(false);
    expect(await teamScope.canAccessOrder(u(subir), { id: orders.mt, medrep_id: nicka })).toBe(false);
    expect(await teamScope.canAccessOrder(u(subir), { id: orders.clidp, medrep_id: nicka })).toBe(true);
  });

  test('she still sees all of her own orders (nothing changes for a one-division person)', async () => {
    expect((await teamScope.teamMedrepIds(subir)).sort()).toEqual([nicka, other].sort());
  });
});

describe('KPI split per division', () => {
  let out;
  beforeAll(async () => {
    out = await buildExport({ query: async (sql, params) => ({ rows: await db._rawQuery(sql, params) }) }, currentMonth());
  });

  test('her own totals are unchanged; by_channel splits them by the Salesperson on each order', () => {
    const me = out.people.find((p) => p.user_id === nicka);
    expect(me.booked_php).toBe(1350);
    const by = Object.fromEntries(me.by_channel.map((c) => [c.channel_id, c]));
    expect(by[chClidp].booked_php).toBe(1050); // CLIDP + the blank one (primary)
    expect(by[chMt].booked_php).toBe(300);
    expect(by[chClidp].primary).toBe(true);
  });

  test('each division total gets its own part', () => {
    const ch = (id) => out.channels.find((r) => r.channel === `${id === chClidp ? 'CLIDP' : 'MT'}-T ${stamp}`);
    expect(ch(chClidp).booked_php).toBe(1050);
    expect(ch(chMt).booked_php).toBe(300);
  });

  test("her Team Lead's team row counts only her CLIDP part", () => {
    const team = out.teams.find((t) => t.team_lead === 'SubirT');
    expect(team.booked_php).toBe(1050);
  });
});

describe('Team Structure', () => {
  test('she is shown under both divisions with "also in", and the Team Lead plan does not block her', async () => {
    const s = await structure.getStructure();
    const accounts = s.heads.flatMap((h) => h.channels).flatMap((c) => c.managers).flatMap((m) => m.territories)
      .flatMap((t) => t.accounts.map((a) => ({ ...a, zoho: t.zoho_salesperson })));
    const mine = accounts.filter((a) => a.id === nicka);
    expect(mine.find((a) => a.zoho === MT_NAME).also_in).toEqual([`CLIDP-T ${stamp}`]);
    expect(mine.find((a) => a.zoho === CLIDP_NAME).also_in).toEqual([`MT-T ${stamp}`]);
    expect(mine.find((a) => a.zoho === MT_NAME).team_lead_matches).toBeNull();

    const plan = await structure.planTeamLeads();
    const item = plan.items.find((i) => i.account_id === nicka);
    expect(item.reason).not.toBe('multiple_managers');
  });
});
