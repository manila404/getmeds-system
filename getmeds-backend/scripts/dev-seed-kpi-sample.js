#!/usr/bin/env node
'use strict';

/**
 * Sample KPI data for the LOCAL test database only, so the Sales KPIs page, My Own KPI and
 * My Team KPI can be tried on localhost with realistic numbers. Oct 8, 2026.
 *
 *   node scripts/dev-seed-kpi-sample.js            add (or re-add) the sample orders and targets
 *   node scripts/dev-seed-kpi-sample.js --remove   remove everything this script added
 *
 * REFUSES anything but the local database getmeds_dev. Works on the people copied from live
 * (scripts/dev-copy-people-from-live.js) and the structure set up by scripts/structure-apply.js.
 *
 * What it adds, all clearly labelled:
 *  - orders GM-DEVKPI-<n> in September and October 2026 (October up to today), owned by
 *    MedReps across RX, B2C, BID, CLIDP, Telesales and HOS; about half entered by their Leader
 *    (raised_by), most Finance-verified (= booked), some still waiting, a few put on hold;
 *  - monthly targets for those people (kpi_targets), logged as 'Sample data (localhost)'.
 * Rerunning removes the previous sample first, so it never doubles up.
 */

const { Pool } = require('pg');

const DEV_URL = 'postgres://postgres@localhost:5432/getmeds_dev';
const TAG = 'GM-DEVKPI-';
const WHO = 'Sample data (localhost)';

