#!/usr/bin/env node
'use strict';

/**
 * Monthly KPI export for the Sales department — READ-ONLY. Oct 5, 2026.
 *
 * Decided by Aaron: no new screens, no new tables, no database change, so the
 * live system stays untouched. This script is run BY HAND, off-peak, and writes a
 * folder of CSV files (Excel and Google Sheets open them directly).
 *
 *   node scripts/kpi-export-month.js 2026-09
 *   node scripts/kpi-export-month.js --init-targets 2026-10          blank targets row per salesperson
 *   node scripts/kpi-export-month.js --copy-targets 2026-09 2026-10  copy last month's targets
 *
 * Output (default <repo>/../getmeds-documents/kpi/<month>/):
 *   01-people.csv  02-teams.csv  03-heads.csv  04-channels.csv  05-routing.csv  06-checks.csv
 * Targets are read from <kpi folder>/targets.csv (email, month, target_php). They live in
 * a spreadsheet file, not in the database.
 *
 * RULES (agreed with Aaron)
 *  - BOOKED = the Finance sales-summary rule: an order counts once, in the month of its
 *    LATEST 'FINANCE_VERIFIED' event (Philippine time), excluding Zoho-imported orders and
 *    orders cancelled or deleted (which includes drafts Management cancelled).
 *    controllers/finance.controller.js getSalesSummary is the source; keep them identical.
 *  - Orders count for the OWNING MedRep (orders.medrep_id), not whoever raised them. So when a
 *    field rep raises an order for an on-site rep, the on-site rep is credited. The "raised by
 *    others" columns and 05-routing.csv keep the field rep's part visible, WITHOUT crediting it.
 *  - Team lead / head / channel rows are always the SUM of the people under them. A person who
 *    holds territories in more than one channel is counted once, under their primary channel.
 *  - New customers and follow-ups on time: "Not tracked yet" (the live system has no data for them).
 *
 * SAFETY: one connection, a READ ONLY transaction (any write fails), a statement time limit,
 * one pass of a few queries, nothing scheduled, nothing written to the database.
 */

const fs = require('fs');
const path = require('path');

const MANILA = '+08:00';
const NOT_TRACKED = 'Not tracked yet';

/** [fromUtc, toUtc) for a YYYY-MM month in Philippine time. */
function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must look like 2026-09');
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [new Date(`${month}-01T00:00:00${MANILA}`).toISOString(), new Date(`${next}-01T00:00:00${MANILA}`).toISOString()];
}
const prevMonth = (month) => {
  const [y, m] = month.split(':')[0].split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/* ───────── CSV ───────── */
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
  return rows.filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/* ───────── targets file ───────── */
function readTargets(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, 'utf8'));
}
function targetsFor(rows, month) {
  const m = new Map();
  for (const r of rows) {
    if (r.month !== month || r.target_php === '') continue;
    const n = Number(String(r.target_php).replace(/[₱,\s]/g, ''));
    if (Number.isFinite(n) && n >= 0) m.set(String(r.email || '').toLowerCase(), n);
  }
  return m;
}
/** Copies FROM's rows to TO. Never overwrites a row that already exists for TO. */
function copyTargets(rows, from, to) {
  const have = new Set(rows.filter((r) => r.month === to).map((r) => String(r.email).toLowerCase()));
  const added = [];
  for (const r of rows.filter((x) => x.month === from && x.target_php !== '')) {
    if (!have.has(String(r.email).toLowerCase())) added.push({ ...r, month: to });
  }
  return { rows: [...rows, ...added], added: added.length, kept: have.size };
}

/* ───────── the export ───────── */
const peso = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : '');

