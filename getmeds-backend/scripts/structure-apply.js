#!/usr/bin/env node
'use strict';

/**
 * Sales structure update, step 1: the people setup (Aaron sheet 12.13). Oct 6, 2026.
 *
 *   node scripts/structure-apply.js                 dry run against the LOCAL getmeds_dev: lists every change
 *   node scripts/structure-apply.js --apply         applies them to the LOCAL getmeds_dev
 *
 * Live is deliberately not supported yet: it is step 5 of the plan, after Aaron has checked
 * the result on localhost, and needs his explicit OK.
 *
 * What it sets, from STRUCTURE UPDATED.xlsx (getmeds-documents/structure/territories-from-sheet.csv)
 * and the managers' notes (Javed, Subir, Vanessa):
 *  1. territory aliases where Zoho spells the name differently (HOS I PALAWAN, BID HAZEL...), the
 *     3 renamed territories, HOS territories moved between leaders, and each territory's person,
 *     headquarter and vacancy as the sheet has them;
 *  2. the Leader role (team_lead) for Shiela, Benjie (KZ), Mitzy, Khaly, Daniel, Julius and Jimmy;
 *  2b. the title shown on each leader's account (Manager / Team Leader / Leader);
 *  3. each account's Team Lead: MedRep -> their Leader, Leader -> Team Leader / Manager,
 *     Honey -> Javed, Jessa -> Subir.
 * Never creates an account and never touches orders, customers, Zoho or targets.
 * People with no account (Jimlord, Ken, Mhalou, Charle, Mani Mishra) are listed, not invented.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DEV_URL = 'postgres://postgres@localhost:5432/getmeds_dev';
const SHEET = path.resolve(__dirname, '../../../getmeds-documents/structure/territories-from-sheet.csv');
const OUT = path.resolve(__dirname, '../../../getmeds-documents/structure');

// The people, by account email (confirmed by Aaron, Oct 6, 2026). null = no account yet.
const ACCOUNT = {
  JAVED: 'sales1@getmeds.ph', HONEY: 'sales9@getmeds.ph', SUBIR: 'sales5@getmeds.ph', VANESSA: 'sales3@getmeds.ph',
  'JESSA DOMINO': 'sales5@2mginc.com', SAURAV: 'saurav@getmeds.ph',
  SHIELA: 'care20@getmeds.ph', KZ: 'care19@getmeds.ph', MITZY: 'care21@getmeds.ph', KHALY: 'care22@getmeds.ph',
  DANIEL: 'sales4@getmeds.ph', JULIUS: 'sales10@getmeds.ph', JIMMY: 'care7@getmeds.ph',
  JIMLORD: null, KEN: null, MHALOU: null
};
// Accounts that become Leaders (role team_lead)
const MAKE_LEADER = ['SHIELA', 'KZ', 'MITZY', 'KHALY', 'DANIEL', 'JULIUS', 'JIMMY'];
// Titles shown on the accounts (users.sales_title; display only)
const TITLE = {
  JAVED: 'Manager', SUBIR: 'Manager', VANESSA: 'Manager', MHALOU: 'Manager',
  HONEY: 'Team Leader', 'JESSA DOMINO': 'Team Leader',
  SHIELA: 'Leader', KZ: 'Leader', MITZY: 'Leader', KHALY: 'Leader', JIMMY: 'Leader',
  JIMLORD: 'Leader', DANIEL: 'Leader', SAURAV: 'Leader', JULIUS: 'Leader', KEN: 'Leader'
};
// Who each leader reports to
const LEADER_REPORTS_TO = {
  HONEY: 'JAVED', SHIELA: 'HONEY', KZ: 'HONEY', MITZY: 'HONEY', KHALY: 'HONEY',
  'JESSA DOMINO': 'SUBIR', JIMMY: 'SUBIR',
  JIMLORD: 'VANESSA', DANIEL: 'VANESSA', SAURAV: 'VANESSA', JULIUS: 'VANESSA', KEN: 'VANESSA'
};
// Territory whose real Zoho name differs from the territory's own name
const ZOHO_ALIAS = {
  'HOS | PALAWAN': 'HOS I PALAWAN', 'HOS | GENSAN': 'HOS I GENSAN', 'HOS | LJ': 'HOS | LAS PINAS',
  'HOS | PARANAQUE': 'HOS | Ana Mae Otucan', 'BID | HAZEL': 'BID HAZEL', 'BID | ANGEL': 'BID| ANGEL'
};
// Renamed territories: current name -> name in the sheet (the old name is kept as the alias)
const RENAME = { 'STC | ORTIGAS VACANT': 'STC | TMC ORTIGAS', 'URO | ORTIGAS VACANT': 'URO | TMC ORTIGAS', 'STC | LAGUNA': 'STC | SOUTH LUZON' };

const sq = (s) => String(s || '').toUpperCase().replace(/^HOSP\b/, 'HOS').replace(/[^A-Z0-9]/g, '');

function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false; t = t.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const h = rows.shift();
  return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] || ''])));
}

/** The leader a sheet row's person reports to, as a key of ACCOUNT. */
function leaderFor(row) {
  if (row.channel === 'RX BUSINESS') return { SHIELA: 'SHIELA', 'BENJIE (KZ)': 'KZ', KZ: 'KZ', MITZY: 'MITZY', KHALY: 'KHALY' }[String(row.team_lead).toUpperCase()] || null;
  if (row.channel === 'MD TELESALES') return 'HONEY';
  if (row.channel === 'B2B') return 'JESSA DOMINO';
  if (row.channel === 'BID') return 'JIMMY';
  if (row.channel === 'CLIDP') return 'SUBIR';
  if (row.channel === 'TELESALES') return 'VANESSA';
  if (row.channel === 'MT') return 'MHALOU';
  if (row.channel === 'HOS') return String(row.team_lead).toUpperCase();
  return null;
}