// owner email -> { by: leader email who often enters their orders, div, sub }
const REPS = {
  'taftbnb@getmeds.ph': { by: 'care20@getmeds.ph', div: 'B&B', sub: 'MD TELESALES' },
  'pgh2@getmeds.ph': { by: 'care20@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'davao@getmeds.ph': { by: 'care19@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'cebustc@getmeds.ph': { by: 'care19@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'urocebu@getmeds.ph': { by: 'care19@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'cavite2@getmeds.ph': { by: 'care21@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'urosl@getmeds.ph': { by: 'care21@getmeds.ph', div: 'URO', sub: 'MD TELESALES' },
  'pabaza2@getmeds.ph': { by: 'care22@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'stc.qc@getmeds.ph': { by: 'care22@getmeds.ph', div: 'STC', sub: 'MD TELESALES' },
  'qc2@getmeds.ph': { by: 'care22@getmeds.ph', div: 'B&B', sub: 'MD TELESALES' },
  'care23@getmeds.ph': { by: 'sales9@getmeds.ph', div: 'B2C', sub: 'MD TELESALES' },
  'care16@getmeds.ph': { by: 'sales9@getmeds.ph', div: 'B2C', sub: 'MD TELESALES' },
  'gov4@getmeds.ph': { by: 'care7@getmeds.ph', div: 'BID', sub: 'BID' },
  'getmeds.sc4@gmail.com': { by: 'care7@getmeds.ph', div: 'BID', sub: 'BID' },
  'sales2@getmeds.ph': { by: null, div: 'CLIDP', sub: 'CLIDP' },
  'sales6@getmeds.ph': { by: null, div: 'CLIDP', sub: 'CLIDP' },
  'care24@getmeds.ph': { by: 'sales3@getmeds.ph', div: 'TeleSales', sub: 'TeleSales' },
  'sales27@getmeds.ph': { by: 'sales3@getmeds.ph', div: 'TeleSales', sub: 'TeleSales' },
  'sales24@getmeds.ph': { by: 'sales3@getmeds.ph', div: 'TeleSales', sub: 'TeleSales' },
  'pgh@getmeds.ph': { by: 'sales4@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'laspinas@getmeds.ph': { by: 'sales4@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'palawan@getmeds.ph': { by: 'sales4@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'sales18@getmeds.ph': { by: 'sales4@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'cebusouth@getmeds.ph': { by: 'sales3@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'cebunorth@getmeds.ph': { by: 'sales3@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'iloilo@getmeds.ph': { by: 'sales3@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' },
  'cl@getmeds.ph': { by: 'sales10@getmeds.ph', div: 'HOS', sub: 'HOSPITAL' }
};
// Leaders and team leads with a few orders of their own
const OWN = ['care20@getmeds.ph', 'care19@getmeds.ph', 'care7@getmeds.ph', 'sales4@getmeds.ph', 'sales9@getmeds.ph'];

// A small seeded random, so every run gives the same sample
let seed = 20261008;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const between = (a, b) => Math.round((a + rnd() * (b - a)) / 100) * 100;

async function remove(c) {
  const ids = (await c.query(`SELECT id FROM orders WHERE getmeds_order_id LIKE $1`, [`${TAG}%`])).rows.map((r) => r.id);
  for (const t of ['order_events', 'order_items', 'notifications']) await c.query(`DELETE FROM ${t} WHERE order_id = ANY($1)`, [ids]);
  await c.query('DELETE FROM orders WHERE id = ANY($1)', [ids]);
  const sampled = (await c.query('SELECT DISTINCT user_id, month FROM kpi_target_changes WHERE changed_by_name = $1', [WHO])).rows;
  for (const r of sampled) await c.query('DELETE FROM kpi_targets WHERE user_id = $1 AND month = $2 AND set_by IS NULL', [r.user_id, r.month]);
  await c.query('DELETE FROM kpi_target_changes WHERE changed_by_name = $1', [WHO]);
  return ids.length;
}

async function main() {
  const pool = new Pool({ connectionString: DEV_URL, max: 1 });
  const c = await pool.connect();
  try {
    const { rows: [db] } = await c.query('SELECT current_database() AS d');
    if (db.d !== 'getmeds_dev') throw new Error(`Refusing: connected to ${db.d}, not getmeds_dev`);
    await c.query('BEGIN');
    const removed = await remove(c);
    if (process.argv.includes('--remove')) {
      await c.query('COMMIT');
      console.log(`Removed ${removed} sample orders and the sample targets from getmeds_dev.`);
      return;
    }
    const users = new Map((await c.query('SELECT id, email, name FROM users WHERE is_active = 1')).rows.map((u) => [u.email.toLowerCase(), u]));
    const customer = (await c.query('SELECT id FROM customers WHERE is_active = 1 ORDER BY id LIMIT 1')).rows[0];
    if (!customer) throw new Error('No customer in getmeds_dev: run node scripts/dev-local-db.js first');

    const today = new Date();
    const days = (month) => (month === '2026-09' ? 30 : Math.max(1, Math.min(31, Number(new Date(today.getTime() + 8 * 3600 * 1000).toISOString().slice(8, 10)) - 1)));
    let n = 0, bookedN = 0, held = 0, waiting = 0, skipped = [];
    const add = async (ownerEmail, byEmail, div, sub, month) => {
      const owner = users.get(ownerEmail);
      if (!owner) { skipped.push(ownerEmail); return; }
      const by = byEmail && rnd() < 0.6 ? users.get(byEmail) : null; // about 6 in 10 entered by their Leader
      const day = 1 + Math.floor(rnd() * days(month));
      const at = new Date(`${month}-${String(day).padStart(2, '0')}T02:00:00.000Z`);
      at.setUTCHours(1 + Math.floor(rnd() * 8));
      const total = between(8000, 160000);
      const roll = rnd();
      const status = roll < 0.12 ? 'on_hold' : roll < 0.25 ? 'pending_management_approval' : roll < 0.6 ? 'ready_for_dispatch' : 'completed';
      n += 1;
      const ref = `${TAG}${String(n).padStart(3, '0')}`;
      const id = (await c.query(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status, customer_type, total_amount,
                             delivery_address, submitted_at, created_at, updated_at, division, sub_division, salesperson)
         VALUES ($1, $2, $3, $4, $5, 'credit', $6, 'Sample address (localhost)', $7, $7, $7, $8, $9, NULL) RETURNING id`,
        [ref, customer.id, owner.id, by ? by.id : null, status, total, at.toISOString(), div, sub]
      )).rows[0].id;
      const ev = (type, minutes, oldS = null, newS = null) =>
        c.query('INSERT INTO order_events (order_id, event_type, old_status, new_status, created_at) VALUES ($1, $2, $3, $4, $5)',
          [id, type, oldS, newS, new Date(at.getTime() + minutes * 60000).toISOString()]);
      await ev('ORDER_CREATED', 0);
      if (status === 'pending_management_approval') { waiting += 1; return; }
      await ev('MANAGEMENT_APPROVED', 60);
      if (status === 'on_hold') { held += 1; await ev('FINANCE_REJECTED', 180, 'ready_for_finance_verified', 'on_hold'); return; }
      await ev('FINANCE_VERIFIED', 240); bookedN += 1;
      if (status === 'completed') await ev('ORDER_COMPLETED', 60 * 48);
    };

    for (const month of ['2026-09', '2026-10']) {
      for (const [email, r] of Object.entries(REPS)) {
        const count = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < count; i++) await add(email, r.by, r.div, r.sub, month);
      }
      for (const email of OWN) await add(email, null, 'STC', 'MD TELESALES', month);
    }

    // Targets for the same people, both months
    let targets = 0;
    for (const month of ['2026-09', '2026-10']) {
      for (const email of [...Object.keys(REPS), ...OWN]) {
        const u = users.get(email);
        if (!u) continue;
        const t = OWN.includes(email) ? between(80000, 150000) : between(150000, 400000);
        const ins = await c.query(
          `INSERT INTO kpi_targets (user_id, month, target_php, set_by) VALUES ($1, $2, $3, NULL)
           ON CONFLICT (user_id, month) DO NOTHING RETURNING id`, [u.id, month, t]);
        if (!ins.rows.length) continue; // a target someone set by hand stays
        await c.query(`INSERT INTO kpi_target_changes (user_id, month, old_target_php, new_target_php, source, changed_by_name)
                       VALUES ($1, $2, NULL, $3, 'set', $4)`, [u.id, month, t, WHO]);
        targets += 1;
      }
    }
    await c.query('COMMIT');
    console.log(`Sample added to getmeds_dev: ${n} orders (${bookedN} booked, ${waiting} waiting for approval, ${held} on hold), ${targets} targets.`);
    if (removed) console.log(`(The previous sample, ${removed} orders, was removed first.)`);
    if (skipped.length) console.log(`Not found, skipped: ${[...new Set(skipped)].join(', ')}`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
