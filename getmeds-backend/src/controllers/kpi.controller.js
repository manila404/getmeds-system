'use strict';

/**
 * The KPI page (Aaron sheet 13.1.2). Oct 5, 2026.
 *
 * Phase 1 and 2, shipped together: the monthly KPIs for every person, team lead, head and
 * channel (read-only, the SAME calculation as scripts/kpi-export-month.js — see
 * services/kpiService.js), plus monthly targets per person with a change log.
 *
 * Load: the KPI read is a few queries (~57 ms measured on live data) and runs only when
 * someone opens the page — nothing scheduled, nothing precomputed. It runs in a READ ONLY
 * transaction with a 10-second limit, so it can never write and never hold a connection long.
 */

const db = require('../db/database');
const { buildExport, monthRange, currentMonth, prevMonth } = require('../services/kpiService');
const { canSetTarget, canSetAnyTarget, canViewAllKpis, canViewOwnKpis, TARGET_ROLES } = require('../services/kpiPermissions');
const { teamMedrepIds, teamGroups } = require('../services/teamScopeService');

const MAX_TARGET = 1e11; // ₱100 billion — anything larger is a typo
const bad = (res, message) => res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
const q = (sql, params) => db._rawQuery(sql, params);

function parseMonth(value) {
  try { monthRange(String(value || '')); return String(value); } catch { return null; }
}

