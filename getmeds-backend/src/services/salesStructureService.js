'use strict';

/**
 * The sales team structure: Head -> Channel -> Manager -> Territory.
 *
 * Sep 26, 2026. From the SEP TARGET SHEET (src/seeds/salesStructure.json).
 *
 * ── What this is, and is not ───────────────────────────────────────────────
 * Descriptive. Nothing in the order flow reads these tables, so they change no
 * behaviour on their own. They answer, for the admin: who leads what, which
 * territories are vacant, which accounts sit outside the structure, and where an
 * account's Team Lead disagrees with the sheet.
 *
 * ── How a territory finds its accounts ─────────────────────────────────────
 * By Zoho salesperson name, the string user_salespersons already holds. A
 * territory matches on its own name or on `zoho_alias` (what Zoho still calls it
 * when the sheet has renamed it), case-insensitively. Only ACTIVE accounts count.
 *
 * ── Team Leads: preview and apply are separate, and apply is explicit ──────
 * planTeamLeads() only READS and says what would change and what cannot.
 * applyTeamLeads() changes exactly the accounts it is handed, and only those the
 * plan marks 'change'. There is no "apply everything". Reason: an account's Team
 * Lead decides what that Team Lead sees (services/teamScopeService.js), so
 * setting it on live accounts is a change to what real people can see.
 *
 * What blocks a row, and why:
 *   manager_has_no_account   the sheet's manager has no linked account
 *   manager_not_team_lead    the linked account is not a Team Lead-role account
 *                            (the order app only accepts a Team Lead-role account
 *                            as someone's Team Lead; a Management user cannot be)
 *   multiple_managers        the account holds territories under different managers
 */

const db = require('../db/database');
const SEED = require('../seeds/salesStructure.json');

const lower = (s) => String(s || '').trim().toLowerCase();
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// ─── Seed ────────────────────────────────────────────────────────────────────

/**
 * The one active Team Lead / Management account a manager's name points at:
 * their full name, or (for a single-word name like "Honey") the first word of it.
 * Ambiguous or missing means no link: guessing here would put the wrong person's
 * name against a team.
 */
function findManagerAccount(name, candidates) {
  const m = lower(name);
  const exact = candidates.filter((u) => lower(u.name) === m);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  if (m.includes(' ')) return null;
  const first = candidates.filter((u) => lower(u.name).split(/\s+/)[0] === m);
  return first.length === 1 ? first[0].id : null;
}

/**
 * Loads the bundled sheet. Inserts what is missing and leaves everything else
 * alone, so re-running it never undoes an admin's edit. `overwrite` refreshes the
 * fields that came from the sheet (names, HQ, targets, vacancy) and nothing the
 * admin links by hand (a manager's account is kept if already set).
 */
