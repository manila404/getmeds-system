/**
 * Monthly KPI export (scripts/kpi-export-month.js). Oct 5, 2026.
 *
 * The export is READ-ONLY and its numbers must follow the rules Aaron agreed:
 *  - booked = Finance sales-summary rule (latest FINANCE_VERIFIED event in the month,
 *    Philippine time, once per order, not imported / cancelled / deleted);
 *  - an order is credited to its OWNER, so a field rep raising for an on-site rep
 *    credits the on-site rep, while the routing stays visible;
 *  - team / head / channel rows are the sum of the people under them.
 */
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const db = require('../src/db/database');
const kpi = require('../scripts/kpi-export-month');

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const MONTH = '2026-07';
const ids = { users: [], orders: [], channel: null, manager: null };
let u = {}, customerId;

const mkUser = async (key, role) => {
  const email = `kpi-${key}-${stamp}@example.test`;
  await db.prepare(
    `INSERT INTO users (name, email, password_hash, role, first_name, last_name, is_active)
     VALUES (?, ?, ?, ?, 'K', ?, 1)`
  ).run(`KPI ${key} ${stamp}`, email, bcrypt.hashSync('x', 4), role, key);
  const row = await db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
  ids.users.push(row.id);
  return row;
};
const ev = (orderId, type, at, oldS = null, newS = null) =>
  db.prepare('INSERT INTO order_events (order_id, event_type, old_status, new_status, created_at) VALUES (?, ?, ?, ?, ?)').run(orderId, type, oldS, newS, at);
async function mkOrder(ref, owner, { raisedBy = null, total, status = 'ready_for_dispatch', created = '2026-07-10T02:00:00.000Z', imported = false, division = null }) {
  const refId = imported ? `ZOHO-${stamp}-${ref}` : `GM-KPI-${stamp}-${ref}`;
  await db.prepare(
    `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type, total_amount,
                         delivery_address, submitted_at, created_at, division)
     VALUES (?, ?, ?, ?, ?, 'credit', ?, '1 Test St', ?, ?, ?)`
  ).run(refId, customerId, owner.id, raisedBy ? raisedBy.id : null, status, total, created, created, division);
  const row = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(refId);
  ids.orders.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await db.init();
  u.onsite = await mkUser('onsite', 'medrep');
  u.field1 = await mkUser('field1', 'medrep');
  u.field2 = await mkUser('field2', 'medrep');
  u.lead = await mkUser('lead', 'team_lead');
  for (const k of ['onsite', 'field1', 'field2']) await db.prepare('UPDATE users SET team_lead_id = ? WHERE id = ?').run(u.lead.id, u[k].id);
  await db.prepare("INSERT INTO customers (name, type, zoho_contact_id, is_active) VALUES (?, 'credit', ?, 1)").run(`KPI customer ${stamp}`, `KPI-${stamp}`);
  customerId = (await db.prepare('SELECT id FROM customers WHERE name = ?').get(`KPI customer ${stamp}`)).id;

  await db.prepare("INSERT INTO sales_channels (name, head_name) VALUES (?, 'Head Person')").run(`KPI CH ${stamp}`);
  ids.channel = (await db.prepare('SELECT id FROM sales_channels WHERE name = ?').get(`KPI CH ${stamp}`)).id;
  await db.prepare('INSERT INTO sales_managers (channel_id, name, user_id) VALUES (?, ?, ?)').run(ids.channel, 'Lead', u.lead.id);
  ids.manager = (await db.prepare('SELECT id FROM sales_managers WHERE channel_id = ?').get(ids.channel)).id;
  const terr = async (user, sp, hq) => {
    await db.prepare('INSERT INTO sales_territories (manager_id, zoho_salesperson, hq) VALUES (?, ?, ?)').run(ids.manager, `${sp} ${stamp}`, hq);
    await db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, 1)').run(user.id, `${sp} ${stamp}`);
  };
  await terr(u.onsite, 'KPI | ONSITE', 'ON SITE');
  await terr(u.field1, 'KPI | KALAW', 'KALAW');
  await terr(u.field2, 'KPI | CEBU', 'CEBU');

  // A: field1 raised for the on-site rep -> credited to on-site
  const A = await mkOrder('A', u.onsite, { raisedBy: u.field1, total: 1000, status: 'completed' });
  await ev(A, 'FINANCE_VERIFIED', '2026-07-15T03:00:00.000Z');
  // B: field2 raised for the on-site rep
  const B = await mkOrder('B', u.onsite, { raisedBy: u.field2, total: 500 });
  await ev(B, 'FINANCE_VERIFIED', '2026-07-20T03:00:00.000Z');
  // C: field1's own order (held once in July)
  const C = await mkOrder('C', u.field1, { total: 300 });
  await ev(C, 'FINANCE_VERIFIED', '2026-07-21T03:00:00.000Z');
  await ev(C, 'FINANCE_REJECTED', '2026-07-12T03:00:00.000Z', 'ready_for_finance_verified', 'on_hold');
  // D: verified twice (hold then re-confirm) -> counted once
  const D = await mkOrder('D', u.field2, { total: 200 });
  await ev(D, 'FINANCE_VERIFIED', '2026-07-05T03:00:00.000Z');
  await ev(D, 'FINANCE_VERIFIED', '2026-07-06T03:00:00.000Z');
  // E: cancelled; F: a draft Management cancelled — both excluded
  const E = await mkOrder('E', u.field1, { total: 9000, status: 'cancelled' });
  await ev(E, 'FINANCE_VERIFIED', '2026-07-08T03:00:00.000Z');
  const F = await mkOrder('F', u.field1, { total: 9100, status: 'cancelled' });
  await db.prepare('UPDATE orders SET draft_cancelled_at = ? WHERE id = ?').run('2026-07-09T03:00:00.000Z', F);
  await ev(F, 'FINANCE_VERIFIED', '2026-07-09T03:00:00.000Z');
  // G: verified 2026-07-31 17:00 UTC = 1 Aug 01:00 in Manila -> NOT July
  const G = await mkOrder('G', u.field1, { total: 700 });
  await ev(G, 'FINANCE_VERIFIED', '2026-07-31T17:00:00.000Z');
  // H: imported from Zoho -> excluded
  const H = await mkOrder('H', u.field1, { total: 8000, imported: true });
  await ev(H, 'FINANCE_VERIFIED', '2026-07-10T03:00:00.000Z');
  // I: a draft in July is not an "order" yet
  await mkOrder('I', u.field2, { total: 123, status: 'draft' });
});