/** A target from the form: '' or null clears it; otherwise a peso amount (commas and ₱ allowed). */
function parseTarget(value) {
  if (value === null || value === undefined || String(value).trim() === '') return { clear: true };
  const n = Number(String(value).replace(/[₱,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > MAX_TARGET) return { error: true };
  return { value: Math.round(n * 100) / 100 };
}

/**
 * The month's KPIs for everyone, read once and kept briefly. Oct 6, 2026: since every
 * salesperson now sees their own KPIs (My Own / My Team KPI), many people open them; without
 * this each page open would recalculate the whole company. Kept 60 seconds for the running
 * month and 10 minutes for a closed one, per server instance, and dropped whenever a target
 * changes. The read itself stays READ ONLY with a 10-second limit.
 */
const cache = new Map(); // month -> { at, ttl, result }
async function monthKpis(month) {
  const hit = cache.get(month);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
  const result = await db.transaction(async () => {
    await q('SET TRANSACTION READ ONLY');
    await q('SET LOCAL statement_timeout = 10000');
    return buildExport({ query: async (sql, params) => ({ rows: await q(sql, params) }) }, month);
  })();
  cache.set(month, { at: Date.now(), ttl: result.partial ? 60_000 : 600_000, result });
  return result;
}
const clearKpiCache = () => cache.clear();

/** Sums people rows (from buildExport) into one figure set. */
function summarize(rows, ids) {
  const set = new Set(ids);
  const mine = rows.filter((p) => set.has(p.user_id));
  const sum = (k) => Math.round(mine.reduce((a, p) => a + (Number(p[k]) || 0), 0) * 100) / 100;
  const withTarget = mine.filter((p) => p.target_php !== '');
  const target = Math.round(withTarget.reduce((a, p) => a + Number(p.target_php), 0) * 100) / 100;
  const booked = sum('booked_php');
  return {
    people: set.size, people_with_target: withTarget.length, target_php: target, booked_php: booked,
    pct_of_target: target > 0 ? Math.round((booked / target) * 1000) / 10 : null,
    booked_orders: sum('booked_orders'), delivered_php: sum('delivered_php'), orders: sum('orders'), orders_held: sum('orders_held'),
    new_customers: sum('new_customers')
  };
}

/**
 * GET /api/kpi/me?month=YYYY-MM&team_group=… — My Own KPI and, for anyone with people under
 * them, My Team KPI (Aaron, Oct 6, 2026). Own = the orders the person owns, so an order Shiela
 * entered for Antonnete is on Antonnete's own KPI; Shiela's team KPI includes it, and her
 * 'entered for others' figure shows what she entered. Team = the person plus everyone below
 * them in the Team Lead chain, or one My Team tab when team_group is given. Nothing is counted
 * twice inside a total.
 */
async function getMyKpis(req, res, next) {
  try {
    const thisMonth = currentMonth();
    const month = req.query.month ? parseMonth(req.query.month) : thisMonth;
    if (!month) return bad(res, 'month must look like 2026-09');
    if (month > thisMonth) return bad(res, 'That month has not started yet');

    const result = await monthKpis(month);
    const me = req.user.id;
    const row = result.people.find((p) => p.user_id === me);
    const own = {
      ...summarize(result.people, [me]),
      entered_for_others_php: row ? row.raised_for_others_info_php : 0,
      entered_for_me_by_others_php: row ? row.booked_raised_by_others_php : 0
    };

    let team = null, group = null;
    const below = await teamMedrepIds(me);
    if (below.length) {
      const key = typeof req.query.team_group === 'string' ? req.query.team_group.trim() : '';
      if (key) {
        group = (await teamGroups(me)).find((g) => g.key === key) || null;
        team = { ...summarize(result.people, group ? group.ids : []), label: group ? group.label : 'Unknown team' };
      } else {
        team = { ...summarize(result.people, [me, ...below]), label: 'My team' };
      }
    }
    res.json({ success: true, data: { month, partial: result.partial, currentMonth: thisMonth, generatedAt: new Date().toISOString(), own, team } });
  } catch (err) { next(err); }
}

/** GET /api/kpi?month=YYYY-MM — the month's KPIs (default: this month, so far). */
async function getKpis(req, res, next) {
  try {
    const thisMonth = currentMonth();
    const month = req.query.month ? parseMonth(req.query.month) : thisMonth;
    if (!month) return bad(res, 'month must look like 2026-09');
    if (month > thisMonth) return bad(res, 'That month has not started yet');

    const result = await monthKpis(month);
    res.json({
      success: true,
      data: { ...result, currentMonth: thisMonth, generatedAt: new Date().toISOString(), canSetTargets: canSetAnyTarget(req.user) }
    });
  } catch (err) { next(err); }
}

/** GET /api/kpi/targets?month=YYYY-MM — every salesperson with their target for the month and last month's. */
async function getTargets(req, res, next) {
  try {
    const month = parseMonth(req.query.month || currentMonth());
    if (!month) return bad(res, 'month must look like 2026-09');
    const prev = prevMonth(month);
    const rows = await q(
      `SELECT u.id AS user_id, u.name, u.email, u.role, u.is_active,
              t.target_php, t.set_at, sb.name AS set_by_name, p.target_php AS prev_target_php
         FROM users u
         LEFT JOIN kpi_targets t ON t.user_id = u.id AND t.month = $1
         LEFT JOIN users sb ON sb.id = t.set_by
         LEFT JOIN kpi_targets p ON p.user_id = u.id AND p.month = $2
        WHERE u.role = ANY($3) AND (u.is_active = 1 OR t.id IS NOT NULL)
        ORDER BY u.name`,
      [month, prev, TARGET_ROLES]
    );
    res.json({
      success: true,
      data: {
        month, prevMonth: prev,
        people: rows.map((r) => ({
          ...r,
          active: Number(r.is_active) === 1,
          target_php: r.target_php === null ? null : Number(r.target_php),
          prev_target_php: r.prev_target_php === null ? null : Number(r.prev_target_php)
        }))
      }
    });
  } catch (err) { next(err); }
}

/**
 * PUT /api/kpi/targets/:month  { targets: [{ user_id, target_php }] }
 * Sets (or, with an empty value, clears) targets. Rows whose value did not change are
 * skipped, so saving the whole form only logs what really changed.
 */
async function putTargets(req, res, next) {
  try {
    const month = parseMonth(req.params.month);
    if (!month) return bad(res, 'month must look like 2026-09');
    const list = Array.isArray(req.body?.targets) ? req.body.targets : null;
    if (!list || !list.length) return bad(res, 'targets must be a non-empty list');
    if (list.length > 1000) return bad(res, 'Too many rows at once');

    const ids = [...new Set(list.map((t) => Number(t.user_id)))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return bad(res, 'Every row needs a user_id');
    if (ids.length !== list.length) return bad(res, 'A person appears twice');
    const people = await q('SELECT id, name, role, team_lead_id FROM users WHERE id = ANY($1)', [ids]);
    const byId = new Map(people.map((p) => [p.id, p]));

    const wanted = [];
    for (const t of list) {
      const person = byId.get(Number(t.user_id));
      if (!person || !TARGET_ROLES.includes(person.role)) return bad(res, `User ${t.user_id} is not a salesperson`);
      if (!canSetTarget(req.user, person)) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: `You cannot set ${person.name}'s target` } });
      }
      const parsed = parseTarget(t.target_php);
      if (parsed.error) return bad(res, `${person.name}: the target must be a peso amount from 0 up to ₱100 billion`);
      wanted.push({ person, ...parsed });
    }

    const actorName = req.user.name || req.user.email || null;
    const changed = await db.transaction(async () => {
      const current = new Map((await q('SELECT user_id, target_php FROM kpi_targets WHERE month = $1 AND user_id = ANY($2) FOR UPDATE', [month, ids]))
        .map((r) => [r.user_id, Number(r.target_php)]));
      let n = 0;
      for (const w of wanted) {
        const old = current.has(w.person.id) ? current.get(w.person.id) : null;
        if (w.clear) {
          if (old === null) continue;
          await q('DELETE FROM kpi_targets WHERE user_id = $1 AND month = $2', [w.person.id, month]);
        } else {
          if (old === w.value) continue;
          await q(
            `INSERT INTO kpi_targets (user_id, month, target_php, set_by, set_at) VALUES ($1, $2, $3, $4, iso_now())
             ON CONFLICT (user_id, month) DO UPDATE SET target_php = EXCLUDED.target_php, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
            [w.person.id, month, w.value, req.user.id]
          );
        }
        await q(
          `INSERT INTO kpi_target_changes (user_id, month, old_target_php, new_target_php, source, changed_by, changed_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [w.person.id, month, old, w.clear ? null : w.value, w.clear ? 'clear' : 'set', req.user.id, actorName]
        );
        n += 1;
      }
      return n;
    })();
    if (changed) clearKpiCache();
    res.json({ success: true, data: { month, changed } });
  } catch (err) { next(err); }
}

/**
 * POST /api/kpi/targets/:month/copy  { from: 'YYYY-MM' }
 * Copies another month's targets to people who have none yet this month. Never overwrites.
 */
async function copyTargets(req, res, next) {
  try {
    const month = parseMonth(req.params.month);
    const from = parseMonth(req.body?.from);
    if (!month || !from) return bad(res, 'month and from must look like 2026-09');
    if (month === from) return bad(res, 'Pick a different month to copy from');

    const actorName = req.user.name || req.user.email || null;
    const result = await db.transaction(async () => {
      const source = await q(
        `SELECT s.user_id, s.target_php, u.role, u.team_lead_id, u.name FROM kpi_targets s JOIN users u ON u.id = s.user_id
          WHERE s.month = $1 AND u.is_active = 1 AND u.role = ANY($2)
            AND NOT EXISTS (SELECT 1 FROM kpi_targets t WHERE t.user_id = s.user_id AND t.month = $3)`,
        [from, TARGET_ROLES, month]
      );
      const allowed = source.filter((s) => canSetTarget(req.user, { id: s.user_id, role: s.role, team_lead_id: s.team_lead_id }));
      let added = 0;
      for (const s of allowed) {
        const ins = await q(
          `INSERT INTO kpi_targets (user_id, month, target_php, set_by, set_at) VALUES ($1, $2, $3, $4, iso_now())
           ON CONFLICT (user_id, month) DO NOTHING RETURNING id`,
          [s.user_id, month, Number(s.target_php), req.user.id]
        );
        if (!ins.length) continue;
        await q(
          `INSERT INTO kpi_target_changes (user_id, month, old_target_php, new_target_php, source, changed_by, changed_by_name)
           VALUES ($1, $2, NULL, $3, 'copy', $4, $5)`,
          [s.user_id, month, Number(s.target_php), req.user.id, actorName]
        );
        added += 1;
      }
      const kept = Number((await q('SELECT COUNT(*)::int AS n FROM kpi_targets WHERE month = $1', [month]))[0].n) - added;
      return { added, kept };
    })();
    if (result.added) clearKpiCache();
    res.json({ success: true, data: { month, from, ...result } });
  } catch (err) { next(err); }
}

/**
 * POST /api/kpi/targets/:month/from-structure  { apply: false | true }
 *
 * Oct 8, 2026 (Aaron): the per-person monthly targets are the official ones. The sales sheet's
 * per-territory targets (sales_territories.target_amount) are used ONCE as a starting point:
 * each territory's target goes to the person who holds its Zoho name, and a person holding
 * several territories gets the sum. apply=false only previews; apply=true fills people who have
 * no target for the month yet (never overwrites) and logs each one as 'structure'.
 * Vacant territories, and territories no account holds, are listed and left unassigned.
 */
async function targetsFromStructure(req, res, next) {
  try {
    const month = parseMonth(req.params.month);
    if (!month) return bad(res, 'month must look like 2026-09');
    const apply = req.body?.apply === true;
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const words = (s) => String(s || '').split('|').pop().toUpperCase().split(/\s+/).filter((w) => w.length >= 3);

    const terrs = await q(
      `SELECT t.zoho_salesperson, t.zoho_alias, t.person_label, t.is_vacant, t.target_amount
         FROM sales_territories t WHERE COALESCE(t.target_amount, 0) > 0 ORDER BY t.zoho_salesperson`
    );
    const links = await q(
      `SELECT us.user_id, us.salesperson, us.is_primary, u.name, u.role
         FROM user_salespersons us JOIN users u ON u.id = us.user_id
        WHERE u.is_active = 1 AND u.role = ANY($1)`, [TARGET_ROLES]
    );
    const byPerson = new Map();
    const skipped = [];
    let vacantCount = 0, vacantTotal = 0;
    for (const t of terrs) {
      const amount = Number(t.target_amount) || 0;
      if (t.is_vacant) { vacantCount += 1; vacantTotal += amount; continue; }
      const keys = new Set([norm(t.zoho_salesperson), norm(t.zoho_alias)].filter(Boolean));
      const label = words(t.person_label);
      const score = (h) => [h.role === 'medrep' ? 1 : 0, label.filter((w) => h.name.toUpperCase().includes(w)).length, Number(h.is_primary) === 1 ? 1 : 0];
      const holders = links.filter((l) => keys.has(norm(l.salesperson)))
        .map((h) => ({ ...h, s: score(h) }))
        .sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || b.s[2] - a.s[2]);
      if (!holders.length) { skipped.push({ territory: t.zoho_salesperson, target_php: amount, reason: 'No account holds this Zoho name' }); continue; }
      const [best, second] = holders;
      if (second && second.user_id !== best.user_id && String(second.s) === String(best.s)) {
        skipped.push({ territory: t.zoho_salesperson, target_php: amount, reason: `Held equally by ${best.name} and ${second.name}` });
        continue;
      }
      const p = byPerson.get(best.user_id) || { user_id: best.user_id, name: best.name, target_php: 0, territories: [] };
      p.target_php += amount;
      p.territories.push(t.zoho_salesperson);
      byPerson.set(best.user_id, p);
    }
    const current = new Map((await q('SELECT user_id, target_php FROM kpi_targets WHERE month = $1', [month])).map((r) => [r.user_id, Number(r.target_php)]));
    const proposals = [...byPerson.values()]
      .map((p) => ({ ...p, target_php: Math.round(p.target_php * 100) / 100, current_target_php: current.has(p.user_id) ? current.get(p.user_id) : null }))
      .map((p) => ({ ...p, action: p.current_target_php === null ? 'add' : 'keep' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let added = 0;
    if (apply) {
      const actorName = req.user.name || req.user.email || null;
      added = await db.transaction(async () => {
        let n = 0;
        for (const p of proposals.filter((x) => x.action === 'add')) {
          if (!canSetTarget(req.user, { id: p.user_id })) continue;
          const ins = await q(
            `INSERT INTO kpi_targets (user_id, month, target_php, set_by, set_at) VALUES ($1, $2, $3, $4, iso_now())
             ON CONFLICT (user_id, month) DO NOTHING RETURNING id`, [p.user_id, month, p.target_php, req.user.id]);
          if (!ins.length) continue;
          await q(
            `INSERT INTO kpi_target_changes (user_id, month, old_target_php, new_target_php, source, changed_by, changed_by_name)
             VALUES ($1, $2, NULL, $3, 'structure', $4, $5)`, [p.user_id, month, p.target_php, req.user.id, actorName]);
          n += 1;
        }
        return n;
      })();
      if (added) clearKpiCache();
    }
    res.json({
      success: true,
      data: {
        month, applied: apply, added, proposals, skipped,
        vacant: { territories: vacantCount, target_php: Math.round(vacantTotal * 100) / 100 },
        to_add: proposals.filter((p) => p.action === 'add').length
      }
    });
  } catch (err) { next(err); }
}

/** GET /api/kpi/target-changes?month=YYYY-MM — who changed which target, and when (newest first). */
async function getTargetChanges(req, res, next) {
  try {
    const month = parseMonth(req.query.month || currentMonth());
    if (!month) return bad(res, 'month must look like 2026-09');
    const rows = await q(
      `SELECT c.id, c.user_id, u.name AS person, c.month, c.old_target_php, c.new_target_php, c.source,
              c.changed_by_name, c.changed_at
         FROM kpi_target_changes c JOIN users u ON u.id = c.user_id
        WHERE c.month = $1 ORDER BY c.changed_at DESC, c.id DESC LIMIT 500`,
      [month]
    );
    res.json({ success: true, data: { month, changes: rows } });
  } catch (err) { next(err); }
}

/** GET /api/kpi/status — lets the menu know the page is on (404 from the router when it is off). */
function getStatus(req, res) {
  res.json({
    success: true,
    data: { enabled: true, canViewAll: canViewAllKpis(req.user), canViewOwn: canViewOwnKpis(req.user), canSetTargets: canSetAnyTarget(req.user), currentMonth: currentMonth() }
  });
}

module.exports = { getKpis, getMyKpis, getTargets, putTargets, copyTargets, targetsFromStructure, getTargetChanges, getStatus, _test: { parseTarget, parseMonth, clearKpiCache } };