async function plan(c) {
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const users = await q('SELECT id, name, email, role, is_active, team_lead_id FROM users');
  const byEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
  const byId = new Map(users.map((u) => [u.id, u]));
  const links = await q('SELECT user_id, salesperson, is_primary FROM user_salespersons');
  const terrs = await q(`SELECT t.id, t.zoho_salesperson, t.zoho_alias, t.person_label, t.hq, t.is_vacant, t.manager_id, m.name AS manager, c.name AS channel
                           FROM sales_territories t JOIN sales_managers m ON m.id = t.manager_id JOIN sales_channels c ON c.id = m.channel_id`);
  const managers = await q('SELECT m.id, m.name, c.name AS channel FROM sales_managers m JOIN sales_channels c ON c.id = m.channel_id');
  const acct = (key) => (ACCOUNT[key] ? byEmail.get(ACCOUNT[key]) || null : null);
  const leaderIds = new Set(Object.values(ACCOUNT).filter(Boolean).map((e) => byEmail.get(e)?.id).filter(Boolean));

  const changes = { territories: [], roles: [], teamLeads: [], titles: [], missing: [], notes: [] };
  const hasTitle = (await q("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'sales_title'")).length > 0;
  const titles = hasTitle ? new Map((await q('SELECT id, sales_title FROM users')).map((r) => [r.id, r.sales_title])) : new Map();
  if (!hasTitle) changes.notes.push('users.sales_title does not exist yet (run npm run migrate:pg): titles skipped');

  // 1. territories
  const tKey = new Map(); for (const t of terrs) { tKey.set(sq(t.zoho_salesperson), t); if (t.zoho_alias) tKey.set(sq(t.zoho_alias), t); }
  const sheet = parseCsv(fs.readFileSync(SHEET, 'utf8'));
  const rows = [];
  for (const s of sheet) {
    const sheetName = String(s.zoho_name).replace(/\s+\|/g, ' |').replace(/\|\s+/g, '| ').replace(/\s+/g, ' ').trim();
    const renamedFrom = Object.keys(RENAME).find((k) => sq(RENAME[k]) === sq(sheetName));
    const t = tKey.get(sq(sheetName)) || (renamedFrom && tKey.get(sq(renamedFrom)));
    if (!t) { changes.notes.push(`Sheet row ${s.sheet_row} ${sheetName}: no territory found, not added`); continue; }
    const vacant = /vacant/i.test(s.salesperson);
    // Labels keep their "<division> | <person>" form; only the person changes, and only when it differs
    const prefix = String(t.person_label || t.zoho_salesperson).split('|')[0].trim();
    const current = String(t.person_label || '').split('|').slice(1).join('|').trim();
    const person = vacant ? 'VACANT' : s.salesperson;
    const label = sq(current).includes(sq(person)) || (sq(person) && sq(current) && sq(person).includes(sq(current)) && !vacant && !/VACANT/i.test(current))
      ? t.person_label : `${prefix} | ${person}`;
    const renameTo = RENAME[t.zoho_salesperson]; // only while the territory still has its old name
    const want = {
      zoho_salesperson: renameTo || t.zoho_salesperson,
      zoho_alias: ZOHO_ALIAS[t.zoho_salesperson] || ZOHO_ALIAS[sheetName] || (renameTo ? t.zoho_salesperson : t.zoho_alias),
      person_label: label, hq: s.headquarter || t.hq, is_vacant: vacant
    };
    // HOS territories follow the sheet's leader
    if (s.channel === 'HOS') {
      const m = managers.find((x) => x.channel === 'HOSP' && sq(x.name) === sq(s.team_lead));
      if (m && m.id !== t.manager_id) want.manager_id = m.id;
    }
    const diff = Object.entries(want).filter(([k, v]) => String(t[k] ?? '') !== String(v ?? ''));
    if (diff.length) changes.territories.push({ id: t.id, territory: t.zoho_salesperson, set: Object.fromEntries(diff), before: Object.fromEntries(diff.map(([k]) => [k, t[k]])) });
    rows.push({ s, t: { ...t, ...want }, vacant });
  }

  // 2. Leader role
  for (const k of MAKE_LEADER) {
    const u = acct(k);
    if (!u) { changes.missing.push(`${k}: no account`); continue; }
    if (u.role !== 'team_lead') changes.roles.push({ id: u.id, person: u.name, email: u.email, from: u.role, to: 'team_lead' });
  }
  // 2b. titles
  if (hasTitle) {
    for (const [k, title] of Object.entries(TITLE)) {
      const u = acct(k);
      if (u && titles.get(u.id) !== title) changes.titles.push({ id: u.id, person: u.name, from: titles.get(u.id) || '(none)', to: title });
    }
  }
  // 3. Team Lead settings
  const setTl = (u, leaderKey, why) => {
    const lead = acct(leaderKey);
    if (!lead) { changes.missing.push(`${u.name} should report to ${leaderKey}, who has no account (left as is)`); return; }
    if (lead.id === u.id) return;
    if (u.team_lead_id !== lead.id) changes.teamLeads.push({ id: u.id, person: u.name, email: u.email, from: byId.get(u.team_lead_id)?.name || '(none)', to: lead.name, why });
  };
  for (const [k, to] of Object.entries(LEADER_REPORTS_TO)) {
    const u = acct(k);
    if (!u) { if (ACCOUNT[k] === null) changes.missing.push(`${k}: no account`); continue; }
    setTl(u, to, 'leader');
  }
  // How well an account's name matches the sheet's person (first names and nicknames differ, so loosely)
  const nameScore = (u, person) => {
    const words = String(person || '').toUpperCase().split(/\s+/).filter((w) => w.length >= 3);
    const name = String(u.name || '').toUpperCase();
    return words.filter((w) => name.includes(w)).length;
  };
  const medreps = users.filter((u) => u.is_active && u.role === 'medrep' && !leaderIds.has(u.id));
  const seen = new Set();
  for (const { s, t, vacant } of rows) {
    if (vacant) continue;
    const ownLeader = Object.entries(ACCOUNT).find(([k]) => sq(k) === sq(s.salesperson));
    if (ownLeader) continue; // a Leader's own territory (e.g. BID | JIMMY)
    const keys = new Set([sq(t.zoho_salesperson), sq(t.zoho_alias)].filter(Boolean));
    const holders = links.filter((l) => keys.has(sq(l.salesperson))).map((l) => ({ ...byId.get(l.user_id), primary: Number(l.is_primary) === 1 }))
      .filter((u) => u.id && u.is_active && !leaderIds.has(u.id) && !seen.has(u.id));
    holders.sort((a, b) => nameScore(b, s.salesperson) - nameScore(a, s.salesperson) || Number(b.primary) - Number(a.primary));
    let u = holders[0];
    if (!u || nameScore(u, s.salesperson) === 0) {
      // No Zoho link matches the person: look for the person by name instead, and say so.
      const byName = medreps.filter((x) => !seen.has(x.id) && nameScore(x, s.salesperson) > 0 &&
        nameScore(x, s.salesperson) === String(s.salesperson).split(/\s+/).filter((w) => w.length >= 3).length);
      if (byName.length === 1) {
        const held = links.filter((l) => l.user_id === byName[0].id).map((l) => l.salesperson).join('; ') || 'no Zoho name';
        changes.notes.push(`${byName[0].name}: matched by name to ${t.zoho_salesperson}, but their Zoho link is ${held} (left as is; Aaron to decide)`);
        u = byName[0];
      } else if (!u) {
        changes.missing.push(`${s.salesperson} (${t.zoho_salesperson}): no account found`);
        continue;
      }
    }
    seen.add(u.id);
    const leader = leaderFor(s);
    if (leader) setTl(u, leader, `${s.channel} ${t.zoho_salesperson}`);
  }
  return changes;
}

