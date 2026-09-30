/**
 * export-db.js
 *
 * Exports all user tables from the OLD Supabase database to a single JSON file.
 * Run BEFORE creating the new project. Uses only pg (already in node_modules).
 *
 * Usage:
 *   node scripts/export-db.js
 *
 * Output:
 *   getmeds_export.json  (in the project root — keep this file safe)
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'getmeds_export.json');

// FK-safe insert order — parents before children
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
  'dispatch_assignments',
  'stock_announcements',
  'sync_jobs',
  'salesperson_mappings',
  'manager_scopes',
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database.');

  // Discover all actual tables in public schema
  const { rows: tableRows } = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const allTables = tableRows.map(r => r.tablename);
  console.log(`Found ${allTables.length} tables:`, allTables.join(', '));

  // Export in FK-safe order, then any remaining tables
  const remaining = allTables.filter(t => !TABLE_ORDER.includes(t));
  const exportOrder = [...TABLE_ORDER.filter(t => allTables.includes(t)), ...remaining];

  const export_ = { exported_at: new Date().toISOString(), tables: {} };

  // Export sequences (for identity/serial columns)
  const { rows: seqRows } = await client.query(`
    SELECT sequence_name, last_value
    FROM information_schema.sequences s
    JOIN pg_sequences ps ON ps.sequencename = s.sequence_name
    WHERE s.sequence_schema = 'public'
  `);
  export_.sequences = seqRows;
  console.log(`Exporting ${seqRows.length} sequences.`);

  for (const table of exportOrder) {
    process.stdout.write(`Exporting ${table}... `);
    try {
      const { rows, rowCount } = await client.query(`SELECT * FROM "${table}"`);
      export_.tables[table] = rows;
      console.log(`${rowCount} rows`);
    } catch (err) {
      console.log(`SKIPPED (${err.message})`);
      export_.tables[table] = [];
    }
  }

  await client.end();

  fs.writeFileSync(OUT_FILE, JSON.stringify(export_, null, 2));
  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`\nExport complete: ${OUT_FILE} (${sizeMB} MB)`);
  console.log('Keep this file safe — it is your complete database backup.');
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