async function buildExport(client, month, targetRows = []) {
  const [fromUtc, toUtc] = monthRange(month);
  const { importedSql } = require('../src/services/orderOrigin');
  const notImported = `NOT (${importedSql('o')})`;

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  const users = await q(`SELECT id, name, email, role, is_active, team_lead_id FROM users`);
  const byId = new Map(users.map((u) => [u.id, u]));

  // structure: channels, managers (team leads / heads), territories, accounts' salespersons
  const channels = await q('SELECT id, name, head_name, head_user_id FROM sales_channels ORDER BY sort_order, id');
  const managers = await q('SELECT id, channel_id, name, user_id, acts_as_head FROM sales_managers');
  const terrs = await q('SELECT id, manager_id, zoho_salesperson, hq FROM sales_territories');
  const accts = await q('SELECT user_id, salesperson, is_primary FROM user_salespersons ORDER BY is_primary DESC, id');

  // BOOKED — one row per order, by its latest FINANCE_VERIFIED event in the month
  const booked = await q(
    `SELECT id, medrep_id, raised_by_id, total_amount, status FROM (
        SELECT DISTINCT ON (o.id) o.id, o.medrep_id, o.raised_by_id, o.total_amount, o.status
          FROM order_events fe JOIN orders o ON o.id = fe.order_id
         WHERE fe.event_type = 'FINANCE_VERIFIED' AND ${notImported}
           AND o.status NOT IN ('cancelled', 'deleted')
           AND fe.created_at >= $1 AND fe.created_at < $2
         ORDER BY o.id, fe.created_at DESC) b`,
    [fromUtc, toUtc]
  );
  const raised = await q(
    `SELECT o.id, o.medrep_id FROM orders o
      WHERE o.created_at >= $1 AND o.created_at < $2 AND ${notImported}
        AND o.status NOT IN ('draft', 'cancelled', 'deleted')`,
    [fromUtc, toUtc]
  );
  const held = await q(
    `SELECT DISTINCT o.id, o.medrep_id FROM order_events e JOIN orders o ON o.id = e.order_id
      WHERE e.new_status = 'on_hold' AND e.old_status IS DISTINCT FROM 'on_hold'
        AND e.created_at >= $1 AND e.created_at < $2 AND ${notImported} AND o.status <> 'deleted'`,
    [fromUtc, toUtc]
  );

  // ── who sits where ──
  const terrBySp = new Map(terrs.map((t) => [String(t.zoho_salesperson || '').toLowerCase(), t]));
  const mgrById = new Map(managers.map((m) => [m.id, m]));
  const chById = new Map(channels.map((c) => [c.id, c]));
  const place = new Map(); // user_id -> { channelIds:Set, primaryChannel, hqs:Set }
  for (const a of accts) {
    const t = terrBySp.get(String(a.salesperson || '').toLowerCase());
    if (!t) continue;
    const m = mgrById.get(t.manager_id);
    const p = place.get(a.user_id) || { channelIds: [], hqs: [] };
    if (m && !p.channelIds.includes(m.channel_id)) p.channelIds.push(m.channel_id);
    if (t.hq) p.hqs.push(String(t.hq).toUpperCase());
    place.set(a.user_id, p);
  }
  const repType = (uid) => {
    const p = place.get(uid);
    if (!p || !p.hqs.length) return 'Unplaced';
    return p.hqs.includes('ON SITE') ? 'On-site' : 'Field';
  };
  const channelOf = (uid) => { const p = place.get(uid); return p && p.channelIds.length ? chById.get(p.channelIds[0]) : null; };

  // ── per-owner tallies ──
  const T = new Map();
  const tally = (id) => { if (!T.has(id)) T.set(id, { booked: 0, bookedN: 0, completed: 0, byOthersN: 0, byOthers: 0, raisedForOthersN: 0, raisedForOthers: 0, orders: 0, held: 0 }); return T.get(id); };
  const routing = new Map();
  for (const o of booked) {
    const amt = Number(o.total_amount) || 0;
    const t = tally(o.medrep_id);
    t.booked += amt; t.bookedN += 1;
    if (o.status === 'completed') t.completed += amt;
    if (o.raised_by_id && o.raised_by_id !== o.medrep_id) {
      t.byOthersN += 1; t.byOthers += amt;
      const r = tally(o.raised_by_id); r.raisedForOthersN += 1; r.raisedForOthers += amt;
      const k = `${o.medrep_id}|${o.raised_by_id}`;
      const e = routing.get(k) || { owner: o.medrep_id, raiser: o.raised_by_id, n: 0, amt: 0 };
      e.n += 1; e.amt += amt; routing.set(k, e);
    }
  }
  for (const o of raised) tally(o.medrep_id).orders += 1;
  for (const o of held) tally(o.medrep_id).held += 1;

  const targets = targetsFor(targetRows, month);
  const salespeople = users.filter((u) => ['medrep', 'team_lead'].includes(u.role) && (u.is_active || T.has(u.id)));
  const personIds = new Set(salespeople.map((u) => u.id));
  const ownerOnly = [...T.keys()].filter((id) => id && !personIds.has(id)).map((id) => byId.get(id)).filter(Boolean);
  const peopleList = [...salespeople, ...ownerOnly];

  const people = peopleList.map((u) => {
    const t = T.get(u.id) || tally(u.id);
    const lead = u.team_lead_id ? byId.get(u.team_lead_id) : null;
    const ch = channelOf(u.id);
    const target = targets.get(String(u.email).toLowerCase());
    return {
      user_id: u.id, person: u.name, email: u.email, role: u.role, active: u.is_active ? 'yes' : 'no',
      rep_type: repType(u.id), team_lead: lead ? lead.name : '(none)', channel: ch ? ch.name : '(unplaced)',
      head: ch ? ch.head_name : '(none)',
      target_php: target === undefined ? '' : target,
      booked_php: peso(t.booked), booked_orders: t.bookedN, pct_of_target: target ? pct(t.booked, target) : '',
      delivered_php: peso(t.completed), orders: t.orders, orders_held: t.held,
      booked_raised_by_others_php: peso(t.byOthers), booked_raised_by_others_orders: t.byOthersN,
      raised_for_others_info_php: peso(t.raisedForOthers),
      new_customers: NOT_TRACKED, followups_on_time: NOT_TRACKED
    };
  });

  const sumRows = (rows, labelCols) => {
    const g = new Map();
    for (const r of rows) {
      const key = labelCols.map((c) => r[c]).join('|');
      if (!g.has(key)) g.set(key, { ...Object.fromEntries(labelCols.map((c) => [c, r[c]])), people: 0, target_php: 0, targets_missing: 0, booked_php: 0, booked_orders: 0, delivered_php: 0, orders: 0, orders_held: 0, booked_raised_by_others_php: 0, raised_for_others_info_php: 0 });
      const a = g.get(key);
      a.people += 1; a.booked_php += r.booked_php; a.booked_orders += r.booked_orders; a.delivered_php += r.delivered_php;
      a.orders += r.orders; a.orders_held += r.orders_held; a.booked_raised_by_others_php += r.booked_raised_by_others_php; a.raised_for_others_info_php += r.raised_for_others_info_php;
      if (r.target_php === '') a.targets_missing += 1; else a.target_php += r.target_php;
    }
    return [...g.values()].map((a) => ({
      ...a, target_php: peso(a.target_php), booked_php: peso(a.booked_php), delivered_php: peso(a.delivered_php),
      booked_raised_by_others_php: peso(a.booked_raised_by_others_php), raised_for_others_info_php: peso(a.raised_for_others_info_php),
      pct_of_target: a.target_php ? pct(a.booked_php, a.target_php) : '', new_customers: NOT_TRACKED, followups_on_time: NOT_TRACKED
    }));
  };
  const teams = sumRows(people, ['team_lead']);
  const channelRows = sumRows(people, ['channel']);
  const heads = sumRows(people, ['head']);

  const routingRows = [...routing.values()].map((r) => ({
    owner_credited: byId.get(r.owner)?.name || r.owner, owner_rep_type: repType(r.owner),
    raised_by: byId.get(r.raiser)?.name || r.raiser, raiser_rep_type: repType(r.raiser),
    booked_orders: r.n, booked_php: peso(r.amt)
  })).sort((a, b) => b.booked_php - a.booked_php);

  // ── checks ──
  const totalBooked = peso(booked.reduce((s, o) => s + (Number(o.total_amount) || 0), 0));
  const exportedBooked = peso(people.reduce((s, p) => s + p.booked_php, 0));
  const noOwner = booked.filter((o) => !o.medrep_id).length;
  const multi = peopleList.filter((u) => (place.get(u.id)?.channelIds.length || 0) > 1).map((u) => u.name);
  const missingTargets = people.filter((p) => p.active === 'yes' && p.target_php === '').length;
  const checks = [
    { check: 'Month (Philippine time)', value: month, note: `${fromUtc} to ${toUtc} (UTC)` },
    { check: 'Booked total by the Finance rule (all orders)', value: totalBooked, note: 'Compare with Finance > Sales Summary "Forecast" for the same month' },
    { check: 'Booked total in this export (sum of people)', value: exportedBooked, note: exportedBooked === totalBooked ? 'OK — matches' : 'MISMATCH — orders not tied to a listed person' },
    { check: 'Booked orders (count)', value: booked.length, note: '' },
    { check: 'Booked orders with no owner', value: noOwner, note: noOwner ? 'Not credited to anyone' : 'OK' },
    { check: 'Orders raised by someone other than the owner (booked)', value: booked.filter((o) => o.raised_by_id && o.raised_by_id !== o.medrep_id).length, note: 'Credited to the owner; see 05-routing.csv' },
    { check: 'People counted under more than one channel', value: multi.length, note: multi.length ? `Counted once, under their primary channel: ${multi.join('; ')}` : 'OK' },
    { check: 'Active people with no target for this month', value: missingTargets, note: missingTargets ? 'Fill targets.csv, or use --copy-targets' : 'OK' },
    { check: 'New customers / follow-ups on time', value: NOT_TRACKED, note: 'The live system has no customer owner or follow-up dates yet' }
  ];
  return { month, people, teams, heads, channels: channelRows, routing: routingRows, checks, totalBooked, exportedBooked };
}

