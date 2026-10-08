#!/usr/bin/env node
'use strict';

/**
 * Copies the LIVE people and sales structure into the LOCAL getmeds_dev, so the structure
 * update (Aaron sheet 12.13) can be rehearsed in User Management on localhost. Oct 6, 2026.
 *
 *   node scripts/dev-copy-people-from-live.js
 *
 * Reads live (DATABASE_URL from .env) in a READ ONLY session: users (never password hashes),
 * user_salespersons, manager_order_scope, sales_channels, sales_managers,
 * sales_channel_approvers, sales_territories, zoho_salespersons. No orders, customers or files.
 *
 * Writes ONLY to postgres://postgres@localhost:5432/getmeds_dev (refuses anything else):
 *  - every copied account gets the local password demo123;
 *  - the 6 demo accounts (admin@, manager@, medrep@, medrep2@, finance@, dispatch@getmeds.ph)
 *    are never changed; a live account with the same email is linked to the demo one;
 *  - the local sales structure and Zoho Salesperson list are replaced by live's;
 *  - safe to rerun: accounts already copied are refreshed, not duplicated.
 */

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const DEV_URL = 'postgres://postgres@localhost:5432/getmeds_dev';
const DEMO = new Set(['admin@getmeds.ph', 'manager@getmeds.ph', 'medrep@getmeds.ph', 'medrep2@getmeds.ph', 'finance@getmeds.ph', 'dispatch@getmeds.ph']);
const USER_COLS = ['name', 'email', 'role', 'is_active', 'is_test_account', 'approval_status', 'approved_at', 'approved_by', 'first_name', 'middle_name',
  'last_name', 'display_name', 'division', 'sub_division', 'team_lead_id', 'salesperson', 'created_at', 'updated_at', 'username', 'order_scope'];

async function readLive(url) {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 20000 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL statement_timeout = 15000');
    const q = async (sql) => (await c.query(sql)).rows;
    const data = {
      users: await q(`SELECT id, ${USER_COLS.join(', ')} FROM users ORDER BY id`),
      user_salespersons: await q('SELECT * FROM user_salespersons ORDER BY id'),
      manager_order_scope: await q('SELECT * FROM manager_order_scope ORDER BY id'),
      sales_channels: await q('SELECT * FROM sales_channels ORDER BY id'),
      sales_managers: await q('SELECT * FROM sales_managers ORDER BY id'),
      sales_channel_approvers: await q('SELECT * FROM sales_channel_approvers ORDER BY id'),
      sales_territories: await q('SELECT * FROM sales_territories ORDER BY id'),
      zoho_salespersons: await q('SELECT * FROM zoho_salespersons')
    };
    await c.query('ROLLBACK');
    return data;
  } finally { c.release(); await pool.end(); }
}

async function insertRow(c, table, row) {
  const cols = Object.keys(row);
  await c.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => row[k]));
}

