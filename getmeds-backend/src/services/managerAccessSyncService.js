'use strict';

/**
 * Manager Access from the team structure: preview, and an explicit apply.
 *
 * Sep 26, 2026.
 *
 * In the structure a MANAGER IS THE APPROVER: whoever approves a channel is the
 * manager for it. Manager Access (manager_order_scope) is where the app decides
 * which divisions a Management account actually sees and can approve. Kept by
 * hand, the two drift apart. This derives what each Management account's divisions
 * SHOULD be from the structure, shows how that compares with what is set today,
 * and applies it for the accounts you name.
 *
 * ── What a manager's divisions are ─────────────────────────────────────────
 * The divisions of every channel where their account is an approver, or is a team
 * lead (Jessa leads B2B and is limited to it). Channels map to divisions through
 * CHANNEL_DIVISIONS below. A channel with no division in the order app (MT) adds
 * nothing and is reported, not guessed.
 *
 * ── The three safeguards ───────────────────────────────────────────────────
 * 1. NEVER automatic. The preview reads only; apply changes exactly the accounts
 *    named, and only those the preview marks 'differs'.
 * 2. A manager who approves EVERY approved channel and has full access is left
 *    alone ('full_access'): restricting them by division would take away the
 *    ~36,000 orders that carry no division, which only full access can see.
 * 3. Going from full access to a division list loses those no-division orders, so
 *    apply refuses unless the caller says so explicitly (confirm_restrict).
 *
 * An empty division list is never written: order_scope 'divisions' with no rules
 * sees NOTHING, and a preview that could blind a manager is not a preview.
 */

const db = require('../db/database');
const { SCOPE_ALL, SCOPE_DIVISIONS } = require('./orderScopeService');

// Channel (as named in the structure) -> the order app's divisions. Telesales
// carries the anesthesia telesales division, and B2C carries MD Telesales, which the
// sheet renamed to B2C. MT has no division in the order app yet.
const CHANNEL_DIVISIONS = {
  'RX · B&B': ['B&B'],
  'RX · STC': ['STC'],
  'RX · URO': ['URO'],
  'RX · B2C': ['B2C', 'MD Telesales'],
  B2B: ['B2B'],
  BID: ['BID'],
  CLIDP: ['CLIDP'],
  TELESALES: ['TeleSales', 'TeleSales Anesthesia'],
  HOSP: ['HOS'],
  MT: [],
};

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const uniq = (list) => [...new Set(list)];

async function ordersByDivision() {
  const rows = await db.prepare('SELECT division, COUNT(*) AS c FROM orders GROUP BY division').all();
  const by = {};
  let unattributed = 0;
  for (const r of rows) {
    if (r.division == null) unattributed = Number(r.c);
    else by[r.division] = Number(r.c);
  }
  return { by, unattributed, total: Object.values(by).reduce((s, n) => s + n, 0) + unattributed };
}