async function apply(c, ch) {
  for (const t of ch.territories) {
    const keys = Object.keys(t.set);
    await c.query(`UPDATE sales_territories SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = $${keys.length + 1} WHERE id = $${keys.length + 2}`,
      [...keys.map((k) => t.set[k]), new Date().toISOString(), t.id]);
  }
  for (const r of ch.roles) await c.query("UPDATE users SET role = 'team_lead', updated_at = $1 WHERE id = $2", [new Date().toISOString(), r.id]);
  for (const r of ch.titles) await c.query('UPDATE users SET sales_title = $1, updated_at = $2 WHERE id = $3', [r.to, new Date().toISOString(), r.id]);
  for (const r of ch.teamLeads) {
    const lead = (await c.query('SELECT id FROM users WHERE name = $1 AND is_active = 1 LIMIT 1', [r.to])).rows[0];
    await c.query('UPDATE users SET team_lead_id = $1, updated_at = $2 WHERE id = $3', [lead.id, new Date().toISOString(), r.id]);
  }
}

async function main() {
  const doApply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: DEV_URL, max: 1 });
  const c = await pool.connect();
  try {
    const { rows: [db] } = await c.query('SELECT current_database() AS d');
    if (db.d !== 'getmeds_dev') throw new Error(`Refusing: connected to ${db.d}, not getmeds_dev`);
    await c.query('BEGIN');
    const ch = await plan(c);
    const lines = [];
    lines.push(`Territories to update: ${ch.territories.length}`);
    for (const t of ch.territories) lines.push(`  ${t.territory}: ${Object.entries(t.set).map(([k, v]) => `${k} ${JSON.stringify(t.before[k])} -> ${JSON.stringify(v)}`).join('; ')}`);
    lines.push(`Accounts becoming Leaders (role team_lead): ${ch.roles.length}`);
    for (const r of ch.roles) lines.push(`  ${r.person} <${r.email}>: ${r.from} -> team_lead`);
    lines.push(`Titles to set: ${ch.titles.length}`);
    for (const r of ch.titles) lines.push(`  ${r.person}: ${r.from} -> ${r.to}`);
    lines.push(`Team Lead settings to change: ${ch.teamLeads.length}`);
    for (const r of ch.teamLeads) lines.push(`  ${r.person} <${r.email}>: ${r.from} -> ${r.to}   (${r.why})`);
    lines.push(`Not done (needs an account or a decision): ${ch.missing.length}`);
    for (const m of [...new Set(ch.missing)]) lines.push(`  ${m}`);
    for (const n of ch.notes) lines.push(`  note: ${n}`);
    console.log(lines.join('\n'));
    fs.writeFileSync(path.join(OUT, `structure-apply-${doApply ? 'applied' : 'dry-run'}-local.txt`), lines.join('\n'));
    if (doApply) { await apply(c, ch); await c.query('COMMIT'); console.log('\nApplied to getmeds_dev.'); }
    else { await c.query('ROLLBACK'); console.log('\nDry run only: nothing changed. Add --apply to apply to getmeds_dev.'); }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
