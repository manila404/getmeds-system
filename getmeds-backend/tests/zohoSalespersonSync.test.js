/**
 * Sep 11, 2026 — the live copy of Zoho's Salesperson list, and a Sales Order's
 * Salesperson tracked when it is changed in Zoho.
 *
 * The case that started this: "HOS | Aaron Manila" was renamed "B2B | Aaron"
 * in Zoho, and every stored copy of the old name silently stopped resolving.
 * Zoho keys Salespersons by id, so the copy does too, and a rename is carried
 * to the accounts holding the old name.
 *
 * Every sync here passes the mock org's own list as well, so the mock's real
 * Salespersons are never seen as "removed".
 */
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const sync = require('../src/services/zohoSalespersonSync');
const { diffSalesOrderFields } = require('../src/services/zohoEditDiffService');

const PREFIX = 'spsync-test-';
let base;

const sp = (id, name, is_active = true) => ({ salesperson_id: id, salesperson_name: name, is_active });
const listWith = (...extra) => [...base, ...extra];
const row = (id) => db.prepare('SELECT * FROM zoho_salespersons WHERE zoho_salesperson_id = ?').get(id);
const changesFor = async (id) =>
  (await db.prepare('SELECT change, old_value, new_value FROM zoho_salesperson_changes WHERE zoho_salesperson_id = ? ORDER BY id').all(id))
    .map((c) => c.change);

beforeAll(async () => {
  base = (await zoho.listSalespersons()).salespersons || [];
  await sync.syncFromList(listWith());
});

afterAll(async () => {
  await db.prepare("DELETE FROM zoho_salesperson_changes WHERE zoho_salesperson_id LIKE 'SPSYNC-%'").run();
  await db.prepare("DELETE FROM zoho_salespersons WHERE zoho_salesperson_id LIKE 'SPSYNC-%'").run();
  await db.prepare('DELETE FROM users WHERE email LIKE ?').run(`${PREFIX}%`);
});

describe('the live copy of Zoho’s Salesperson list', () => {
  test('a Salesperson new in Zoho is added and recorded', async () => {
    const summary = await sync.syncFromList(listWith(sp('SPSYNC-1', 'SPSYNC | One')));
    expect(summary.added).toBe(1);
    expect((await row('SPSYNC-1')).name).toBe('SPSYNC | One');
    expect(await changesFor('SPSYNC-1')).toEqual(['added']);
  });

  test('a rename is carried to every account holding the old name', async () => {
    await sync.syncFromList(listWith(sp('SPSYNC-2', 'SPSYNC | Two')));

    const email = `${PREFIX}rename-${Date.now()}@getmeds.ph`;
    await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Rename Target', ?, 'x', 'medrep')").run(email);
    const { id } = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    await db.prepare("INSERT INTO user_salespersons (user_id, salesperson, is_primary) VALUES (?, 'SPSYNC | Two', 1)").run(id);

    // Same id, new name: Zoho renamed it.
    const summary = await sync.syncFromList(listWith(sp('SPSYNC-2', 'SPSYNC | Deux')));
    expect(summary.renamed).toBe(1);
    expect(summary.propagated).toBeGreaterThanOrEqual(1);

    const held = await db.prepare('SELECT salesperson FROM user_salespersons WHERE user_id = ?').all(id);
    expect(held.map((h) => h.salesperson)).toEqual(['SPSYNC | Deux']);
    // users.salesperson follows its primary through the trigger.
    expect((await db.prepare('SELECT salesperson FROM users WHERE id = ?').get(id)).salesperson).toBe('SPSYNC | Deux');
    expect(await changesFor('SPSYNC-2')).toContain('renamed');
  });

  test('leaving Zoho’s list is recorded, and so is coming back', async () => {
    await sync.syncFromList(listWith(sp('SPSYNC-3', 'SPSYNC | Three')));

    await sync.syncFromList(listWith());
    expect((await row('SPSYNC-3')).removed_at).toBeTruthy();

    await sync.syncFromList(listWith(sp('SPSYNC-3', 'SPSYNC | Three')));
    expect((await row('SPSYNC-3')).removed_at).toBeNull();
    expect(await changesFor('SPSYNC-3')).toEqual(expect.arrayContaining(['added', 'removed', 'restored']));
  });

  test('being marked inactive in Zoho is recorded', async () => {
    await sync.syncFromList(listWith(sp('SPSYNC-4', 'SPSYNC | Four')));
    const summary = await sync.syncFromList(listWith(sp('SPSYNC-4', 'SPSYNC | Four', false)));
    expect(summary.deactivated).toBe(1);
    expect(Number((await row('SPSYNC-4')).is_active)).toBe(0);
  });

  test('an empty answer from Zoho is never read as "everybody left"', async () => {
    await sync.syncFromList(listWith(sp('SPSYNC-5', 'SPSYNC | Five')));
    const summary = await sync.syncFromList([]);
    expect(summary.skipped).toBe(true);
    expect((await row('SPSYNC-5')).removed_at).toBeNull();
  });

  test('status reports when it last synced and what changed', async () => {
    const s = await sync.status();
    expect(s.synced_at).toBeTruthy();
    expect(s.count).toBeGreaterThan(0);
    expect(s.changes.length).toBeGreaterThan(0);
  });
});

describe('a Sales Order’s Salesperson, changed in Zoho', () => {
  test('is an edit when it replaces the one stored here', () => {
    const changes = diffSalesOrderFields({ salesperson_name: 'B2B | Aaron' }, { salesperson: 'HOS | Aaron Manila' });
    expect(changes).toContainEqual(
      expect.objectContaining({ key: 'salesperson', oldValue: 'HOS | Aaron Manila', newValue: 'B2B | Aaron', baseline: false })
    );
  });

  test('is a baseline, not an edit, when nothing was stored here', () => {
    const [change] = diffSalesOrderFields({ salesperson_name: 'B2B | Aaron' }, { salesperson: null })
      .filter((c) => c.key === 'salesperson');
    expect(change.baseline).toBe(true);
  });

  test('Zoho sending none never blanks the one stored here', () => {
    const changes = diffSalesOrderFields({}, { salesperson: 'B2B | Aaron' });
    expect(changes.find((c) => c.key === 'salesperson')).toBeUndefined();
  });
});
