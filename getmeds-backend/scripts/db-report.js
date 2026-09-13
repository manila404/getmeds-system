#!/usr/bin/env node
/**
 * Where the database's 500 MB is going, and how long it lasts.
 *
 * Sep 12, 2026. Supabase's free tier caps the database at 500 MB and the
 * instance at Nano. The dashboard shows one number — "273 / 500 MB" — which is
 * enough to worry about and not enough to act on. This prints the same figure
 * broken down by table, names the indexes nothing has ever read, and projects
 * the date the cap is reached from the actual order rate rather than a guess.
 *
 * Read-only. Safe to run against production at any time, and cheap enough to
 * run monthly — every query below reads catalogue statistics, not table data.
 *
 *   node scripts/db-report.js
 *   node scripts/db-report.js --json     machine-readable, for a scheduled job
 *
 * The companion script, db-reclaim.js, acts on what this finds.
 */

require('dotenv').config();
const db = require('../src/db/pg');

const FREE_TIER_LIMIT_MB = Number(process.env.DB_SIZE_LIMIT_MB || 500);
const JSON_OUT = process.argv.includes('--json');

const mb = (bytes) => Number(bytes) / 1048576;
const fmt = (n, d = 1) => n.toFixed(d);

async function main() {
  // ── 1. total ────────────────────────────────────────────────────────────
  const total = await db
    .prepare('SELECT pg_database_size(current_database()) AS bytes')
    .get();
  const usedMb = mb(total.bytes);
  const freeMb = FREE_TIER_LIMIT_MB - usedMb;

  // ── 2. by table ─────────────────────────────────────────────────────────
  const tables = await db
    .prepare(
      `SELECT c.relname                          AS tbl,
              pg_total_relation_size(c.oid)      AS total_bytes,
              pg_relation_size(c.oid)            AS heap_bytes,
              pg_indexes_size(c.oid)             AS index_bytes,
              COALESCE(s.n_live_tup, 0)          AS live,
              COALESCE(s.n_dead_tup, 0)          AS dead
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC`
    )
    .all();

  // ── 3. indexes nothing has read ─────────────────────────────────────────
  //
  // idx_scan counts since the stats were last reset, which is reported below
  // so a short window is not mistaken for "never used". A UNIQUE index is
  // excluded whatever its scan count: it is a constraint first and an access
  // path second, and dropping it changes what the database will accept.
  const unused = await db
    .prepare(
      `SELECT s.relname AS tbl, s.indexrelname AS idx,
              pg_relation_size(s.indexrelid) AS bytes
         FROM pg_stat_user_indexes s
         JOIN pg_index i ON i.indexrelid = s.indexrelid
        WHERE s.schemaname = 'public'
          AND s.idx_scan = 0
          AND NOT i.indisprimary
          AND NOT i.indisunique
        ORDER BY pg_relation_size(s.indexrelid) DESC`
    )
    .all();

  const statsAge = await db
    .prepare(
      `SELECT stats_reset,
              EXTRACT(DAY FROM now() - stats_reset)::int AS days
         FROM pg_stat_database WHERE datname = current_database()`
    )
    .get();

  // ── 4. growth, from the real order rate ─────────────────────────────────
  //
  // Measured over 90 days rather than 30: one slow month would otherwise
  // project a comfortable runway that does not exist.
  const rate = await db
    .prepare(
      `SELECT COUNT(*)::int AS n
         FROM orders
        WHERE created_at::timestamptz > now() - interval '90 days'`
    )
    .get();
  const ordersPerMonth = rate.n / 3;

  const orderRows = await db.prepare('SELECT COUNT(*)::int AS n FROM orders').get();
  const ordersTable = tables.find((t) => t.tbl === 'orders');
  const eventsTable = tables.find((t) => t.tbl === 'order_events');

  // Bytes an order costs all-in: its own row plus the events it accumulates.
  // Customers and products grow on their own curve and are left out rather
  // than smeared across the order count, which would flatter the projection.
  const perOrderBytes =
    orderRows.n > 0
      ? (Number(ordersTable?.total_bytes || 0) + Number(eventsTable?.total_bytes || 0)) / orderRows.n
      : 0;

  const monthlyGrowthMb = mb(perOrderBytes * ordersPerMonth);
  const monthsLeft = monthlyGrowthMb > 0 ? freeMb / monthlyGrowthMb : Infinity;

  const deadTotal = tables.reduce((s, t) => s + Number(t.dead), 0);
  const unusedMb = unused.reduce((s, u) => s + mb(u.bytes), 0);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          usedMb: Number(fmt(usedMb)),
          limitMb: FREE_TIER_LIMIT_MB,
          pctUsed: Number(fmt((usedMb / FREE_TIER_LIMIT_MB) * 100)),
          monthlyGrowthMb: Number(fmt(monthlyGrowthMb, 2)),
          monthsLeft: Number.isFinite(monthsLeft) ? Number(fmt(monthsLeft)) : null,
          ordersPerMonth: Math.round(ordersPerMonth),
          deadTuples: deadTotal,
          unusedIndexMb: Number(fmt(unusedMb, 2)),
          tables: tables.map((t) => ({
            table: t.tbl,
            totalMb: Number(fmt(mb(t.total_bytes), 2)),
            rows: Number(t.live),
            dead: Number(t.dead),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const bar = (pct) => {
    const w = 34;
    const on = Math.min(w, Math.round((pct / 100) * w));
    return '[' + '#'.repeat(on) + '.'.repeat(w - on) + ']';
  };

  console.log('');
  console.log('  GETMEDS DATABASE REPORT');
  console.log('  ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '  ·  Supabase free tier');
  console.log('  ' + '='.repeat(62));
  console.log('');
  console.log(`  Used   ${fmt(usedMb)} MB of ${FREE_TIER_LIMIT_MB} MB   ${bar((usedMb / FREE_TIER_LIMIT_MB) * 100)} ${fmt((usedMb / FREE_TIER_LIMIT_MB) * 100)}%`);
  console.log(`  Free   ${fmt(freeMb)} MB`);
  console.log('');

  console.log('  WHERE IT IS GOING');
  console.log('  ' + '-'.repeat(62));
  console.log(
    '  ' + 'TABLE'.padEnd(20) + 'TOTAL'.padStart(9) + 'HEAP'.padStart(9) + 'INDEX'.padStart(9) + 'ROWS'.padStart(9) + 'DEAD'.padStart(8)
  );
  for (const t of tables.slice(0, 10)) {
    if (mb(t.total_bytes) < 0.1) continue;
    console.log(
      '  ' +
        String(t.tbl).padEnd(20) +
        (fmt(mb(t.total_bytes)) + ' MB').padStart(9) +
        (fmt(mb(t.heap_bytes)) + ' MB').padStart(9) +
        (fmt(mb(t.index_bytes)) + ' MB').padStart(9) +
        String(t.live).padStart(9) +
        String(t.dead).padStart(8)
    );
  }
  console.log('');

  console.log('  RECLAIMABLE NOW');
  console.log('  ' + '-'.repeat(62));
  console.log(`  Dead rows awaiting VACUUM ......... ${deadTotal.toLocaleString()}`);
  console.log(`  Indexes never read ............... ${fmt(unusedMb, 2)} MB across ${unused.length}`);
  if (unused.length) {
    for (const u of unused) {
      if (mb(u.bytes) < 0.05) continue;
      console.log(`      ${String(u.idx).padEnd(38)} ${(fmt(mb(u.bytes), 2) + ' MB').padStart(9)}  (${u.tbl})`);
    }
    console.log(`  Scan counts collected over ${statsAge.days} day(s) — a short`);
    console.log('  window can make a seasonal index look unused. Check before dropping.');
  }
  console.log('');

  console.log('  GROWTH');
  console.log('  ' + '-'.repeat(62));
  console.log(`  Orders in the last 90 days ....... ${rate.n.toLocaleString()}  (~${Math.round(ordersPerMonth).toLocaleString()}/month)`);
  console.log(`  Cost per order, all-in ........... ${fmt(perOrderBytes / 1024, 2)} KB  (row + its events)`);
  console.log(`  Growth ........................... ~${fmt(monthlyGrowthMb, 2)} MB/month`);
  if (Number.isFinite(monthsLeft)) {
    const when = new Date();
    when.setMonth(when.getMonth() + Math.floor(monthsLeft));
    console.log(`  Free tier full in ................ ~${fmt(monthsLeft)} months  (${when.toISOString().slice(0, 7)})`);
  }
  console.log('');

  if (usedMb / FREE_TIER_LIMIT_MB > 0.8) {
    console.log('  >> OVER 80% FULL. Writes fail at the cap; act before then.');
  } else if (Number.isFinite(monthsLeft) && monthsLeft < 6) {
    console.log('  >> Under 6 months of headroom. Plan the upgrade now, not later.');
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('db-report failed:', err.message);
    process.exit(1);
  });