const COLS = {
  people: ['person', 'email', 'role', 'active', 'rep_type', 'team_lead', 'channel', 'head', 'target_php', 'booked_php', 'pct_of_target', 'booked_orders', 'delivered_php', 'orders', 'orders_held', 'booked_raised_by_others_php', 'booked_raised_by_others_orders', 'raised_for_others_info_php', 'new_customers', 'followups_on_time'],
  group: (label) => [label, 'people', 'target_php', 'targets_missing', 'booked_php', 'pct_of_target', 'booked_orders', 'delivered_php', 'orders', 'orders_held', 'booked_raised_by_others_php', 'raised_for_others_info_php', 'new_customers', 'followups_on_time'],
  routing: ['owner_credited', 'owner_rep_type', 'raised_by', 'raiser_rep_type', 'booked_orders', 'booked_php'],
  checks: ['check', 'value', 'note']
};

function writeFiles(result, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, cols, rows) => fs.writeFileSync(path.join(dir, name), toCsv(cols, rows));
  w('01-people.csv', COLS.people, result.people);
  w('02-teams.csv', COLS.group('team_lead'), result.teams);
  w('03-heads.csv', COLS.group('head'), result.heads);
  w('04-channels.csv', COLS.group('channel'), result.channels);
  w('05-routing.csv', COLS.routing, result.routing);
  w('06-checks.csv', COLS.checks, result.checks);
}

