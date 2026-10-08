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
 *   07-unplaced-people.csv  (people with no territory in the sales structure)
 * Targets are read from the kpi_targets table (set on the KPI page) when it exists; before
 * that, from <kpi folder>/targets.csv (email, month, target_php).
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
 *  - A person NOT placed in any channel through the sales structure (no territory) is placed by the
 *    DIVISION OF THEIR OWN ORDERS (the division carrying most of their booked pesos). The people
 *    file says which way each person was placed (channel_source) and 07-unplaced-people.csv lists
 *    everyone placed this way, so the team can map them into the structure properly later.
 *  - New customers and follow-ups on time: "Not tracked yet" (the live system has no data for them).
 *
 * SAFETY: one connection, a READ ONLY transaction (any write fails), a statement time limit,
 * one pass of a few queries, nothing scheduled, nothing written to the database.
 */

const fs = require('fs');
const path = require('path');

// The calculation itself lives in src/services/kpiService.js, shared with the in-app KPI
// page (/api/kpi) so the files and the page always give the same numbers.
const { monthRange, toCsv, parseCsv, readTargets, targetsFor, copyTargets, buildExport, COLS } = require('../src/services/kpiService');

function writeFiles(result, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, cols, rows) => fs.writeFileSync(path.join(dir, name), toCsv(cols, rows));
  w('01-people.csv', COLS.people, result.people);
  w('02-teams.csv', COLS.teams, result.teams);
  w('03-heads.csv', COLS.group('head'), result.heads);
  w('04-channels.csv', COLS.group('channel'), result.channels);
  w('05-routing.csv', COLS.routing, result.routing);
  w('06-checks.csv', COLS.checks, result.checks);
  w('07-unplaced-people.csv', COLS.unplaced, result.unplaced);
}

/**
 * Runs the export inside a READ ONLY transaction with a time limit.
 * targetRows: rows of targets.csv, or a function returning them, which is used only when the
 * kpi_targets table does not exist yet. Once it exists, targets come from the table (the same
 * ones the KPI page shows), so the file and the page cannot disagree.
 */
async function runReadOnly(connectionString, month, targetRows) {
  const { Pool } = require('pg');
  const hosted = !/localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({ connectionString, ssl: hosted ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 20000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 30000');
    let rows = targetRows;
    if (typeof targetRows === 'function') {
      const { rows: [t] } = await client.query("SELECT to_regclass('kpi_targets') IS NOT NULL AS has");
      rows = t.has ? undefined : targetRows();
    }
    const result = await buildExport(client, month, rows);
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
  const result = await runReadOnly(process.env.DATABASE_URL, month, () => readTargets(targetsFile));
  writeFiles(result, outDir);
  console.log(`Export for ${month} written to ${outDir}${result.partial ? ' (month still running — figures so far)' : ''}`);
  console.log(`Booked (Finance rule): ${result.totalBooked} | in export: ${result.exportedBooked} | people: ${result.people.length}`);
  console.log('Compare the booked total with Finance > Sales Summary for the same month before sharing the files.');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { monthRange, buildExport, runReadOnly, parseCsv, toCsv, targetsFor, copyTargets, writeFiles };
