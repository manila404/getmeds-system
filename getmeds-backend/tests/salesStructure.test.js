/**
 * Sep 26, 2026 — the sales team structure (Head > Channel > Manager > Territory).
 *
 * Pinned here:
 *   - the bundled sheet loads completely, and loading it again changes nothing an
 *     admin has edited
 *   - a territory finds its accounts by Zoho salesperson name, or by the old name
 *     Zoho still uses after a rename; a deactivated account does not cover it
 *   - the Team Lead PREVIEW reads only, and says why a row cannot be applied
 *   - APPLY changes exactly the accounts named, and only those the preview marks
 *     'change'. There is no "apply all".
 *   - admin only
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const SEED = require('../src/seeds/salesStructure.json');

const stamp = Date.now();
const createdUsers = [];
let adminToken, medrepToken, passwordHash, veronica;

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'demo123' });
  if (res.status !== 200) throw new Error(`Login failed for ${email}`);
  return res.body.data.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (p, t = adminToken) => request(app).get(`/api/admin/team-structure${p}`).set(auth(t));
const post = (p, body, t = adminToken) => request(app).post(`/api/admin/team-structure${p}`).set(auth(t)).send(body);
const patch = (p, body, t = adminToken) => request(app).patch(`/api/admin/team-structure${p}`).set(auth(t)).send(body);
const del = (p, t = adminToken) => request(app).delete(`/api/admin/team-structure${p}`).set(auth(t));

async function makeUser(label, role, salespersons = []) {
  const email = `ss-${label}-${stamp}@getmeds.ph`;
  await db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(`SS ${label} ${stamp}`, email, passwordHash, role);
  const u = await db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  createdUsers.push(u.id);
  for (let i = 0; i < salespersons.length; i += 1) {
    await db.prepare('INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, ?, ?)').run(u.id, salespersons[i], i === 0 ? 1 : 0);
  }
  return u;
}

const allTerritories = (tree) => tree.heads.flatMap((h) => h.channels.flatMap((c) => c.managers.flatMap((m) => m.territories)));
const managerNamed = (tree, channel, name) =>
  tree.heads.flatMap((h) => h.channels).find((c) => c.name === channel).managers.find((m) => m.name === name);
const terr = (tree, z) => allTerritories(tree).find((t) => t.zoho_salesperson === z);

describe('sales team structure', () => {
  beforeAll(async () => {
    adminToken = await loginAs('admin@getmeds.ph');
    medrepToken = await loginAs('medrep@getmeds.ph');
    passwordHash = (await db.prepare('SELECT password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph')).password_hash;
    await db.prepare('DELETE FROM sales_channel_approvers').run();
    await db.prepare('DELETE FROM sales_territories').run();
    await db.prepare('DELETE FROM sales_managers').run();
    await db.prepare('DELETE FROM sales_channels').run();
    // Created BEFORE the sheet is loaded, so Veronica's approver lines link to her.
    veronica = await makeUser('veronica', 'management');
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(`Veronica Test ${stamp}`, veronica.id);
  });

  afterAll(async () => {
    await db.prepare('DELETE FROM sales_channel_approvers').run();
    await db.prepare('DELETE FROM sales_territories').run();
    await db.prepare('DELETE FROM sales_managers').run();
    await db.prepare('DELETE FROM sales_channels').run();
    for (const id of createdUsers) {
      await db.prepare('UPDATE users SET team_lead_id = NULL WHERE team_lead_id = ?').run(id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
  });

  test('admin only', async () => {
    expect((await get('', medrepToken)).status).toBe(403);
    expect((await post('/import', {}, medrepToken)).status).toBe(403);
    expect((await get('/team-lead-plan', medrepToken)).status).toBe(403);
    expect((await post('/team-lead-plan/apply', { account_ids: [1] }, medrepToken)).status).toBe(403);
  });

  describe('loading the sheet', () => {
    test('loads everything, and a second load creates nothing', async () => {
      const first = await post('/import', {});
      expect(first.status).toBe(200);
      expect(first.body.data.territories.created).toBe(65);
      expect(first.body.data.channels.created).toBe(10);
      expect(first.body.data.managers.created).toBe(15);

      const second = await post('/import', {});
      expect(second.body.data.territories.created).toBe(0);
      expect(second.body.data.channels.created).toBe(0);
      expect(second.body.data.managers.created).toBe(0);
    });

    test('the tree has the four heads and the sheet\'s totals', async () => {
      const res = await get('');
      expect(res.status).toBe(200);
      const tree = res.body.data;
      expect(tree.heads.map((h) => h.name)).toEqual(['Javed', 'Subir', 'Vanessa', 'Mhalou']);
      expect(tree.summary.territories).toBe(65);

      const sheet = SEED.channels.flatMap((c) => c.managers.flatMap((m) => m.territories));
      expect(tree.summary.total_target).toBe(sheet.reduce((s, t) => s + t.target, 0));
      expect(tree.summary.total_achieved).toBe(sheet.reduce((s, t) => s + t.achieved, 0));

      // Honey is one person but leads four channels, so four manager rows.
      const honey = tree.heads[0].channels.map((c) => c.managers.find((m) => m.name === 'Honey')).filter(Boolean);
      expect(honey).toHaveLength(4);
      // Heads who also lead their channel are marked.
      expect(managerNamed(tree, 'CLIDP', 'Subir').acts_as_head).toBe(true);
      expect(managerNamed(tree, 'B2B', 'Jessa Domino').acts_as_head).toBe(false);
    });

    test('scope notes: Jessa sees only B2B, Jimmy leads BID, the HOS team leads see only their own team', async () => {
      const tree = (await get('')).body.data;
      expect(managerNamed(tree, 'B2B', 'Jessa Domino').scope_note).toBe('Sees only B2B accounts');
      const jimmy = managerNamed(tree, 'BID', 'Jimmy');
      expect(jimmy.scope_note).toBe('Sees only BID accounts');
      expect(jimmy.territories).toHaveLength(3);
      // Subir is BID's head but no longer holds its territories directly.
      expect(tree.heads.flatMap((h) => h.channels).find((c) => c.name === 'BID').managers.map((m) => m.name)).toEqual(['Jimmy']);
      for (const n of ['Jimlord', 'Daniel', 'Saurav', 'Julius', 'Ken']) {
        expect(managerNamed(tree, 'HOSP', n).scope_note).toMatch(/only their own team/);
      }
      expect(managerNamed(tree, 'RX · B&B', 'Honey').scope_note).toBeNull();
    });

    test('approvers: Veronica on every group, Faith only on B2B and CLIDP, none on MT', async () => {
      const tree = (await get('')).body.data;
      const chans = tree.heads.flatMap((h) => h.channels);
      const who = (name) => chans.find((c) => c.name === name).approvers.map((a) => a.name);
      for (const n of ['RX · B&B', 'RX · STC', 'RX · URO', 'RX · B2C', 'BID', 'HOSP', 'TELESALES']) expect(who(n)).toEqual(['Veronica']);
      expect(who('B2B')).toEqual(['Veronica', 'Faith']);
      expect(who('CLIDP')).toEqual(['Veronica', 'Faith']);
      expect(who('MT')).toEqual([]);
      // Veronica has a Management account (created for this test), so she is linked.
      expect(chans.find((c) => c.name === 'BID').approvers[0].user.id).toBe(veronica.id);
      // Faith has no account here, so she is named but not linked.
      expect(chans.find((c) => c.name === 'B2B').approvers[1].user).toBeNull();
    });

    test('approvers can be added and removed; a duplicate or an unknown channel is refused', async () => {
      const tree = (await get('')).body.data;
      const mt = tree.heads.flatMap((h) => h.channels).find((c) => c.name === 'MT');
      const made = await post('/approvers', { channel_id: mt.id, name: `Approver ${stamp}` });
      expect(made.status).toBe(201);
      expect((await post('/approvers', { channel_id: mt.id, name: `approver ${stamp}` })).status).toBe(409);
      expect((await post('/approvers', { channel_id: 99999999, name: 'X' })).status).toBe(400);
      expect((await post('/approvers', { channel_id: mt.id })).status).toBe(400);
      expect((await del(`/approvers/${made.body.data.id}`)).status).toBe(200);
      expect((await del(`/approvers/${made.body.data.id}`)).status).toBe(404);
    });

    test('the sheet\'s renames are kept, with the old Zoho name as an alias', async () => {
      const tree = (await get('')).body.data;
      expect(terr(tree, 'HOS | GENSAN').zoho_alias).toBe('HOSP | GENSAN');
      expect(terr(tree, 'MT | 1').zoho_alias).toBe('MT - 1');
      expect(terr(tree, 'MT | 2').zoho_alias).toBe('MT - 2');
    });

    test('with nobody holding anything, every territory is vacant or has no account', async () => {
      const s = (await get('')).body.data.summary;
      expect(s.covered).toBe(0);
      expect(s.vacant + s.no_account).toBe(65);
    });

    test('loading again never undoes an admin\'s edit; overwrite does refresh from the sheet', async () => {
      const t = terr((await get('')).body.data, 'STC | CEBU');
      expect((await patch(`/territories/${t.id}`, { person_label: 'STC | EDITED BY ADMIN', target_amount: 123 })).status).toBe(200);

      await post('/import', {});
      expect(terr((await get('')).body.data, 'STC | CEBU').person_label).toBe('STC | EDITED BY ADMIN');

      await post('/import', { overwrite: true });
      const after = terr((await get('')).body.data, 'STC | CEBU');
      expect(after.person_label).toBe('STC | ANTONEETE');
      expect(after.target_amount).toBe(500000);
    });
  });

  describe('matching territories to accounts', () => {
    let byName, byAlias, outside, gone;

    beforeAll(async () => {
      byName = await makeUser('byname', 'medrep', ['STC | NCL']);
      byAlias = await makeUser('byalias', 'medrep', ['HOSP | GENSAN']);
      outside = await makeUser('outside', 'medrep', [`Nowhere | ${stamp}`]);
      gone = await makeUser('gone', 'medrep', ['B&B | TAFT']);
      await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(gone.id);
    });

    test('an account covers the territory it holds, by name or by the old name', async () => {
      const tree = (await get('')).body.data;
      const ncl = terr(tree, 'STC | NCL');
      expect(ncl.status).toBe('covered');
      expect(ncl.accounts.map((a) => a.id)).toContain(byName.id);

      const gensan = terr(tree, 'HOS | GENSAN');
      expect(gensan.status).toBe('covered');
      expect(gensan.accounts.map((a) => a.id)).toContain(byAlias.id);
    });

    test('a deactivated account does not cover its territory', async () => {
      const taft = terr((await get('')).body.data, 'B&B | TAFT');
      expect(taft.accounts.map((a) => a.id)).not.toContain(gone.id);
    });

    test('an account holding a salesperson the structure does not name is listed as outside it', async () => {
      const issues = (await get('')).body.data.issues;
      const o = issues.accounts_outside_structure.find((a) => a.id === outside.id);
      expect(o).toBeTruthy();
      expect(o.salespersons).toEqual([`Nowhere | ${stamp}`]);
      // An account that DOES hold a territory is not outside.
      expect(issues.accounts_outside_structure.map((a) => a.id)).not.toContain(byName.id);
    });

    test('a territory the sheet says is held, with no account behind it, is called out', async () => {
      const issues = (await get('')).body.data.issues;
      expect(issues.territories_without_account.map((t) => t.zoho_salesperson)).toContain('B2B | DHON');
      // ...but a vacant one is not "missing an account": vacant is the point.
      expect(issues.territories_without_account.map((t) => t.zoho_salesperson)).not.toContain('URO | NCL');
    });
  });

  describe('Team Lead preview and apply', () => {
    let lead, rep, repB2b, repTwo, repMgmt;
    let honeyBb, jessa, daniel, saurav;

    beforeAll(async () => {
      lead = await makeUser('lead', 'team_lead');
      rep = await makeUser('rep', 'medrep', ['B&B | EAST AVE']);          // Honey (B&B)
      repB2b = await makeUser('repb2b', 'medrep', ['B2B | DHON']);         // Jessa Domino
      repTwo = await makeUser('reptwo', 'medrep', ['HOS | PASAY', 'HOS | CDO']); // Daniel AND Saurav

      const tree = (await get('')).body.data;
      honeyBb = managerNamed(tree, 'RX · B&B', 'Honey');
      jessa = managerNamed(tree, 'B2B', 'Jessa Domino');
      daniel = managerNamed(tree, 'HOSP', 'Daniel');
      saurav = managerNamed(tree, 'HOSP', 'Saurav');
      expect((await patch(`/managers/${honeyBb.id}`, { user_id: lead.id })).status).toBe(200);

      // Jessa is linked to a Management-role account: it cannot be anyone's Team Lead.
      const mgmt = await db.prepare("SELECT id FROM users WHERE role = 'management' LIMIT 1").get();
      repMgmt = mgmt;
      expect((await patch(`/managers/${jessa.id}`, { user_id: mgmt.id })).status).toBe(200);
    });

    test('the preview says what would change, and why each other row cannot', async () => {
      const res = await get('/team-lead-plan');
      expect(res.status).toBe(200);
      const items = Object.fromEntries(res.body.data.items.map((i) => [i.account_id, i]));

      expect(items[rep.id].status).toBe('change');
      expect(items[rep.id].proposed_team_lead_id).toBe(lead.id);
      expect(items[rep.id].current_team_lead_id).toBeNull();

      expect(items[repB2b.id]).toMatchObject({ status: 'blocked', reason: 'manager_not_team_lead' });
      expect(items[repTwo.id]).toMatchObject({ status: 'blocked', reason: 'multiple_managers' });
      expect(res.body.data.counts.change).toBeGreaterThanOrEqual(1);
    });

    test('a manager with no account at all is blocked too', async () => {
      await patch(`/managers/${jessa.id}`, { user_id: null });
      const items = Object.fromEntries((await get('/team-lead-plan')).body.data.items.map((i) => [i.account_id, i]));
      expect(items[repB2b.id]).toMatchObject({ status: 'blocked', reason: 'manager_has_no_account' });
    });

    test('the preview changes nothing', async () => {
      await get('/team-lead-plan');
      expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(rep.id)).team_lead_id).toBeNull();
    });

    test('apply needs an explicit list: nothing, a non-list and an "all" are refused', async () => {
      for (const body of [{}, { account_ids: [] }, { account_ids: 'all' }, { account_ids: ['x'] }, { all: true }]) {
        const res = await post('/team-lead-plan/apply', body);
        expect(res.status).toBe(400);
      }
      expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(rep.id)).team_lead_id).toBeNull();
    });

    test('apply changes exactly the accounts named, and skips blocked ones with the reason', async () => {
      const before = await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(repB2b.id);

      const res = await post('/team-lead-plan/apply', { account_ids: [rep.id, repB2b.id, repTwo.id, 99999999] });
      expect(res.status).toBe(200);
      expect(res.body.data.applied).toEqual([{ account_id: rep.id, from: null, to: lead.id }]);
      const reasons = Object.fromEntries(res.body.data.skipped.map((s) => [s.account_id, s.reason]));
      expect(reasons[repB2b.id]).toBe('manager_has_no_account');
      expect(reasons[repTwo.id]).toBe('multiple_managers');
      expect(reasons[99999999]).toBe('not_in_structure');

      expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(rep.id)).team_lead_id).toBe(lead.id);
      expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(repB2b.id)).team_lead_id).toBe(before.team_lead_id);
    });

    test('an account that is correct is reported as such, and the tree shows the match', async () => {
      const items = Object.fromEntries((await get('/team-lead-plan')).body.data.items.map((i) => [i.account_id, i]));
      expect(items[rep.id].status).toBe('already_correct');

      const tree = (await get('')).body.data;
      const acc = terr(tree, 'B&B | EAST AVE').accounts.find((a) => a.id === rep.id);
      expect(acc.team_lead_matches).toBe(true);
    });

    test('an account NOT named in an apply is never touched', async () => {
      const other = await makeUser('rep2', 'medrep', ['B&B | TAFT']); // Honey (B&B), would change
      const res = await post('/team-lead-plan/apply', { account_ids: [rep.id] });
      expect(res.status).toBe(200);
      expect((await db.prepare('SELECT team_lead_id FROM users WHERE id = ?').get(other.id)).team_lead_id).toBeNull();
    });
  });

  describe('editing', () => {
    test('add, rename and remove a territory; duplicates and bad numbers are refused', async () => {
      const tree = (await get('')).body.data;
      const mgr = managerNamed(tree, 'CLIDP', 'Subir');

      const made = await post('/territories', { manager_id: mgr.id, zoho_salesperson: `BID | NEW ${stamp}`, target_amount: 1000, is_vacant: true });
      expect(made.status).toBe(201);
      const id = made.body.data.id;

      expect((await post('/territories', { manager_id: mgr.id, zoho_salesperson: `bid | new ${stamp}` })).status).toBe(409);
      expect((await patch(`/territories/${id}`, { target_amount: -5 })).status).toBe(400);
      expect((await patch(`/territories/${id}`, { manager_id: 99999999 })).status).toBe(400);
      expect((await patch(`/territories/${id}`, { hq: 'CEBU' })).status).toBe(200);
      expect(terr((await get('')).body.data, `BID | NEW ${stamp}`).hq).toBe('CEBU');

      expect((await del(`/territories/${id}`)).status).toBe(200);
      expect(terr((await get('')).body.data, `BID | NEW ${stamp}`)).toBeUndefined();
      expect((await del(`/territories/${id}`)).status).toBe(404);
    });

    test('a manager with territories cannot be deleted; an empty one can; user_id must be active', async () => {
      const tree = (await get('')).body.data;
      const ch = tree.heads[0].channels[0];
      const busy = managerNamed(tree, ch.name, 'Honey');
      expect((await del(`/managers/${busy.id}`)).status).toBe(409);

      const m = await post('/managers', { channel_id: ch.id, name: `Temp ${stamp}` });
      expect(m.status).toBe(201);
      expect((await post('/managers', { channel_id: ch.id, name: `temp ${stamp}` })).status).toBe(409);
      expect((await patch(`/managers/${m.body.data.id}`, { user_id: 99999999 })).status).toBe(400);
      expect((await del(`/managers/${m.body.data.id}`)).status).toBe(200);
    });

    test('channels: add, rename, and no duplicate names', async () => {
      const c = await post('/channels', { name: `Test Channel ${stamp}`, head_name: 'Somebody' });
      expect(c.status).toBe(201);
      expect((await post('/channels', { name: `test channel ${stamp}`, head_name: 'X' })).status).toBe(409);
      expect((await patch(`/channels/${c.body.data.id}`, { name: `Renamed ${stamp}` })).status).toBe(200);
      expect((await post('/channels', { name: 'No head' })).status).toBe(400);
    });
  });
});