async function importSeed({ overwrite = false, actorId = null } = {}) {
  const stats = {
    channels: { created: 0, updated: 0 }, managers: { created: 0, updated: 0, linked: 0 },
    territories: { created: 0, updated: 0 }, approvers: { created: 0, linked: 0 },
  };
  const accounts = await db
    .prepare("SELECT id, name FROM users WHERE is_active = 1 AND role IN ('team_lead','management')")
    .all();

  let chOrder = 0;
  for (const c of SEED.channels) {
    chOrder += 1;
    let ch = await db.prepare('SELECT * FROM sales_channels WHERE LOWER(name) = ?').get(lower(c.name));
    if (!ch) {
      const r = await db
        .prepare('INSERT INTO sales_channels (name, head_name, head_user_id, sort_order, updated_by) VALUES (?, ?, ?, ?, ?)')
        .run(c.name, c.head, findManagerAccount(c.head, accounts), chOrder, actorId);
      ch = { id: r.lastInsertRowid };
      stats.channels.created += 1;
    } else if (overwrite) {
      await db.prepare('UPDATE sales_channels SET head_name = ?, sort_order = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(c.head, chOrder, new Date().toISOString(), actorId, ch.id);
      stats.channels.updated += 1;
    }

    // Who approves this channel's orders. Inserted when missing; never removed here.
    let aOrder = 0;
    for (const name of c.approvers || []) {
      aOrder += 1;
      const has = await db.prepare('SELECT id FROM sales_channel_approvers WHERE channel_id = ? AND LOWER(name) = ?').get(ch.id, lower(name));
      if (has) continue;
      const userId = findManagerAccount(name, accounts);
      await db.prepare('INSERT INTO sales_channel_approvers (channel_id, name, user_id, sort_order, updated_by) VALUES (?, ?, ?, ?, ?)')
        .run(ch.id, name, userId, aOrder, actorId);
      stats.approvers.created += 1;
      if (userId) stats.approvers.linked += 1;
    }

    let mOrder = 0;
    for (const m of c.managers) {
      mOrder += 1;
      let mg = await db.prepare('SELECT * FROM sales_managers WHERE channel_id = ? AND LOWER(name) = ?').get(ch.id, lower(m.name));
      if (!mg) {
        const userId = findManagerAccount(m.name, accounts);
        const r = await db
          .prepare('INSERT INTO sales_managers (channel_id, name, user_id, acts_as_head, scope_note, sort_order, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(ch.id, m.name, userId, Boolean(m.acts_as_head), m.scope_note || null, mOrder, actorId);
        mg = { id: r.lastInsertRowid };
        stats.managers.created += 1;
        if (userId) stats.managers.linked += 1;
      } else if (overwrite) {
        await db.prepare('UPDATE sales_managers SET acts_as_head = ?, scope_note = ?, sort_order = ?, updated_at = ?, updated_by = ? WHERE id = ?')
          .run(Boolean(m.acts_as_head), m.scope_note || null, mOrder, new Date().toISOString(), actorId, mg.id);
        stats.managers.updated += 1;
      }

      let tOrder = 0;
      for (const t of m.territories) {
        tOrder += 1;
        const ex = await db.prepare('SELECT id FROM sales_territories WHERE LOWER(zoho_salesperson) = ?').get(lower(t.zoho_salesperson));
        if (!ex) {
          await db
            .prepare(
              `INSERT INTO sales_territories
                 (manager_id, zoho_salesperson, zoho_alias, person_label, hq, is_vacant, target_month, target_amount, achieved_amount, sort_order, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(mg.id, t.zoho_salesperson, t.alias || null, t.person, t.hq, Boolean(t.vacant), SEED.month, t.target, t.achieved, tOrder, actorId);
          stats.territories.created += 1;
        } else if (overwrite) {
          await db
            .prepare(
              `UPDATE sales_territories SET manager_id = ?, zoho_alias = ?, person_label = ?, hq = ?, is_vacant = ?,
                      target_month = ?, target_amount = ?, achieved_amount = ?, sort_order = ?, updated_at = ?, updated_by = ?
                WHERE id = ?`
            )
            .run(mg.id, t.alias || null, t.person, t.hq, Boolean(t.vacant), SEED.month, t.target, t.achieved, tOrder,
              new Date().toISOString(), actorId, ex.id);
          stats.territories.updated += 1;
        }
      }
    }
  }
  return stats;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Active accounts by the (lower-cased) Zoho salesperson they hold. */
async function accountsBySalesperson() {
  const rows = await db
    .prepare(
      `SELECT us.salesperson, u.id, u.name, u.role, u.division, u.team_lead_id, tl.name AS team_lead_name
         FROM user_salespersons us
         JOIN users u ON u.id = us.user_id
         LEFT JOIN users tl ON tl.id = u.team_lead_id
        WHERE u.is_active = 1`
    )
    .all();
  const map = new Map();
  for (const r of rows) {
    const k = lower(r.salesperson);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return { map, rows };
}

async function loadAll() {
  const [channels, managers, territories, approvers] = await Promise.all([
    db.prepare('SELECT * FROM sales_channels ORDER BY sort_order, id').all(),
    db
      .prepare(
        `SELECT m.*, u.name AS user_name, u.role AS user_role, u.is_active AS user_active
           FROM sales_managers m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.sort_order, m.id`
      )
      .all(),
    db.prepare('SELECT * FROM sales_territories ORDER BY sort_order, id').all(),
    db.prepare('SELECT * FROM sales_channel_approvers ORDER BY sort_order, id').all(),
  ]);
  return { channels, managers, territories, approvers };
}

/** id -> { id, name, role, active } for every account the structure links to. */
async function linkedUsers(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await db.prepare('SELECT id, name, role, is_active FROM users WHERE id = ANY(?)').all([list]);
  return new Map(rows.map((u) => [u.id, { id: u.id, name: u.name, role: u.role, active: u.is_active === 1 || u.is_active === true }]));
}

/** The territory's accounts, from its own name and its alias, without duplicates. */
function accountsFor(territory, map) {
  const seen = new Set();
  const out = [];
  for (const name of [territory.zoho_salesperson, territory.zoho_alias]) {
    for (const a of map.get(lower(name)) || []) {
      if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
    }
  }
  return out;
}

async function getStructure() {
  const { channels, managers, territories, approvers } = await loadAll();
  const { map, rows: heldRows } = await accountsBySalesperson();
  const users = await linkedUsers([...channels.map((c) => c.head_user_id), ...approvers.map((a) => a.user_id)]);

  const allNames = new Set();
  for (const t of territories) { allNames.add(lower(t.zoho_salesperson)); if (t.zoho_alias) allNames.add(lower(t.zoho_alias)); }

  const mgrById = new Map(managers.map((m) => [m.id, m]));
  const terrByMgr = new Map();
  const summary = {
    territories: territories.length, covered: 0, vacant: 0, no_account: 0, sheet_vacant_but_covered: 0,
    total_target: 0, total_achieved: 0, vacant_target: 0,
  };
  const noAccount = [];
  for (const t of territories) {
    const accounts = accountsFor(t, map);
    const status = accounts.length ? 'covered' : t.is_vacant ? 'vacant' : 'no_account';
    summary.total_target += t.target_amount || 0;
    summary.total_achieved += t.achieved_amount || 0;
    if (status === 'covered') summary.covered += 1;
    else if (status === 'vacant') { summary.vacant += 1; summary.vacant_target += t.target_amount || 0; }
    else { summary.no_account += 1; noAccount.push({ id: t.id, zoho_salesperson: t.zoho_salesperson, person_label: t.person_label }); }
    const sheetVacantButCovered = Boolean(t.is_vacant && accounts.length);
    if (sheetVacantButCovered) summary.sheet_vacant_but_covered += 1;

    const m = mgrById.get(t.manager_id);
    const terr = {
      id: t.id, zoho_salesperson: t.zoho_salesperson, zoho_alias: t.zoho_alias, person_label: t.person_label, hq: t.hq,
      is_vacant: Boolean(t.is_vacant), status, sheet_vacant_but_covered: sheetVacantButCovered,
      target_month: t.target_month, target_amount: t.target_amount, achieved_amount: t.achieved_amount,
      accounts: accounts.map((a) => ({
        id: a.id, name: a.name, role: a.role, team_lead_id: a.team_lead_id, team_lead_name: a.team_lead_name,
        // Only meaningful for a MedRep, and only when the manager has a linked account.
        team_lead_matches: m && m.user_id && a.role === 'medrep' ? a.team_lead_id === m.user_id : null,
      })),
    };
    if (!terrByMgr.has(t.manager_id)) terrByMgr.set(t.manager_id, []);
    terrByMgr.get(t.manager_id).push(terr);
  }

  const mgrsByChannel = new Map();
  for (const m of managers) {
    if (!mgrsByChannel.has(m.channel_id)) mgrsByChannel.set(m.channel_id, []);
    const terrs = terrByMgr.get(m.id) || [];
    mgrsByChannel.get(m.channel_id).push({
      id: m.id, name: m.name, acts_as_head: Boolean(m.acts_as_head), scope_note: m.scope_note || null,
      user: m.user_id ? { id: m.user_id, name: m.user_name, role: m.user_role, active: m.user_active === 1 || m.user_active === true } : null,
      territories: terrs,
      counts: {
        territories: terrs.length,
        covered: terrs.filter((x) => x.status === 'covered').length,
        vacant: terrs.filter((x) => x.status === 'vacant').length,
        no_account: terrs.filter((x) => x.status === 'no_account').length,
        target: terrs.reduce((s, x) => s + (x.target_amount || 0), 0),
      },
    });
  }

  const heads = [];
  for (const c of channels) {
    let h = heads.find((x) => lower(x.name) === lower(c.head_name));
    if (!h) { h = { name: c.head_name, head_user_id: c.head_user_id, user: users.get(c.head_user_id) || null, channels: [] }; heads.push(h); }
    const ms = mgrsByChannel.get(c.id) || [];
    h.channels.push({
      id: c.id, name: c.name, head_name: c.head_name, managers: ms,
      approvers: approvers.filter((a) => a.channel_id === c.id).map((a) => ({ id: a.id, name: a.name, user: users.get(a.user_id) || null })),
      counts: {
        territories: ms.reduce((s, m) => s + m.counts.territories, 0),
        vacant: ms.reduce((s, m) => s + m.counts.vacant, 0),
        target: ms.reduce((s, m) => s + m.counts.target, 0),
      },
    });
  }

  // Active MedReps / Team Leads holding a salesperson that no territory names.
  const outside = new Map();
  for (const r of heldRows) {
    if (!['medrep', 'team_lead'].includes(r.role)) continue;
    if (allNames.has(lower(r.salesperson))) continue;
    if (!outside.has(r.id)) outside.set(r.id, { id: r.id, name: r.name, role: r.role, division: r.division, salespersons: [] });
    outside.get(r.id).salespersons.push(r.salesperson);
  }
  const withoutSp = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
        WHERE u.is_active = 1 AND u.role = 'medrep'
          AND NOT EXISTS (SELECT 1 FROM user_salespersons us WHERE us.user_id = u.id)`
    )
    .get();

  return {
    heads,
    summary,
    issues: {
      territories_without_account: noAccount,
      accounts_outside_structure: [...outside.values()].sort((a, b) => a.name.localeCompare(b.name)),
      medreps_without_salesperson: Number(withoutSp.n),
    },
  };
}

// ─── Team Lead preview and apply ─────────────────────────────────────────────

async function planTeamLeads() {
  const { managers, territories } = await loadAll();
  const { map } = await accountsBySalesperson();
  const mgrById = new Map(managers.map((m) => [m.id, m]));

  // account -> the managers whose territories it holds
  const byAccount = new Map();
  for (const t of territories) {
    const m = mgrById.get(t.manager_id);
    for (const a of accountsFor(t, map)) {
      if (a.role !== 'medrep') continue;
      if (!byAccount.has(a.id)) byAccount.set(a.id, { account: a, managers: new Map(), territories: [] });
      const e = byAccount.get(a.id);
      e.managers.set(m.user_id ? `u${m.user_id}` : `n${lower(m.name)}`, m);
      e.territories.push(t.zoho_salesperson);
    }
  }

  const tlUsers = new Map();
  const tlIds = [...new Set(managers.map((m) => m.user_id).filter(Boolean))];
  if (tlIds.length) {
    const rows = await db.prepare('SELECT id, name, role, is_active FROM users WHERE id = ANY(?)').all([tlIds]);
    rows.forEach((u) => tlUsers.set(u.id, u));
  }

  const items = [];
  for (const { account: a, managers: ms, territories: ts } of byAccount.values()) {
    const base = {
      account_id: a.id, account_name: a.name, territories: ts,
      current_team_lead_id: a.team_lead_id || null, current_team_lead_name: a.team_lead_name || null,
      proposed_team_lead_id: null, proposed_team_lead_name: null,
    };
    if (ms.size > 1) { items.push({ ...base, status: 'blocked', reason: 'multiple_managers' }); continue; }
    const m = [...ms.values()][0];
    if (!m.user_id) { items.push({ ...base, status: 'blocked', reason: 'manager_has_no_account', manager: m.name }); continue; }
    const u = tlUsers.get(m.user_id);
    if (!u || !(u.is_active === 1 || u.is_active === true) || u.role !== 'team_lead') {
      items.push({ ...base, status: 'blocked', reason: 'manager_not_team_lead', manager: m.name, manager_role: u ? u.role : null });
      continue;
    }
    const proposed = { proposed_team_lead_id: u.id, proposed_team_lead_name: u.name, manager: m.name };
    items.push({ ...base, ...proposed, status: base.current_team_lead_id === u.id ? 'already_correct' : 'change' });
  }
  items.sort((a, b) => a.account_name.localeCompare(b.account_name));

  const counts = { change: 0, already_correct: 0, blocked: 0 };
  items.forEach((i) => { counts[i.status] += 1; });
  return { items, counts };
}

/**
 * Sets the Team Lead on exactly the accounts named, and only those the plan marks
 * 'change'. Anything else is reported as skipped with its reason.
 */
async function applyTeamLeads(accountIds, actorId) {
  const plan = await planTeamLeads();
  const byId = new Map(plan.items.map((i) => [i.account_id, i]));
  const applied = [];
  const skipped = [];
  for (const id of accountIds) {
    const item = byId.get(id);
    if (!item) { skipped.push({ account_id: id, reason: 'not_in_structure' }); continue; }
    if (item.status !== 'change') { skipped.push({ account_id: id, reason: item.reason || item.status }); continue; }
    await db.prepare('UPDATE users SET team_lead_id = ? WHERE id = ?').run(item.proposed_team_lead_id, id);
    applied.push({ account_id: id, from: item.current_team_lead_id, to: item.proposed_team_lead_id });
  }
  if (applied.length) {
    console.log(`[SALES_STRUCTURE] admin #${actorId} set the Team Lead on ${applied.length} account(s): ${applied.map((a) => `#${a.account_id}->#${a.to}`).join(', ')}`);
  }
  return { applied, skipped };
}

// ─── Editing ─────────────────────────────────────────────────────────────────

const bad = (message, code = 'VALIDATION_ERROR', status = 400) => ({ error: { status, code, message } });

async function checkUser(id) {
  if (id === null || id === undefined || id === '') return { value: null };
  const n = parseInt(id, 10);
  const u = Number.isInteger(n) ? await db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(n) : null;
  if (!u || !(u.is_active === 1 || u.is_active === true)) return bad('user_id must be an active account.');
  return { value: n };
}

function amount(v, label) {
  if (v === null || v === undefined || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return bad(`${label} must be zero or more.`);
  return { value: n };
}

async function saveChannel(id, body, actorId) {
  const cur = id ? await db.prepare('SELECT * FROM sales_channels WHERE id = ?').get(id) : null;
  if (id && !cur) return bad('Channel not found.', 'NOT_FOUND', 404);
  const name = body.name !== undefined ? clean(body.name) : cur && cur.name;
  const head = body.head_name !== undefined ? clean(body.head_name) : cur && cur.head_name;
  if (!name) return bad('Channel name is required.');
  if (!head) return bad('Head name is required.');
  const clash = await db.prepare('SELECT id FROM sales_channels WHERE LOWER(name) = ? AND id <> ?').get(lower(name), id || 0);
  if (clash) return bad(`A channel called "${name}" already exists.`, 'CONFLICT', 409);
  let headUser = { value: cur ? cur.head_user_id : null };
  if (body.head_user_id !== undefined) { headUser = await checkUser(body.head_user_id); if (headUser.error) return headUser; }
  const now = new Date().toISOString();
  if (cur) {
    await db.prepare('UPDATE sales_channels SET name = ?, head_name = ?, head_user_id = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(name, head, headUser.value, now, actorId, id);
    return { id };
  }
  const max = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sales_channels').get();
  const r = await db.prepare('INSERT INTO sales_channels (name, head_name, head_user_id, sort_order, updated_by) VALUES (?, ?, ?, ?, ?)')
    .run(name, head, headUser.value, Number(max.m) + 1, actorId);
  return { id: r.lastInsertRowid, created: true };
}

async function saveManager(id, body, actorId) {
  const cur = id ? await db.prepare('SELECT * FROM sales_managers WHERE id = ?').get(id) : null;
  if (id && !cur) return bad('Manager not found.', 'NOT_FOUND', 404);
  const channelId = parseInt(body.channel_id !== undefined ? body.channel_id : cur && cur.channel_id, 10);
  if (!Number.isInteger(channelId) || !(await db.prepare('SELECT id FROM sales_channels WHERE id = ?').get(channelId))) {
    return bad('channel_id must be an existing channel.');
  }
  const name = body.name !== undefined ? clean(body.name) : cur && cur.name;
  if (!name) return bad('Manager name is required.');
  const clash = await db.prepare('SELECT id FROM sales_managers WHERE channel_id = ? AND LOWER(name) = ? AND id <> ?').get(channelId, lower(name), id || 0);
  if (clash) return bad(`"${name}" is already a manager in that channel.`, 'CONFLICT', 409);
  let user = { value: cur ? cur.user_id : null };
  if (body.user_id !== undefined) { user = await checkUser(body.user_id); if (user.error) return user; }
  const acts = body.acts_as_head !== undefined ? Boolean(body.acts_as_head) : cur ? Boolean(cur.acts_as_head) : false;
  const note = body.scope_note !== undefined ? clean(body.scope_note) : cur ? cur.scope_note : null;
  const now = new Date().toISOString();
  if (cur) {
    await db.prepare('UPDATE sales_managers SET channel_id = ?, name = ?, user_id = ?, acts_as_head = ?, scope_note = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(channelId, name, user.value, acts, note, now, actorId, id);
    return { id };
  }
  const max = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sales_managers WHERE channel_id = ?').get(channelId);
  const r = await db.prepare('INSERT INTO sales_managers (channel_id, name, user_id, acts_as_head, scope_note, sort_order, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channelId, name, user.value, acts, note, Number(max.m) + 1, actorId);
  return { id: r.lastInsertRowid, created: true };
}

async function addApprover(body, actorId) {
  const channelId = parseInt(body.channel_id, 10);
  if (!Number.isInteger(channelId) || !(await db.prepare('SELECT id FROM sales_channels WHERE id = ?').get(channelId))) {
    return bad('channel_id must be an existing channel.');
  }
  const name = clean(body.name);
  if (!name) return bad('Approver name is required.');
  const clash = await db.prepare('SELECT id FROM sales_channel_approvers WHERE channel_id = ? AND LOWER(name) = ?').get(channelId, lower(name));
  if (clash) return bad(`"${name}" already approves that channel.`, 'CONFLICT', 409);
  const user = await checkUser(body.user_id);
  if (user.error) return user;
  const max = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sales_channel_approvers WHERE channel_id = ?').get(channelId);
  const r = await db.prepare('INSERT INTO sales_channel_approvers (channel_id, name, user_id, sort_order, updated_by) VALUES (?, ?, ?, ?, ?)')
    .run(channelId, name, user.value, Number(max.m) + 1, actorId);
  return { id: r.lastInsertRowid, created: true };
}

async function deleteApprover(id) {
  const cur = await db.prepare('SELECT id FROM sales_channel_approvers WHERE id = ?').get(id);
  if (!cur) return bad('Approver not found.', 'NOT_FOUND', 404);
  await db.prepare('DELETE FROM sales_channel_approvers WHERE id = ?').run(id);
  return { id };
}

async function deleteManager(id) {
  const cur = await db.prepare('SELECT id FROM sales_managers WHERE id = ?').get(id);
  if (!cur) return bad('Manager not found.', 'NOT_FOUND', 404);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM sales_territories WHERE manager_id = ?').get(id);
  if (Number(n.n) > 0) return bad('Move or delete this manager\'s territories first.', 'HAS_TERRITORIES', 409);
  await db.prepare('DELETE FROM sales_managers WHERE id = ?').run(id);
  return { id };
}

async function saveTerritory(id, body, actorId) {
  const cur = id ? await db.prepare('SELECT * FROM sales_territories WHERE id = ?').get(id) : null;
  if (id && !cur) return bad('Territory not found.', 'NOT_FOUND', 404);
  const managerId = parseInt(body.manager_id !== undefined ? body.manager_id : cur && cur.manager_id, 10);
  if (!Number.isInteger(managerId) || !(await db.prepare('SELECT id FROM sales_managers WHERE id = ?').get(managerId))) {
    return bad('manager_id must be an existing manager.');
  }
  const zoho = body.zoho_salesperson !== undefined ? clean(body.zoho_salesperson) : cur && cur.zoho_salesperson;
  if (!zoho) return bad('zoho_salesperson is required: it is how the territory finds its accounts.');
  const clash = await db.prepare('SELECT id FROM sales_territories WHERE LOWER(zoho_salesperson) = ? AND id <> ?').get(lower(zoho), id || 0);
  if (clash) return bad(`"${zoho}" is already a territory.`, 'CONFLICT', 409);
  const target = amount(body.target_amount !== undefined ? body.target_amount : cur && cur.target_amount, 'target_amount');
  if (target.error) return target;
  const achieved = amount(body.achieved_amount !== undefined ? body.achieved_amount : cur && cur.achieved_amount, 'achieved_amount');
  if (achieved.error) return achieved;
  const pick = (k, curVal) => (body[k] !== undefined ? clean(body[k]) : curVal === undefined ? null : curVal);
  const fields = {
    alias: pick('zoho_alias', cur && cur.zoho_alias), person: pick('person_label', cur && cur.person_label),
    hq: pick('hq', cur && cur.hq), month: pick('target_month', cur && cur.target_month),
    vacant: body.is_vacant !== undefined ? Boolean(body.is_vacant) : cur ? Boolean(cur.is_vacant) : false,
  };
  const now = new Date().toISOString();
  if (cur) {
    await db
      .prepare(
        `UPDATE sales_territories SET manager_id = ?, zoho_salesperson = ?, zoho_alias = ?, person_label = ?, hq = ?, is_vacant = ?,
                target_month = ?, target_amount = ?, achieved_amount = ?, updated_at = ?, updated_by = ? WHERE id = ?`
      )
      .run(managerId, zoho, fields.alias, fields.person, fields.hq, fields.vacant, fields.month, target.value, achieved.value, now, actorId, id);
    return { id };
  }
  const max = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sales_territories WHERE manager_id = ?').get(managerId);
  const r = await db
    .prepare(
      `INSERT INTO sales_territories (manager_id, zoho_salesperson, zoho_alias, person_label, hq, is_vacant, target_month, target_amount, achieved_amount, sort_order, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(managerId, zoho, fields.alias, fields.person, fields.hq, fields.vacant, fields.month, target.value, achieved.value, Number(max.m) + 1, actorId);
  return { id: r.lastInsertRowid, created: true };
}

async function deleteTerritory(id) {
  const cur = await db.prepare('SELECT id FROM sales_territories WHERE id = ?').get(id);
  if (!cur) return bad('Territory not found.', 'NOT_FOUND', 404);
  await db.prepare('DELETE FROM sales_territories WHERE id = ?').run(id);
  return { id };
}

module.exports = {
  importSeed, getStructure, planTeamLeads, applyTeamLeads,
  saveChannel, saveManager, deleteManager, saveTerritory, deleteTerritory, addApprover, deleteApprover,
  findManagerAccount,
};