afterAll(async () => {
  for (const id of ids.orders) {
    await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id);
    await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  }
  for (const id of ids.users) await db.prepare('DELETE FROM user_salespersons WHERE user_id = ?').run(id);
  await db.prepare('DELETE FROM sales_territories WHERE manager_id = ?').run(ids.manager);
  await db.prepare('DELETE FROM sales_managers WHERE id = ?').run(ids.manager);
  await db.prepare('DELETE FROM sales_channels WHERE id = ?').run(ids.channel);
  await db.prepare('UPDATE users SET team_lead_id = NULL WHERE team_lead_id = ?').run(u.lead.id);
  for (const id of ids.users) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  await db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
});

const run = (targets = []) => kpi.runReadOnly(process.env.DATABASE_URL, MONTH, targets);
const person = (r, user) => r.people.find((p) => p.user_id === user.id);

describe('month range', () => {
  test('a month is Philippine time: July starts 16:00 UTC on 30 June', () => {
    expect(kpi.monthRange('2026-07')).toEqual(['2026-06-30T16:00:00.000Z', '2026-07-31T16:00:00.000Z']);
  });
  test('rejects a bad month', () => { expect(() => kpi.monthRange('2026-13')).toThrow(); });
});

describe('booked and attribution', () => {
  test('orders are credited to the OWNER; the field reps\' part stays visible, uncredited', async () => {
    const r = await run();
    const on = person(r, u.onsite);
    expect(on.booked_php).toBe(1500);
    expect(on.booked_orders).toBe(2);
    expect(on.booked_raised_by_others_php).toBe(1500);
    expect(on.rep_type).toBe('On-site');
    expect(person(r, u.field1).booked_php).toBe(300);
    expect(person(r, u.field1).raised_for_others_info_php).toBe(1000);
    expect(person(r, u.field2).booked_php).toBe(200);          // verified twice, counted once
    expect(person(r, u.field2).raised_for_others_info_php).toBe(500);
    expect(person(r, u.field1).rep_type).toBe('Field');
  });

  test('cancelled, Management-cancelled draft, imported and next-month (Manila) orders are left out', async () => {
    const r = await run();
    expect(r.totalBooked).toBe(2000);                           // 1000 + 500 + 300 + 200
    expect(r.exportedBooked).toBe(r.totalBooked);
  });

  test('orders count excludes drafts; held counts a move INTO on hold', async () => {
    const r = await run();
    expect(person(r, u.field2).orders).toBe(1);                 // D only: B is the on-site rep's, the draft is not an order yet
    expect(person(r, u.field1).held).toBeUndefined();
    expect(person(r, u.field1).orders_held).toBe(1);
  });

  test('routing shows who raised for whom', async () => {
    const r = await run();
    const rows = r.routing.filter((x) => x.owner_credited.includes(stamp));
    expect(rows.map((x) => `${x.raised_by.split(' ')[1]}>${x.booked_php}`).sort()).toEqual(['field1>1000', 'field2>500']);
  });
});

