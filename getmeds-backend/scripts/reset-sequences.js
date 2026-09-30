/**
 * reset-sequences.js
 *
 * Resets every identity/serial sequence in the new database to the actual
 * MAX(id) of its table, so the next INSERT doesn't collide with existing rows.
 *
 * Run AFTER import-db.js completes.
 * Usage:
 *   node scripts/reset-sequences.js
 */

require('dotenv').config();
const { Client } = require('pg');

// Tables with integer primary-key columns that have sequences behind them
const TABLES = [
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
  'payment_proofs',
  'dispatch_records',
  'stock_announcements',
  'salesperson_mappings',
  'sales_channel_approvers',
  'sales_territories',
  'zoho_salespersons',
  'zoho_salesperson_changes',
  'order_split_sales_orders',
  'order_id_sequences',
  'sync_state',
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected.\n');

  for (const table of TABLES) {
    try {
      // Get the sequence name for the id column
      const { rows: seqRows } = await client.query(
        `SELECT pg_get_serial_sequence($1, 'id') AS seq`, [`public.${table}`]
      );
      const seq = seqRows[0]?.seq;
      if (!seq) {
        console.log(`  ${table}: no sequence (skipped)`);
        continue;
      }

      // Get current max id
      const { rows: maxRows } = await client.query(
        `SELECT COALESCE(MAX(id), 1) AS max_id FROM "${table}"`
      );
      const maxId = Number(maxRows[0].max_id);

      // Set sequence to max id so next insert gets max_id + 1
      await client.query(`SELECT setval($1, $2, true)`, [seq, maxId]);
      console.log(`  ✔ ${table}.id → sequence reset to ${maxId}`);
    } catch (err) {
      console.log(`  ✘ ${table}: ${err.message}`);
    }
  }

  await client.end();
  console.log('\n✅ All sequences reset.');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