async function writeDev(live) {
  const pool = new Pool({ connectionString: DEV_URL, max: 1 });
  const c = await pool.connect();
  const report = { created: 0, refreshed: 0, linkedToDemo: [] };
  try {
    const { rows: [db] } = await c.query('SELECT current_database() AS d');
    if (db.d !== 'getmeds_dev') throw new Error(`Refusing: connected to ${db.d}, not getmeds_dev`);
    await c.query('BEGIN');
    const hash = bcrypt.hashSync('demo123', 8);
    const devUsers = new Map((await c.query('SELECT id, LOWER(email) AS email FROM users')).rows.map((u) => [u.email, u.id]));
    const map = new Map(); // live user id -> dev user id

    // 1. accounts (user links filled in after every account exists)
    for (const u of live.users) {
      const email = String(u.email || '').toLowerCase();
      const fields = Object.fromEntries(USER_COLS.filter((k) => !['team_lead_id', 'approved_by'].includes(k)).map((k) => [k, u[k]]));
      if (DEMO.has(email) && devUsers.has(email)) { map.set(u.id, devUsers.get(email)); report.linkedToDemo.push(u.email); continue; }
      if (devUsers.has(email)) {
        const id = devUsers.get(email);
        const keys = Object.keys(fields);
        await c.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, password_hash = $${keys.length + 1} WHERE id = $${keys.length + 2}`,
          [...keys.map((k) => fields[k]), hash, id]);
        map.set(u.id, id); report.refreshed += 1;
      } else {
        const cols = Object.keys(fields);
        const r = await c.query(`INSERT INTO users (${cols.join(', ')}, password_hash) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
          [...cols.map((k) => fields[k]), hash]);
        map.set(u.id, r.rows[0].id); report.created += 1;
      }
    }
    const m = (id) => (id == null ? null : map.get(id) ?? null);
    for (const u of live.users) {
      if (DEMO.has(String(u.email || '').toLowerCase())) continue;
      await c.query('UPDATE users SET team_lead_id = $1, approved_by = $2 WHERE id = $3', [m(u.team_lead_id), m(u.approved_by), m(u.id)]);
    }

    // 2. each copied account's salespersons and manager access, replaced by live's
    const copied = [...new Set([...map.values()])].filter((id) => !live.users.some((u) => map.get(u.id) === id && DEMO.has(String(u.email).toLowerCase())));
    await c.query('DELETE FROM user_salespersons WHERE user_id = ANY($1)', [copied]);
    await c.query('DELETE FROM manager_order_scope WHERE user_id = ANY($1)', [copied]);
    for (const r of live.user_salespersons) {
      const uid = m(r.user_id);
      if (!copied.includes(uid)) continue;
      const { id, ...rest } = r;
      await insertRow(c, 'user_salespersons', { ...rest, user_id: uid, assigned_by: m(r.assigned_by) });
    }
    for (const r of live.manager_order_scope) {
      const uid = m(r.user_id);
      if (!copied.includes(uid)) continue;
      const { id, ...rest } = r;
      await insertRow(c, 'manager_order_scope', { ...rest, user_id: uid, created_by: m(r.created_by) });
    }

    // 3. the sales structure and the Zoho Salesperson list: replaced whole, live ids kept
    for (const t of ['sales_territories', 'sales_channel_approvers', 'sales_managers', 'sales_channels', 'zoho_salespersons']) await c.query(`DELETE FROM ${t}`);
    for (const r of live.sales_channels) await insertRow(c, 'sales_channels', { ...r, head_user_id: m(r.head_user_id), updated_by: m(r.updated_by) });
    for (const r of live.sales_managers) await insertRow(c, 'sales_managers', { ...r, user_id: m(r.user_id), updated_by: m(r.updated_by) });
    for (const r of live.sales_channel_approvers) await insertRow(c, 'sales_channel_approvers', { ...r, user_id: m(r.user_id), updated_by: m(r.updated_by) });
    for (const r of live.sales_territories) await insertRow(c, 'sales_territories', { ...r, updated_by: m(r.updated_by) });
    for (const r of live.zoho_salespersons) await insertRow(c, 'zoho_salespersons', r);
    for (const t of ['sales_channels', 'sales_managers', 'sales_channel_approvers', 'sales_territories', 'user_salespersons', 'manager_order_scope']) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`);
    }
    await c.query('COMMIT');
    return report;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); await pool.end(); }
}

async function main() {
  require('dotenv').config();
  const url = process.env.DATABASE_URL;
  if (!url || /localhost|127\.0\.0\.1/.test(url)) throw new Error('DATABASE_URL must point at the live database to copy FROM');
  const live = await readLive(url);
  console.log(`Read from live (read-only): ${live.users.length} accounts, ${live.user_salespersons.length} salesperson links, ` +
    `${live.manager_order_scope.length} access rules, ${live.sales_channels.length} channels, ${live.sales_managers.length} team leads, ` +
    `${live.sales_territories.length} territories, ${live.zoho_salespersons.length} Zoho names.`);
  const r = await writeDev(live);
  console.log(`Wrote to getmeds_dev: ${r.created} accounts created, ${r.refreshed} refreshed; password demo123 for all of them.`);
  if (r.linkedToDemo.length) console.log(`Live accounts with a demo email (left as the demo account): ${r.linkedToDemo.join(', ')}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
