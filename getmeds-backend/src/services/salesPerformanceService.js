'use strict';

/**
 * Sales Performance: the layout of the sales team's own sheet (Oct 3, 2026 sheet, Aaron sheet 13.6.6).
 * Oct 20, 2026.
 *
 * One row per Zoho salesperson (a TERRITORY, not a person), grouped Head > channel group > manager,
 * with Target, Achieved, Balance to target, Today's invoicing and %, a total at every level and a
 * grand total. Vacant territories are flagged (the sheet shows them in red) and still count in
 * the totals, as on the sheet.
 *
 * Pure: no database, no Zoho call. The controller reads the structure and Zoho's invoices and hands
 * them in, so this can be tested with plain objects.
 *
 *   Achieved = Zoho Total Sales with Tax: invoices dated in the month (draft and void left out)
 *              minus credit notes, the figure Aaron chose on Oct 14 (sheet 13.1.2.19).
 *   Today    = the same sum for invoices and credit notes dated today (Philippine time). Only
 *              shown for the running month. With a date range (Oct 24, 2026) it is the range's last day.
 *   Range    = optional { from, to }: Achieved covers only those dates (like Zoho's Date Range). The
 *              target stays the month's (the month of `to`); a range across two months shows no target,
 *              since targets are monthly.
 *   Target   = Oct 24, 2026 (Aaron): the same targets as the Overview and Sales KPIs. When the month has
 *              per-person targets (kpi_targets), a territory someone holds shows its holder's target,
 *              placed on the holder's primary territory so it is counted once (their other territories
 *              say whose target covers them); a vacant territory, or one nobody holds, shows its own
 *              territory target (territory_targets). A month with no per-person targets (September)
 *              falls back to the territory's own sheet target (sales_territories.target_month), and a
 *              target that belongs to another month is never shown. People with a target who hold no
 *              territory on the structure are listed apart, so the grand total plus that list equals
 *              the Overview's company target.
 *   Balance  = Target - Achieved (negative once the target is passed).
 *   %        = Achieved / Target; blank when there is no target (the sheet shows #DIV/0!).
 *
 * A territory finds its Zoho sales by its own Zoho name or its alias (what Zoho still calls it),
 * compared ignoring case and spacing, then ignoring punctuation too ("MT-1" = "MT - 1"). Zoho
 * salespersons that match no territory are listed apart ("Not on the structure"), so the grand
 * total plus that list always equals Zoho's own total.
 */

const AT_RISK_SHARE = 0.8;

// The sheet shows the four Rx channels as two blocks. Anything not listed is its own block.
const GROUPS = {
  'RX · B&B': { label: 'RX BUSINESS', total: 'PRESCRIPTION TOTAL' },
  'RX · STC': { label: 'RX BUSINESS', total: 'PRESCRIPTION TOTAL' },
  'RX · URO': { label: 'RX BUSINESS', total: 'PRESCRIPTION TOTAL' },
  'RX · B2C': { label: 'MD TELESALES', total: 'PAP TOTAL' }
};
const groupOf = (channelName) => GROUPS[channelName] || { label: channelName, total: `${channelName} Total` };

const exact = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const loose = (s) => exact(s).replace(/[^a-z0-9]/g, '');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function statusFor(achieved, target, pace) {
  if (!target) return null;
  const share = achieved / target;
  if (share >= pace) return 'on';
  return share >= pace * AT_RISK_SHARE ? 'risk' : 'behind';
}

const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/** Share of the month that has passed: 1 for a closed month, today's day number / days for the running one. */
function paceFor(month, today) {
  if (!today || today.slice(0, 7) !== month) return 1;
  return Math.min(1, Number(today.slice(8, 10)) / daysInMonth(month));
}

function blankTotals() { return { target: 0, achieved: 0, today: 0, with_target: 0, rows: 0 }; }
function addTo(t, r) {
  t.rows += 1;
  // A target of 0 (the sheet's Tacloban, Mani Mishra) measures nothing, so it counts as "no target".
  if (r.target !== null) { t.target += r.target; if (r.target > 0) t.with_target += 1; }
  t.achieved += r.achieved || 0;
  t.today += r.today || 0;
}
function finishTotals(t, pace) {
  const target = r2(t.target), achieved = r2(t.achieved);
  return {
    rows: t.rows, with_target: t.with_target, target_php: target, achieved_php: achieved, today_php: r2(t.today),
    balance_php: r2(target - achieved), pct_of_target: pctOf(achieved, target), status: statusFor(achieved, target, pace)
  };
}

