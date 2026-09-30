/**
 * import-db.js
 *
 * Imports all data from getmeds_export.json into the NEW Supabase database.
 * Run AFTER npm run migrate:pg has succeeded on the new project.
 *
 * Usage (set DATABASE_URL to the NEW project first):
 *   node scripts/import-db.js
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const IN_FILE = path.join(__dirname, '..', 'getmeds_export.json');
const BATCH_SIZE = 500;

// FK-safe order — parents before children
const TABLE_ORDER = [
  'users',
  'sales_channels',
  'sales_managers',
  'products',
  'customers',
  'orders',
  'order_items',
  'order_events',
  'notifications',
  'payments',
  'payment_confirmations',
  'dispatch_records',
  'dispatch_assignments',
  'zoho_sync_queue',
  'stock_announcements',
  'sync_jobs',
  'salesperson_mappings',
  'manager_scopes',
  'user_salespersons',
];

// Safely coerce a JS value to a pg-compatible type.
// Objects/arrays come from JSON parsing and need to be re-serialized for
// json/jsonb columns; pg won't do this automatically for plain objects.
function pgVal(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function batchInsert(client, table, rows) {
  if (!rows || rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  const quotedCols = columns.map(c => `"${c}"`).join(', ');
  let total = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const nCols = columns.length;

    const placeholders = batch
      .map((_, ri) =>
        '(' + columns.map((_, ci) => `$${ri * nCols + ci + 1}`).join(', ') + ')'
      )
      .join(', ');

    const values = batch.flatMap(row => columns.map(col => pgVal(row[col])));

    await client.query(
      `INSERT INTO "${table}" (${quotedCols}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      values
    );
    total += batch.length;

    // Progress for large tables
    if (rows.length > 5000 && (i + BATCH_SIZE) % 10000 < BATCH_SIZE) {
      process.stdout.write(`  ${Math.round(((i + BATCH_SIZE) / rows.length) * 100)}%... `);
    }
  }
  return total;
}

async function main() {
  console.log('Reading export file (may take a moment for 422 MB)...');
  const raw = fs.readFileSync(IN_FILE, 'utf8');
  const dump = JSON.parse(raw);
  console.log(`Export date: ${dump.exported_at}`);
  console.log(`Tables in export: ${Object.keys(dump.tables).length}\n`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to new database.');

  // Bypass FK triggers so we can insert in bulk without ordering issues
  await client.query("SET session_replication_role = replica");

  const exportedTables = Object.keys(dump.tables);
  const remaining = exportedTables.filter(t => !TABLE_ORDER.includes(t));
  const importOrder = [
    ...TABLE_ORDER.filter(t => exportedTables.includes(t)),
    ...remaining,
  ];

  const start = Date.now();

  for (const table of importOrder) {
    const rows = dump.tables[table];
    if (!rows || rows.length === 0) {
      console.log(`  ${table}: (empty)`);
      continue;
    }
    process.stdout.write(`  ${table} — ${rows.length} rows... `);
    try {
      const n = await batchInsert(client, table, rows);
      console.log(`✔ ${n}`);
    } catch (err) {
      console.log(`✘ ERROR: ${err.message}`);
    }
  }

  // Reset identity sequences so next INSERT gets the right id
  console.log('\nResetting sequences...');
  for (const seq of (dump.sequences || [])) {
    try {
      await client.query(
        `SELECT setval('${seq.sequence_name}', $1, true)`,
        [Math.max(1, Number(seq.last_value))]
      );
      console.log(`  ✔ ${seq.sequence_name} → ${seq.last_value}`);
    } catch (err) {
      console.log(`  ✘ ${seq.sequence_name}: ${err.message}`);
    }
  }

  await client.query("SET session_replication_role = DEFAULT");
  await client.end();

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`\n✅ Import complete in ${elapsed}s.`);
}

main().catch(err => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
