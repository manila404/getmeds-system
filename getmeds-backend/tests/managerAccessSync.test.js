/**
 * Sep 26, 2026 — Manager Access derived from the team structure.
 *
 * Pinned here:
 *   - the preview reads only, and classifies each Management account
 *     (full_access / differs / matches / not_in_structure)
 *   - a manager who approves every approved channel and has full access is left alone
 *   - apply changes exactly the accounts named, replaces their rules in one go, and
 *     never writes an empty division list
 *   - going from full access to a division list needs confirm_restrict
 *   - admin only; there is no "apply all"
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const stamp = Date.now();
const createdUsers = [];
let adminToken, medrepToken, passwordHash, full, partial, outsider;
let chB2B, chBID;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const plan = (t = adminToken) => request(app).get('/api/admin/team-structure/manager-access-plan').set(auth(t));
const apply = (body, t = adminToken) => request(app).post('/api/admin/team-structure/manager-access-plan/apply').set(auth(t)).send(body);
const item = (res, id) => res.body.data.items.find((i) => i.user_id === id);

async function makeManager(label) {
  const email = `ma-${label}-${stamp}@getmeds.ph`;
  await db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(`MA ${label} ${stamp}`, email, passwordHash, 'management');
  const u = await db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  createdUsers.push(u.id);
  return u;
}
async function scopeOf(id) {
  const u = await db.prepare('SELECT order_scope FROM users WHERE id = ?').get(id);
  const rules = await db.prepare('SELECT division, sub_division FROM manager_order_scope WHERE user_id = ? ORDER BY division').all(id);
  return { mode: u.order_scope, divisions: rules.map((r) => r.division) };
}

describe('manager access from the structure', () => {
  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    passwordHash = (await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph')).password_hash;
    await db.prepare('DELETE FROM sales_channel_approvers').run();
    await db.prepare('DELETE FROM sales_territories').run();
    await db.prepare('DELETE FROM sales_managers').run();
    await db.prepare('DELETE FROM sales_channels').run();

    full = await makeManager('full');
    partial = await makeManager('partial');
    outsider = await makeManager('outsider');

    const ch = async (name) => (await db.prepare('INSERT INTO sales_channels (name, head_name, sort_order) VALUES (?, ?, ?)').run(name, 'Head', 1)).lastInsertRowid;
    chB2B = await ch('B2B');
    chBID = await ch('BID');
    const ap = (channel, u) => db.prepare('INSERT INTO sales_channel_approvers (channel_id, name, user_id, sort_order) VALUES (?, ?, ?, 1)').run(channel, u.name, u.id);
    await ap(chB2B, full); await ap(chBID, full);
    await ap(chB2B, partial);
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM sales_channel_approvers').run();
    await db.prepare('DELETE FROM sales_managers').run();
    await db.prepare('DELETE FROM sales_channels').run();
    for (const id of createdUsers) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  test('admin only', async () => {
    expect((await plan(medrepToken)).status).toBe(403);
    expect((await apply({ user_ids: [partial.id] }, medrepToken)).status).toBe(403);
  });

  test('the preview classifies each manager and changes nothing', async () => {
    const before = await scopeOf(partial.id);
    const res = await plan();
    expect(res.status).toBe(200);
    expect(item(res, full.id).status).toBe('full_access');
    expect(item(res, outsider.id).status).toBe('not_in_structure');
    const p = item(res, partial.id);
    expect(p.status).toBe('differs');
    expect(p.proposed_divisions).toEqual(['B2B']);
    expect(p.approves_channels).toEqual(['B2B']);
    expect(p.drops_unattributed).toBeGreaterThanOrEqual(0);
    expect(await scopeOf(partial.id)).toEqual(before);
  });

  test('apply needs the account ids, and there is no apply-all', async () => {
    expect((await apply({})).status).toBe(400);
    expect((await apply({ user_ids: [] })).status).toBe(400);
    expect((await apply({ user_ids: 'all' })).status).toBe(400);
  });

  test('full access to a division list needs confirm_restrict when orders carry no division', async () => {
    const p = item(await plan(), partial.id);
    const res = await apply({ user_ids: [partial.id] });
    let ok = res;
    if (p.drops_unattributed > 0) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CONFIRM_REQUIRED');
      expect((await scopeOf(partial.id)).mode).not.toBe('divisions');
      ok = await apply({ user_ids: [partial.id], confirm_restrict: true });
    }
    expect(ok.status).toBe(200);
    expect(ok.body.data.applied.map((a) => a.user_id)).toEqual([partial.id]);
    expect(await scopeOf(partial.id)).toEqual({ mode: 'divisions', divisions: ['B2B'] });
  });

  test('once applied the manager matches, and applying again skips them', async () => {
    expect(item(await plan(), partial.id).status).toBe('matches');
    const again = await apply({ user_ids: [partial.id], confirm_restrict: true });
    expect(again.body.data.applied).toHaveLength(0);
    expect(again.body.data.skipped[0]).toEqual({ user_id: partial.id, reason: 'matches' });
  });

  test('a full-access manager and an account outside the structure are never changed', async () => {
    const res = await apply({ user_ids: [full.id, outsider.id, 99999999], confirm_restrict: true });
    expect(res.body.data.applied).toHaveLength(0);
    expect(res.body.data.skipped.map((s) => s.reason)).toEqual(['full_access', 'not_in_structure', 'not_a_management_account']);
    expect((await scopeOf(full.id)).mode).not.toBe('divisions');
    expect((await scopeOf(outsider.id)).mode).not.toBe('divisions');
  });

  test('a change in the structure shows as a difference, and apply replaces the rules', async () => {
    const ap = (channel, u) => db.prepare('INSERT INTO sales_channel_approvers (channel_id, name, user_id, sort_order) VALUES (?, ?, ?, 2)').run(channel, u.name, u.id);
    await ap(chBID, partial);
    const p = item(await plan(), partial.id);
    expect(p.status).toBe('differs');
    expect(p.proposed_divisions).toEqual(['B2B', 'BID']);
    expect(p.add).toEqual(['BID']);
    const ok = await apply({ user_ids: [partial.id] });
    expect(ok.status).toBe(200);
    expect(await scopeOf(partial.id)).toEqual({ mode: 'divisions', divisions: ['B2B', 'BID'] });
  });
});
