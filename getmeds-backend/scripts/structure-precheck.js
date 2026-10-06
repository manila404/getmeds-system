#!/usr/bin/env node
'use strict';

/**
 * Read-only checks before the sales structure update (Aaron sheet 12.13). Oct 6, 2026.
 *
 *   node scripts/structure-precheck.js            run against DATABASE_URL, at a quiet hour
 *
 * Answers, from the live data, the questions the plan depends on:
 *   1. managers whose access is limited to a branch (they widen to the whole Division first)
 *   2. accounts carrying a sub-division (what a resent Zoho order would send today)
 *   3. whether Honey, Shiela, KZ, Mitzy and Khaly have Team Lead accounts, and their teams
 *   4. the sheet's Zoho names against the app's own copy of the Zoho Salesperson list
 *      (no call to Zoho; never creates a Salesperson)
 *   5. how many app-raised orders would get an empty Headquarter filled from the old branch
 *   6. territories that carry a target (they must keep it when renamed)
 *
 * SAFETY: one connection, a READ ONLY transaction (any write fails), a 15-second limit per
 * query, nothing scheduled. Writes a text report to getmeds-documents/structure/.
 */

const fs = require('fs');
const path = require('path');

const PEOPLE = ['honey', 'shiela', 'sheila', 'kz', 'mitzy', 'khaly'];
const ZOHO_NAMES = [
  'STC | TMC ORTIGAS', 'URO | TMC ORTIGAS', 'STC | SOUTH LUZON', 'STC | LAGUNA',
  'B&B | E RODRIGUEZ', 'B&B | E. RODRIGUEZ', 'B&B SOUTH LUZON', 'B&B | SOUTH LUZON',
  'HOSP | GENSAN', 'HOS | GENSAN', 'MT - 1', 'MT - 2'
];
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function runChecks(client) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  const { importedSql } = require('../src/services/orderOrigin');
  const out = [];
  const section = (title, rows, note = '') => out.push({ title, rows, note });

  section('1. Managers whose access is limited to a branch (widen to the whole Division first)',
    await q(`SELECT u.name, u.email, u.role, s.division, s.sub_division
               FROM manager_order_scope s JOIN users u ON u.id = s.user_id
              WHERE s.sub_division IS NOT NULL AND s.sub_division <> ''
              ORDER BY u.name, s.division`));

  section('2. Accounts with a sub-division (sent to Zoho when an order is resent today)',
    await q(`SELECT role, division, sub_division, COUNT(*)::int AS accounts
               FROM users WHERE sub_division IS NOT NULL AND sub_division <> ''
              GROUP BY role, division, sub_division ORDER BY division, sub_division, role`));

  const people = await q(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, tl.name AS their_team_lead,
            (SELECT COUNT(*)::int FROM users m WHERE m.team_lead_id = u.id) AS team_size
       FROM users u LEFT JOIN users tl ON tl.id = u.team_lead_id
      WHERE ${PEOPLE.map((_, i) => `u.name ILIKE $${i + 1}`).join(' OR ')}
      ORDER BY u.name`,
    PEOPLE.map((p) => `%${p}%`)
  );
  section('3. Honey, Shiela, KZ, Mitzy, Khaly: accounts, role and team size', people,
    'A person missing here, or not role team_lead, is reported to Aaron — no account is created.');

  const zoho = await q('SELECT name, is_active, removed_at FROM zoho_salespersons');
  const exact = new Map(zoho.map((z) => [z.name.trim().toLowerCase(), z]));
  const loose = new Map(zoho.map((z) => [squash(z.name), z]));
  section("4. The sheet's Zoho names against the app's copy of the Zoho Salesperson list",
    ZOHO_NAMES.map((n) => {
      const hit = exact.get(n.toLowerCase());
      const near = hit ? null : loose.get(squash(n));
      return {
        sheet_name: n,
        result: hit ? (hit.removed_at || !hit.is_active ? 'exact, but inactive/removed in Zoho' : 'exact match')
          : near ? `close match: "${near.name}"` : 'NOT in Zoho'
      };
    }), `Zoho list rows in the app: ${zoho.length}. Nothing here calls Zoho or creates a Salesperson.`);

  section('5. App-raised orders whose empty Headquarter would be filled from the old branch',
    await q(`SELECT o.division, o.sub_division AS old_branch, COUNT(*)::int AS orders
               FROM orders o
              WHERE NOT (${importedSql('o')})
                AND (o.headquarter IS NULL OR o.headquarter = '')
                AND o.sub_division IS NOT NULL AND o.sub_division <> ''
              GROUP BY o.division, o.sub_division ORDER BY orders DESC`),
    'Only these rows would change (Headquarter only; Sub-division is left alone). A backup of them is saved first.');

  section('6. Territories with a target (keep it when renamed)',
    await q(`SELECT c.name AS channel, m.name AS team_lead, t.zoho_salesperson, t.hq, t.target_month, t.target_amount
               FROM sales_territories t JOIN sales_managers m ON m.id = t.manager_id JOIN sales_channels c ON c.id = m.channel_id
              WHERE COALESCE(t.target_amount, 0) > 0
              ORDER BY c.name, m.name, t.zoho_salesperson`));
  return out;
}

function toText(sections, when) {
  const lines = [`Sales structure pre-check (read-only) — ${when}`, ''];
  for (const s of sections) {
    lines.push(s.title, '-'.repeat(Math.min(s.title.length, 100)));
    if (!s.rows.length) lines.push('(none)');
    else {
      const cols = Object.keys(s.rows[0]);
      lines.push(cols.join(' | '));
      for (const r of s.rows) lines.push(cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(' | '));
      lines.push(`(${s.rows.length} row${s.rows.length === 1 ? '' : 's'})`);
    }
    if (s.note) lines.push(`Note: ${s.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  require('dotenv').config();
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const hosted = !/localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, ssl: hosted ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 20000 });
  const client = await pool.connect();
  let sections;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 15000');
    sections = await runChecks(client);
    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }

  const when = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' Manila';
  const text = toText(sections, when);
  const dir = path.resolve(__dirname, '../../../getmeds-documents/structure');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `precheck-${when.slice(0, 10)}${hosted ? '' : '-local'}.txt`);
  fs.writeFileSync(file, text);
  console.log(text);
  console.log(`Saved to ${file}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { runChecks, toText };