async function plan() {
  const [channels, approvers, managers, users, rules, counts] = await Promise.all([
    db.prepare('SELECT id, name FROM sales_channels ORDER BY sort_order, id').all(),
    db.prepare('SELECT channel_id, user_id FROM sales_channel_approvers').all(),
    db.prepare('SELECT channel_id, user_id FROM sales_managers WHERE user_id IS NOT NULL').all(),
    db.prepare("SELECT id, name, email, order_scope FROM users WHERE role = 'management' AND is_active = 1 ORDER BY name").all(),
    db.prepare('SELECT user_id, division, sub_division FROM manager_order_scope').all(),
    ordersByDivision(),
  ]);

  const chName = new Map(channels.map((c) => [c.id, c.name]));
  // Channels that have an approver at all: "approves everything" means all of these.
  const approvedChannels = uniq(approvers.map((a) => a.channel_id));

  const rulesBy = new Map();
  for (const r of rules) {
    if (!rulesBy.has(r.user_id)) rulesBy.set(r.user_id, []);
    rulesBy.get(r.user_id).push(r);
  }

  const visible = (mode, divs) =>
    mode === SCOPE_ALL ? counts.total : divs.reduce((s, d) => s + (counts.by[d] || 0), 0);

  const items = users.map((u) => {
    const approves = uniq(approvers.filter((a) => a.user_id === u.id).map((a) => a.channel_id));
    const leads = uniq(managers.filter((m) => m.user_id === u.id).map((m) => m.channel_id));
    const inChannels = uniq([...approves, ...leads]);
    const currentMode = u.order_scope === SCOPE_DIVISIONS ? SCOPE_DIVISIONS : SCOPE_ALL;
    const userRules = rulesBy.get(u.id) || [];
    const currentDivs = uniq(userRules.map((r) => r.division)).sort();

    const base = {
      user_id: u.id, name: u.name, email: u.email,
      approves_channels: approves.map((id) => chName.get(id)),
      leads_channels: leads.map((id) => chName.get(id)),
      current: { mode: currentMode, divisions: currentMode === SCOPE_DIVISIONS ? currentDivs : [] },
      orders_visible_now: visible(currentMode, currentDivs),
    };

    if (!inChannels.length) return { ...base, status: 'not_in_structure', proposed_divisions: [] };

    const fullApprover = approvedChannels.length > 0 && approvedChannels.every((id) => approves.includes(id));
    if (currentMode === SCOPE_ALL && fullApprover) {
      return { ...base, status: 'full_access', proposed_divisions: [] };
    }

    const proposed = uniq(inChannels.flatMap((id) => CHANNEL_DIVISIONS[chName.get(id)] || [])).sort();
    const unmapped = inChannels.map((id) => chName.get(id)).filter((n) => !(CHANNEL_DIVISIONS[n] || []).length);
    if (!proposed.length) return { ...base, status: 'blocked', reason: 'no_division_for_channels', unmapped_channels: unmapped, proposed_divisions: [] };

    const hasSubRules = userRules.some((r) => r.sub_division);
    const matches = currentMode === SCOPE_DIVISIONS && sameSet(currentDivs, proposed) && !hasSubRules;
    return {
      ...base,
      status: matches ? 'matches' : 'differs',
      proposed_divisions: proposed,
      add: proposed.filter((d) => !currentDivs.includes(d) || currentMode === SCOPE_ALL),
      remove: currentMode === SCOPE_DIVISIONS ? currentDivs.filter((d) => !proposed.includes(d)) : [],
      unmapped_channels: unmapped,
      orders_visible_after: visible(SCOPE_DIVISIONS, proposed),
      // Full access includes every order with no division; a division list does not.
      drops_unattributed: currentMode === SCOPE_ALL ? counts.unattributed : 0,
      replaces_sub_division_rules: hasSubRules,
    };
  });

  const tally = { matches: 0, differs: 0, full_access: 0, not_in_structure: 0, blocked: 0 };
  items.forEach((i) => { tally[i.status] += 1; });
  return { items, counts: tally, orders_total: counts.total, unattributed_orders: counts.unattributed, channel_divisions: CHANNEL_DIVISIONS };
}

/**
 * Applies the derived divisions to exactly the accounts named, and only those the
 * preview marks 'differs'. `confirmRestrict` must be true if any of them goes from
 * full access to a division list.
 */
async function apply(userIds, { confirmRestrict = false, actorId = null } = {}) {
  const p = await plan();
  const byId = new Map(p.items.map((i) => [i.user_id, i]));
  const applied = [];
  const skipped = [];

  const wanted = userIds.map((id) => byId.get(id));
  if (wanted.some((i) => i && i.status === 'differs' && i.drops_unattributed > 0) && !confirmRestrict) {
    return { error: { status: 400, code: 'CONFIRM_REQUIRED', message: 'One of these managers has full access today. A division list would stop them seeing the orders that carry no division, so this needs confirm_restrict: true.' } };
  }

  const now = new Date().toISOString();
  for (const id of userIds) {
    const item = byId.get(id);
    if (!item) { skipped.push({ user_id: id, reason: 'not_a_management_account' }); continue; }
    if (item.status !== 'differs') { skipped.push({ user_id: id, reason: item.status }); continue; }
    if (!item.proposed_divisions.length) { skipped.push({ user_id: id, reason: 'no_divisions' }); continue; }

    // One transaction per manager: a half-written rule list must never be left
    // behind, because 'divisions' with too few rules silently hides orders.
    await db.transaction(async () => {
      await db.prepare('DELETE FROM manager_order_scope WHERE user_id = ?').run(id);
      for (const d of item.proposed_divisions) {
        await db.prepare('INSERT INTO manager_order_scope (user_id, division, sub_division, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
          .run(id, d, null, now, actorId);
      }
      await db.prepare('UPDATE users SET order_scope = ? WHERE id = ?').run(SCOPE_DIVISIONS, id);
    })();
    applied.push({ user_id: id, name: item.name, from: item.current, to: { mode: SCOPE_DIVISIONS, divisions: item.proposed_divisions } });
  }
  if (applied.length) {
    console.log(`[MANAGER_ACCESS] admin #${actorId} set divisions from the team structure for: ${applied.map((a) => `#${a.user_id} (${a.to.divisions.join(', ')})`).join('; ')}`);
  }
  return { applied, skipped };
}

module.exports = { plan, apply, CHANNEL_DIVISIONS };