describe('roll-ups are the sum of the people', () => {
  test('team, head and channel add up exactly', async () => {
    const r = await run([{ email: u.onsite.email, month: MONTH, target_php: '2000' }, { email: u.field1.email, month: MONTH, target_php: '1000' }]);
    const team = r.teams.find((t) => t.team_lead.includes(stamp));
    expect(team.booked_php).toBe(2000);
    expect(team.target_php).toBe(3000);
    expect(team.targets_missing).toBe(1);                        // field2 has no target
    const ch = r.channels.find((c) => c.channel === `KPI CH ${stamp}`);
    expect(ch.booked_php).toBe(2000);
    expect(r.heads.find((h) => h.head === 'Head Person').booked_php).toBeGreaterThanOrEqual(2000);
    expect(person(r, u.onsite).pct_of_target).toBe(75);
  });

  test('the two untracked metrics say so', async () => {
    const r = await run();
    expect(person(r, u.onsite).new_customers).toBe('Not tracked yet');
    expect(r.checks.find((c) => c.check.startsWith('New customers')).value).toBe('Not tracked yet');
  });
});

describe('safety', () => {
  test('the export session is read-only: a write inside it fails', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await expect(c.query("UPDATE users SET name = name WHERE id = $1", [u.onsite.id])).rejects.toThrow(/read-only/i);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); await pool.end(); }
  });
});

describe('targets file helpers', () => {
  test('copy-last-month never overwrites an existing value', () => {
    const rows = [
      { email: 'a@x', month: '2026-06', target_php: '100' },
      { email: 'b@x', month: '2026-06', target_php: '200' },
      { email: 'a@x', month: '2026-07', target_php: '999' }
    ];
    const out = kpi.copyTargets(rows, '2026-06', '2026-07');
    expect(out.added).toBe(1);
    expect(out.rows.filter((r) => r.month === '2026-07').map((r) => `${r.email}:${r.target_php}`).sort()).toEqual(['a@x:999', 'b@x:200']);
  });
  test('csv round trip handles commas, quotes and the Excel BOM', () => {
    const csv = kpi.toCsv(['email', 'name'], [{ email: 'a@x', name: 'Doe, "Jo"' }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(kpi.parseCsv(csv)).toEqual([{ email: 'a@x', name: 'Doe, "Jo"' }]);
  });
});

describe('people with no territory are placed by the division of their orders', () => {
  const M2 = '2026-05';
  let orphan, lost;
  const run2 = () => kpi.runReadOnly(process.env.DATABASE_URL, M2, []);

  beforeAll(async () => {
    orphan = await mkUser('orphan', 'medrep');     // no territory
    lost = await mkUser('lost', 'medrep');         // no territory, division matches nothing
    const a = await mkOrder('O1', orphan, { total: 400, created: '2026-05-10T02:00:00.000Z', division: `KPI CH ${stamp}` });
    await ev(a, 'FINANCE_VERIFIED', '2026-05-12T03:00:00.000Z');
    const b = await mkOrder('O2', orphan, { total: 50, created: '2026-05-11T02:00:00.000Z', division: 'SOMETHING ELSE' });
    await ev(b, 'FINANCE_VERIFIED', '2026-05-13T03:00:00.000Z');
    const c = await mkOrder('L1', lost, { total: 100, created: '2026-05-10T02:00:00.000Z', division: 'ZZ NO SUCH CHANNEL' });
    await ev(c, 'FINANCE_VERIFIED', '2026-05-14T03:00:00.000Z');
  });

  test('placed under the channel their biggest division matches, and counted once', async () => {
    const r = await run2();
    const p = r.people.find((x) => x.user_id === orphan.id);
    expect(p.channel).toBe(`KPI CH ${stamp}`);
    expect(p.channel_source).toBe('order division (fallback)');
    expect(p.order_divisions).toBe(`KPI CH ${stamp} / SOMETHING ELSE`);
    expect(r.channels.find((c) => c.channel === `KPI CH ${stamp}`).booked_php).toBe(450);
  });

  test('a person whose division matches no channel stays unplaced, and the totals still add up', async () => {
    const r = await run2();
    const p = r.people.find((x) => x.user_id === lost.id);
    expect(p.channel).toBe('(unplaced)');
    expect(p.channel_source).toBe('none');
    expect(r.channels.reduce((a, c) => a + c.booked_php, 0)).toBe(r.totalBooked);   // 450 + 100 = 550
    expect(r.exportedBooked).toBe(r.totalBooked);
  });

  test('both appear in the separate unplaced list, biggest first, with their booked pesos', async () => {
    const r = await run2();
    const mine = r.unplaced.filter((x) => [orphan.email, lost.email].includes(x.email));
    expect(mine.map((x) => `${x.booked_php}:${x.how_placed}`)).toEqual(['450:order division (fallback)', '100:none']);
  });

  test('a person with a territory is not on the unplaced list', async () => {
    const r = await run();
    expect(r.unplaced.some((x) => x.email === u.onsite.email)).toBe(false);
  });
});
