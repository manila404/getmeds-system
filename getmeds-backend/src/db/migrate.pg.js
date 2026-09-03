'use strict';

/**
 * PostgreSQL migration runner.
 *
 * Sep 2, 2026. Replaces src/db/migrate.js rather than porting it, because what
 * that file does is SQLite-specific in a way that has no Postgres analogue.
 *
 * SQLite cannot alter a CHECK constraint. To widen the `orders.status` list,
 * migrate.js has to rename the table, re-run the whole schema, copy the shared
 * columns across, drop the old table, and re-create every index — the
 * `legacy_alter_table` dance, guarded by an assertion on the index count
 * because an earlier version of it silently produced an orders table with zero
 * indexes.
 *
 * Postgres just alters the constraint. All of that machinery, and the class of
 * bug that came with it, goes away:
 *
 *     ALTER TABLE orders DROP CONSTRAINT orders_status_check;
 *     ALTER TABLE orders ADD  CONSTRAINT orders_status_check CHECK (...);
 *
 * Run:  node src/db/migrate.pg.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * The statuses this build can write. Kept in the same order as schema.pg.sql
 * and src/db/database.sqlite.js so the three can be eyeballed against each
 * other.
 */
const REQUIRED_STATUSES = [
  'draft', 'submitted', 'validating', 'so_pending', 'so_created',
  'ready_for_finance_verified', 'ready_for_draft_invoice',
  'ready_for_invoice_sent', 'ready_for_dispatch',
  'picking_packing', 'dispatched', 'tracking_shared',
  'completed', 'on_hold', 'exception', 'cancelled', 'deleted',
];

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'For migrations use the DIRECT connection (port 5432), not the\n' +
        'transaction pooler (6543) — the pooler rejects some DDL.'
    );
    process.exit(2);
  }
  return url;
}

async function applyFile(client, file, { required = false } = {}) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) {
    if (required) throw new Error(`${file} is missing — it is the schema, not an optional add-on`);
    console.log(`  – ${file} not present, skipping`);
    return;
  }
  await client.query(fs.readFileSync(full, 'utf8'));
  console.log(`  ✔ applied ${file}`);
}

/** Double-quote a Postgres identifier safely. */
const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Find the CHECK constraint on `orders` that constrains EXACTLY the `status`
 * column.
 *
 * Matching on `pg_get_constraintdef(...) ILIKE '%status%'` — the obvious first
 * attempt — is wrong and dangerous: `orders` also has
 * `zoho_sync_status CHECK (... IN ('pending','synced','failed','skipped'))`,
 * whose definition also contains the word "status". That match returned both
 * constraints, merged their allowed values into one set, and would have
 * DROPPED the zoho_sync_status constraint while trying to widen the pipeline
 * one. Caught by running it against a database that had both.
 *
 * `conkey` is the column list the constraint actually covers, so comparing it
 * to the attnum of `status` identifies exactly one constraint.
 */
async function statusCheckConstraint(client) {
  const { rows } = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class     t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'orders'
        AND n.nspname = current_schema()
        AND c.contype = 'c'
        AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
            ]::smallint[]`
  );
  if (!rows.length) return null;
  if (rows.length > 1) {
    throw new Error(
      `orders has ${rows.length} CHECK constraints on status alone: ` +
        rows.map((r) => r.conname).join(', ') +
        '. Resolve by hand — this script will not guess which to replace.'
    );
  }
  const statuses = new Set();
  for (const m of rows[0].def.matchAll(/'([a-z_]+)'::text/g)) statuses.add(m[1]);
  return { name: rows[0].conname, def: rows[0].def, statuses };
}

async function reconcileStatusCheck(client) {
  const current = await statusCheckConstraint(client);
  if (!current) {
    console.log('  – orders has no CHECK constraint on status; schema.pg.sql should have created one');
    return;
  }

  const missing = REQUIRED_STATUSES.filter((s) => !current.statuses.has(s));
  const extra = [...current.statuses].filter((s) => !REQUIRED_STATUSES.includes(s));

  if (!missing.length && !extra.length) {
    console.log('  ✔ orders.status CHECK is current');
    return;
  }

  if (missing.length) console.log(`  ↻ widening orders.status CHECK — adding: ${missing.join(', ')}`);
  if (extra.length) {
    // A value the constraint allows but this build never writes. Removing it
    // would make existing rows unverifiable, so report and leave it.
    console.log(`  ! constraint allows statuses this build does not write: ${extra.join(', ')}`);
    const { rows } = await client.query(
      `SELECT status, COUNT(*)::int AS n FROM orders WHERE status = ANY($1) GROUP BY status`,
      [extra]
    );
    for (const r of rows) console.log(`      ${r.n} existing order(s) still have status '${r.status}'`);
    if (rows.length) {
      console.log('      Leaving the constraint permissive so those rows stay valid.');
      return;
    }
  }

  const allowed = [...new Set([...REQUIRED_STATUSES, ...extra])];
  const list = allowed.map((s) => `'${s}'`).join(', ');

  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE orders DROP CONSTRAINT ${quoteIdent(current.name)}`);
    await client.query(
      `ALTER TABLE orders ADD CONSTRAINT ${quoteIdent(current.name)} CHECK (status IN (${list}))`
    );
    await client.query('COMMIT');
    console.log('  ✔ orders.status CHECK updated');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const url = connectionString();
  if (/:6543\//.test(url)) {
    console.warn(
      '⚠️  DATABASE_URL points at port 6543 (the transaction pooler).\n' +
        '   Use the DIRECT connection (5432) for migrations.\n'
    );
  }

  const pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|host=\/tmp/.test(url) ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    console.log('Applying schema…');
    await applyFile(client, 'schema.pg.sql', { required: true });
    await applyFile(client, 'schema.pg.trgm.sql');

    console.log('\nReconciling constraints…');
    await reconcileStatusCheck(client);

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()`
    );
    const idx = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'orders'`
    );

    // The assertion migrate.js earned the hard way: a rebuild that silently
    // produced an orders table with zero indexes. Cheap to check, so check it.
    if (idx.rows[0].n === 0) {
      throw new Error('orders has no indexes — schema did not apply correctly');
    }

    console.log(`\n✅ Done. ${rows[0].n} tables, ${idx.rows[0].n} indexes on orders.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