/**
 * @param month       'YYYY-MM'
 * @param today       'YYYY-MM-DD' in Philippine time
 * @param zoho        the result of readZohoSales (invoices / credit_notes with salesperson, total, date) or { available: false }
 * @param channels    sales_channels rows   { id, name, head_name, sort_order }
 * @param managers    sales_managers rows   { id, channel_id, name, sort_order }
 * @param territories sales_territories     { id, manager_id, zoho_salesperson, zoho_alias, person_label, hq, is_vacant, target_month, target_amount, sort_order }
 * @param targets     optional { people: kpi_targets rows { user_id, name, target_php } for the month,
 *                    accounts: user_salespersons rows { user_id, salesperson, is_primary },
 *                    territory: territory_targets rows { territory_id, target_php } for the month }
 */
function assignTargets(month, territories, targets) {
  const out = new Map(); // territory id -> { target, covered_by }
  const people = (targets && targets.people) || [];
  if (!people.length) {
    for (const t of territories) {
      out.set(t.id, { target: t.target_month === month && t.target_amount !== null && t.target_amount !== undefined ? r2(t.target_amount) : null, covered_by: null });
    }
    return { byTerritory: out, offStructure: [], source: 'territory' };
  }
  const tByName = new Map();
  for (const t of territories) for (const n of [t.zoho_salesperson, t.zoho_alias]) if (n && !tByName.has(exact(n))) tByName.set(exact(n), t);
  const holders = new Map(); // territory id -> [{ user_id, is_primary }]
  const held = new Map(); // user_id -> [{ t, is_primary }]
  for (const a of targets.accounts || []) {
    const t = tByName.get(exact(a.salesperson));
    if (!t) continue;
    if (!holders.has(t.id)) holders.set(t.id, []);
    holders.get(t.id).push({ user_id: a.user_id, is_primary: Boolean(a.is_primary) });
    if (!held.has(a.user_id)) held.set(a.user_id, []);
    held.get(a.user_id).push({ t, is_primary: Boolean(a.is_primary) });
  }
  const tIds = new Set(territories.map((t) => t.id));
  const terrTarget = new Map((targets.territory || []).filter((r) => tIds.has(r.territory_id)).map((r) => [r.territory_id, Number(r.target_php) || 0]));
  const isOpen = (t) => Boolean(t.is_vacant) || !holders.has(t.id);
  for (const t of territories) out.set(t.id, { target: isOpen(t) ? (terrTarget.has(t.id) ? r2(terrTarget.get(t.id)) : null) : null, covered_by: null });
  const offStructure = [];
  for (const p of people) {
    const amount = Number(p.target_php) || 0;
    const mine = (held.get(p.user_id) || []).filter((h) => !h.t.is_vacant)
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || (a.t.sort_order ?? 0) - (b.t.sort_order ?? 0) || a.t.id - b.t.id);
    if (!mine.length) { offStructure.push({ person: p.name || `User ${p.user_id}`, target_php: r2(amount) }); continue; }
    const home = out.get(mine[0].t.id);
    home.target = r2((home.target || 0) + amount);
    for (const h of mine.slice(1)) {
      const o = out.get(h.t.id);
      if (o.target === null) o.covered_by = `${p.name || 'their holder'} (${mine[0].t.zoho_salesperson})`;
    }
  }
  // a territory that is one person's home and another's secondary keeps the target, not the note
  for (const v of out.values()) if (v.target !== null) v.covered_by = null;
  // vacant targets the Overview counts but no territory row can show (label only, or a removed territory)
  for (const r of targets.territory || []) {
    if (!tIds.has(r.territory_id)) offStructure.push({ person: `${r.label || 'Territory'} (vacant)`, target_php: r2(Number(r.target_php) || 0) });
  }
  offStructure.sort((a, b) => b.target_php - a.target_php);
  return { byTerritory: out, offStructure, source: 'people' };
}