/** Runs the export inside a READ ONLY transaction with a time limit. */
async function runReadOnly(connectionString, month, targetRows) {
  const { Pool } = require('pg');
  const hosted = !/localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({ connectionString, ssl: hosted ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 20000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 30000');
    const result = await buildExport(client, month, targetRows);
    await client.query('ROLLBACK');
    return result;
  } finally { client.release(); await pool.end(); }
}

/* ───────── command line ───────── */
async function main() {
  require('dotenv').config();
  const args = process.argv.slice(2);
  const kpiDir = path.resolve(__dirname, '../../../getmeds-documents/kpi');
  const targetsFile = path.join(kpiDir, 'targets.csv');
  const TCOLS = ['email', 'month', 'target_php', 'name'];

  if (args[0] === '--copy-targets') {
    const [, from, to] = args; monthRange(from); monthRange(to);
    const { rows, added, kept } = copyTargets(readTargets(targetsFile), from, to);
    fs.mkdirSync(kpiDir, { recursive: true });
    fs.writeFileSync(targetsFile, toCsv(TCOLS, rows));
    console.log(`Copied ${added} target(s) from ${from} to ${to}. ${kept} already existed for ${to} and were left as they are.`);
    return;
  }
  if (args[0] === '--init-targets') {
    const month = args[1]; monthRange(month);
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 1 });
    const us = (await pool.query("SELECT email, name FROM users WHERE role IN ('medrep','team_lead') AND is_active = 1 ORDER BY name")).rows;
    await pool.end();
    const have = readTargets(targetsFile); const has = new Set(have.filter((r) => r.month === month).map((r) => r.email.toLowerCase()));
    const add = us.filter((u) => !has.has(u.email.toLowerCase())).map((u) => ({ email: u.email, month, target_php: '', name: u.name }));
    fs.mkdirSync(kpiDir, { recursive: true });
    fs.writeFileSync(targetsFile, toCsv(TCOLS, [...have, ...add]));
    console.log(`Added ${add.length} blank row(s) for ${month} to ${targetsFile}. Fill target_php, then run the export.`);
    return;
  }

  const month = args[0]; monthRange(month);
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(kpiDir, month);
  const result = await runReadOnly(process.env.DATABASE_URL, month, readTargets(targetsFile));
  writeFiles(result, outDir);
  console.log(`Export for ${month} written to ${outDir}`);
  console.log(`Booked (Finance rule): ${result.totalBooked} | in export: ${result.exportedBooked} | people: ${result.people.length}`);
  console.log('Compare the booked total with Finance > Sales Summary for the same month before sharing the files.');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { monthRange, buildExport, runReadOnly, parseCsv, toCsv, targetsFor, copyTargets, writeFiles };