function buildSalesPerformance({ month, today, zoho, channels, managers, territories, targets, range = null }) {
  const multiMonth = Boolean(range && range.from.slice(0, 7) !== range.to.slice(0, 7));
  const assigned = multiMonth
    ? { byTerritory: new Map(territories.map((t) => [t.id, { target: null, covered_by: null }])), offStructure: [], source: 'none' }
    : assignTargets(month, territories, targets);
  // pace for the colour: the share of the month the dates cover (a range from the 1st), else the whole month
  const pace = range
    ? (range.from === `${month}-01` && !multiMonth ? Math.min(1, Number(range.to.slice(8, 10)) / daysInMonth(month)) : 1)
    : paceFor(month, today);
  const running = Boolean(range ? true : today && today.slice(0, 7) === month);
  const day = range ? range.to : today;
  const zohoOk = Boolean(zoho && zoho.available);

  // ── Zoho sales per salesperson name
  const bySp = new Map(); // exact name -> { name, achieved, today }
  const put = (name, amount, date) => {
    const k = exact(name);
    if (!bySp.has(k)) bySp.set(k, { name: String(name || '').trim() || 'No salesperson', achieved: 0, today: 0 });
    const e = bySp.get(k);
    e.achieved += amount;
    if (running && date && String(date).slice(0, 10) === day) e.today += amount;
  };
  if (zohoOk) {
    (zoho.invoices || []).forEach((i) => put(i.salesperson, Number(i.total) || 0, i.date));
    (zoho.credit_notes || []).forEach((c) => put(c.salesperson, -(Number(c.total) || 0), c.date));
  }

  // ── territory lookup: exact spelling first, then ignoring punctuation (only when it is unambiguous)
  const exactIdx = new Map();
  const looseIdx = new Map();
  const looseClash = new Set();
  for (const t of territories) {
    for (const n of [t.zoho_salesperson, t.zoho_alias]) {
      if (!n) continue;
      if (!exactIdx.has(exact(n))) exactIdx.set(exact(n), t);
      const lk = loose(n);
      if (looseIdx.has(lk) && looseIdx.get(lk) !== t) looseClash.add(lk); else looseIdx.set(lk, t);
    }
  }
  const find = (name) => exactIdx.get(exact(name)) || (looseClash.has(loose(name)) ? null : looseIdx.get(loose(name))) || null;

  const money = new Map(); // territory id -> { achieved, today }
  const notOnStructure = [];
  for (const e of bySp.values()) {
    const t = find(e.name);
    if (!t) { if (r2(e.achieved) !== 0) notOnStructure.push({ salesperson: e.name, achieved_php: r2(e.achieved), today_php: r2(e.today) }); continue; }
    const m = money.get(t.id) || { achieved: 0, today: 0 };
    m.achieved += e.achieved; m.today += e.today;
    money.set(t.id, m);
  }
  notOnStructure.sort((a, b) => b.achieved_php - a.achieved_php);

  // ── rows
  const chById = new Map(channels.map((c) => [c.id, c]));
  const mgrById = new Map(managers.map((m) => [m.id, m]));
  const rowOf = (t) => {
    const m = money.get(t.id);
    const { target, covered_by } = assigned.byTerritory.get(t.id) || { target: null, covered_by: null };
    const achieved = zohoOk ? r2(m ? m.achieved : 0) : null;
    const today_php = zohoOk && running ? r2(m ? m.today : 0) : null;
    return {
      territory_id: t.id, person: t.person_label || '', zoho_name: t.zoho_salesperson, hq: t.hq || '', vacant: Boolean(t.is_vacant), target_covered_by: covered_by,
      target_php: target, achieved_php: achieved, today_php,
      balance_php: target !== null && achieved !== null ? r2(target - achieved) : null,
      pct_of_target: target && achieved !== null ? pctOf(achieved, target) : null,
      status: target && achieved !== null ? statusFor(achieved, target, pace) : null,
      _target: target, _achieved: achieved, _today: today_php
    };
  };

  const channelOrder = [...channels].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const heads = []; // [{ head, groups: [...] }] in channel order
  const headIdx = new Map();
  for (const ch of channelOrder) {
    const g = groupOf(ch.name);
    const hk = exact(ch.head_name);
    if (!headIdx.has(hk)) { const h = { head: ch.head_name, groups: [], groupIdx: new Map() }; headIdx.set(hk, h); heads.push(h); }
    const head = headIdx.get(hk);
    if (!head.groupIdx.has(g.label)) { const grp = { label: g.label, total_label: g.total, managerIdx: new Map(), managers: [] }; head.groupIdx.set(g.label, grp); head.groups.push(grp); }
    const grp = head.groupIdx.get(g.label);
    const chManagers = managers.filter((m) => m.channel_id === ch.id).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    for (const m of chManagers) {
      const mk = exact(m.name);
      if (!grp.managerIdx.has(mk)) { const blk = { name: m.name, territories: [] }; grp.managerIdx.set(mk, blk); grp.managers.push(blk); }
    }
  }
  const chOrderIdx = new Map(channelOrder.map((c, i) => [c.id, i]));
  for (const t of territories) {
    const m = mgrById.get(t.manager_id);
    const ch = m && chById.get(m.channel_id);
    if (!ch) continue;
    const head = headIdx.get(exact(ch.head_name));
    const grp = head.groupIdx.get(groupOf(ch.name).label);
    grp.managerIdx.get(exact(m.name)).territories.push({ t, ch: chOrderIdx.get(ch.id) });
  }

  const grand = blankTotals();
  const outHeads = [];
  for (const h of heads) {
    const headT = blankTotals();
    const groups = [];
    for (const grp of h.groups) {
      const groupT = blankTotals();
      const blocks = grp.managers.filter((b) => b.territories.length);
      const out = blocks.map((b) => {
        const mgrT = blankTotals();
        const rows = b.territories
          .sort((x, y) => (x.t.sort_order ?? 0) - (y.t.sort_order ?? 0) || x.ch - y.ch || x.t.id - y.t.id)
          .map(({ t }) => { const r = rowOf(t); addTo(mgrT, { target: r._target, achieved: r._achieved, today: r._today }); return r; });
        rows.forEach((r) => { addTo(groupT, { target: r._target, achieved: r._achieved, today: r._today }); addTo(headT, { target: r._target, achieved: r._achieved, today: r._today }); addTo(grand, { target: r._target, achieved: r._achieved, today: r._today }); delete r._target; delete r._achieved; delete r._today; });
        return { manager: b.name, rows, subtotal: blocks.length > 1 ? finishTotals(mgrT, pace) : null };
      });
      if (out.length) groups.push({ label: grp.label, total_label: grp.total_label, managers: out, total: finishTotals(groupT, pace) });
    }
    if (groups.length) outHeads.push({ head: h.head, groups, total: finishTotals(headT, pace) });
  }

  const gt = finishTotals(grand, pace);
  const otherTotal = r2(notOnStructure.reduce((a, r) => a + r.achieved_php, 0));
  return {
    available: true, month, running, today: running ? day : null, range, multi_month: multiMonth, pace: Math.round(pace * 1000) / 10,
    zoho_available: zohoOk,
    zoho: zohoOk ? {
      fetched_at: zoho.fetchedAt || null, cached: Boolean(zoho.cached), truncated: Boolean(zoho.truncated), warning: zoho.warning || null,
      invoice_count: zoho.invoice_count ?? (zoho.invoices || []).length, total_with_tax_php: zoho.total_sales_with_tax ?? null
    } : { error: (zoho && zoho.error) || 'Zoho could not be read.' },
    heads: outHeads,
    grand_total: gt,
    not_on_structure: { rows: notOnStructure, total_php: otherTotal },
    reconciliation: zohoOk ? { structure_php: gt.achieved_php, not_on_structure_php: otherTotal, together_php: r2(gt.achieved_php + otherTotal) } : null,
    targets_missing: gt.rows - gt.with_target - [...assigned.byTerritory.values()].filter((v) => v.covered_by).length,
    target_source: assigned.source,
    targets_not_on_structure: { rows: assigned.offStructure, total_php: r2(assigned.offStructure.reduce((a, r) => a + r.target_php, 0)) }
  };
}

module.exports = { buildSalesPerformance, groupOf, GROUPS, paceFor, _exact: exact, _loose: loose };
