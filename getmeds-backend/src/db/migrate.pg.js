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
  'draft', 'pending_management_approval', 'submitted', 'validating', 'so_pending', 'so_created',
  'ready_for_finance_verified', 'ready_for_draft_invoice',
  'ready_for_invoice_sent', 'ready_for_dispatch',
  'picking_packing', 'dispatched', 'tracking_shared',
  'completed', 'on_hold', 'exception', 'cancelled', 'deleted',
];

/**
 * The file types payment_proofs.file_type may hold. Kept in the same order
 * as schema.pg.sql and schema.sql so the three can be eyeballed against each
 * other, same convention as REQUIRED_STATUSES above.
 *
 * Sep 5, 2026 (2): 'purchase_order' added — a third, purely informational
 * attachment type alongside 'other' (the file-type CHECK on payment_proofs
 * needs widening on any database created before this, same reasoning as
 * reconcileStatusCheck below).
 */
// Sep 9, 2026: 'gl', 'prescription' and 'id' added for the hospital (PAP/DSWD)
// intake, which requires all four of Guarantee Letter, Prescription, Proof of
// Payment and a photo ID. reconcilePaymentProofs below widens the existing
// CHECK constraint to match, so an already-deployed database picks these up
// without anyone editing SQL by hand.
const REQUIRED_FILE_TYPES = ['payment_proof', 'other', 'purchase_order', 'gl', 'prescription', 'id'];

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

/**
 * Sep 5, 2026: payment_proofs went from "one row per order" (order_id
 * UNIQUE) to a typed, multi-row attachment table (file_type: 'payment_proof'
 * | 'other', no UNIQUE). `CREATE TABLE IF NOT EXISTS` in schema.pg.sql only
 * ever applies to a table that does not exist yet — it is a no-op against a
 * database that already has payment_proofs from before this change, exactly
 * like reconcileStatusCheck above exists because widening a CHECK has the
 * same problem. This does the two ALTERs an existing database needs:
 *   1. add file_type, defaulting existing rows to 'payment_proof' (the only
 *      kind that existed before this column did — correct for every row
 *      already in the table);
 *   2. drop the UNIQUE constraint on order_id, replaced by a plain index.
 * Both steps are written to be safe to run again: the column add is guarded
 * by information_schema, and the constraint drop looks up its real name
 * first (Postgres's default naming — payment_proofs_order_id_key — is not
 * guaranteed, so this does not hard-code it).
 *
 * Sep 5, 2026 (2): a third ALTER — widening the file_type CHECK itself —
 * added for 'purchase_order'. Postgres cannot add a value to an
 * existing CHECK constraint, only DROP and re-ADD it with the full list, so
 * this mirrors reconcileStatusCheck's approach exactly: find the constraint
 * by matching conkey against file_type's attnum (never by text-matching the
 * constraint definition — see statusCheckConstraint's comment on why that is
 * unsafe), compute what's missing, and replace it transactionally.
 */
async function fileTypeCheckConstraint(client) {
  const { rows } = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class     t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'payment_proofs'
        AND n.nspname = current_schema()
        AND c.contype = 'c'
        AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid = t.oid AND a.attname = 'file_type' AND NOT a.attisdropped)
            ]::smallint[]`
  );
  if (!rows.length) return null;
  if (rows.length > 1) {
    throw new Error(
      `payment_proofs has ${rows.length} CHECK constraints on file_type alone: ` +
        rows.map((r) => r.conname).join(', ') +
        '. Resolve by hand — this script will not guess which to replace.'
    );
  }
  const types = new Set();
  for (const m of rows[0].def.matchAll(/'([a-z_]+)'::text/g)) types.add(m[1]);
  return { name: rows[0].conname, def: rows[0].def, types };
}

async function reconcilePaymentProofs(client) {
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'payment_proofs' AND column_name = 'file_type'`
  );
  if (!cols.length) {
    console.log('  ↻ payment_proofs.file_type is missing — adding (existing rows default to \'payment_proof\')');
    const freshList = REQUIRED_FILE_TYPES.map((t) => `'${t}'`).join(', ');
    await client.query(
      `ALTER TABLE payment_proofs ADD COLUMN file_type TEXT NOT NULL DEFAULT 'payment_proof'`
    );
    await client.query(
      `ALTER TABLE payment_proofs ADD CONSTRAINT payment_proofs_file_type_check CHECK (file_type IN (${freshList}))`
    );
    console.log('  ✔ payment_proofs.file_type added');
  } else {
    console.log('  ✔ payment_proofs.file_type already present');

    const current = await fileTypeCheckConstraint(client);
    if (!current) {
      console.log('  – payment_proofs has no CHECK constraint on file_type; schema.pg.sql should have created one');
    } else {
      const missing = REQUIRED_FILE_TYPES.filter((t) => !current.types.has(t));
      if (!missing.length) {
        console.log('  ✔ payment_proofs.file_type CHECK is current');
      } else {
        console.log(`  ↻ widening payment_proofs.file_type CHECK — adding: ${missing.join(', ')}`);
        const allowed = [...new Set([...REQUIRED_FILE_TYPES, ...current.types])];
        const list = allowed.map((t) => `'${t}'`).join(', ');
        await client.query('BEGIN');
        try {
          await client.query(`ALTER TABLE payment_proofs DROP CONSTRAINT ${quoteIdent(current.name)}`);
          await client.query(
            `ALTER TABLE payment_proofs ADD CONSTRAINT ${quoteIdent(current.name)} CHECK (file_type IN (${list}))`
          );
          await client.query('COMMIT');
          console.log('  ✔ payment_proofs.file_type CHECK updated');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }
  }

  const { rows: uniques } = await client.query(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_class     t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'payment_proofs'
        AND n.nspname = current_schema()
        AND c.contype = 'u'
        AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid = t.oid AND a.attname = 'order_id' AND NOT a.attisdropped)
            ]::smallint[]`
  );
  if (uniques.length) {
    console.log(`  ↻ dropping UNIQUE constraint ${uniques[0].conname} on payment_proofs.order_id — an order may now carry more than one attachment`);
    await client.query(`ALTER TABLE payment_proofs DROP CONSTRAINT ${quoteIdent(uniques[0].conname)}`);
    console.log('  ✔ payment_proofs.order_id is no longer UNIQUE');
  } else {
    console.log('  ✔ payment_proofs.order_id already allows multiple rows');
  }
}

/**
 * Sep 5, 2026 (3): `orders.sub_division` — the per-order Sub-division
 * override (see schema.pg.sql's `orders` table comment and
 * orders.controller.js's create()). `CREATE TABLE IF NOT EXISTS` in
 * schema.pg.sql is a no-op against a database that already has an `orders`
 * table from before this column existed, exactly like reconcilePaymentProofs
 * above — so an existing database needs this explicit ADD COLUMN. No CHECK
 * constraint (same reasoning as users.division/users.sub_division): the
 * fixed Sub-division lists only apply to four of the fifteen Divisions, and
 * that mapping is enforced in the controller, not the database. Plain text,
 * nullable, so it's safe to add with no default — existing rows read NULL,
 * and orders.controller.js's submit() already falls back to the account's
 * value when this column is NULL on an older draft.
 */
async function reconcileOrdersSubDivision(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'sub_division'`
  );
  if (rows.length) {
    console.log('  ✔ orders.sub_division already present');
    return;
  }
  console.log('  ↻ orders.sub_division is missing — adding (existing rows default to NULL)');
  await client.query('ALTER TABLE orders ADD COLUMN sub_division TEXT');
  console.log('  ✔ orders.sub_division added');
}

// Sep 5, 2026 (4): orders.division / orders.salesperson — Management's
// manual per-order override of Division/Salesperson (see orders.controller.js's
// create()/submit() and schema.pg.sql's orders table comment). Same
// "existing rows default to NULL" reconciliation as sub_division above.
async function reconcileOrdersDivisionSalesperson(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name IN ('division', 'salesperson')`
  );
  const present = new Set(rows.map((r) => r.column_name));

  if (!present.has('division')) {
    console.log('  ↻ orders.division is missing — adding (existing rows default to NULL)');
    await client.query('ALTER TABLE orders ADD COLUMN division TEXT');
    console.log('  ✔ orders.division added');
  } else {
    console.log('  ✔ orders.division already present');
  }

  if (!present.has('salesperson')) {
    console.log('  ↻ orders.salesperson is missing — adding (existing rows default to NULL)');
    await client.query('ALTER TABLE orders ADD COLUMN salesperson TEXT');
    console.log('  ✔ orders.salesperson added');
  } else {
    console.log('  ✔ orders.salesperson already present');
  }
}

/**
 * Sep 8, 2026 (5): `customers.tin` — Tax Identification Number, a Philippines
 * BIR field Zoho requires (on the contact, not the Sales Order) before it
 * will let a "business" sub-type customer's Sales Order be created. Same
 * "existing rows default to NULL" reconciliation as sub_division/division/
 * salesperson above — `CREATE TABLE IF NOT EXISTS` in schema.pg.sql is a
 * no-op against a database that already has a `customers` table from before
 * this column existed.
 */
async function reconcileCustomersTin(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'tin'`
  );
  if (rows.length) {
    console.log('  ✔ customers.tin already present');
    return;
  }
  console.log('  ↻ customers.tin is missing — adding (existing rows default to NULL)');
  await client.query('ALTER TABLE customers ADD COLUMN tin TEXT');
  console.log('  ✔ customers.tin added');
}

/**
 * Sep 8, 2026 (6): `orders.gm_lead_id` — the identity of the admin/
 * management account that created an order (the order form's "Admin"
 * field, previously never sent to Zoho — see orders.controller.js's
 * gmLeadId note and LiveZohoAdapter.js's cf_gm_lead_id wiring). Same
 * "existing rows default to NULL" reconciliation as every other column
 * added this way above.
 */
async function reconcileOrdersGmLeadId(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'gm_lead_id'`
  );
  if (rows.length) {
    console.log('  ✔ orders.gm_lead_id already present');
    return;
  }
  console.log('  ↻ orders.gm_lead_id is missing — adding (existing rows default to NULL)');
  await client.query('ALTER TABLE orders ADD COLUMN gm_lead_id TEXT');
  console.log('  ✔ orders.gm_lead_id added');
}

/**
 * Sep 9, 2026: `orders.zoho_detail_synced_at` — when an order's full Zoho
 * detail (line items + Comments & History) was last pulled, as opposed to the
 * cheap list-only summary every imported order starts as. See schema.pg.sql's
 * comment on the column for why the import has two tiers at all. Same
 * "existing rows default to NULL" reconciliation as every other column added
 * this way above; NULL is the correct value for every existing row, since none
 * of them recorded this before now.
 */
async function reconcileOrdersZohoDetailSyncedAt(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'zoho_detail_synced_at'`
  );
  if (rows.length) {
    console.log('  ✔ orders.zoho_detail_synced_at already present');
    return;
  }
  console.log('  ↻ orders.zoho_detail_synced_at is missing — adding (existing rows default to NULL)');
  await client.query('ALTER TABLE orders ADD COLUMN zoho_detail_synced_at TEXT');
  console.log('  ✔ orders.zoho_detail_synced_at added');
}

/**
 * Sep 9, 2026: the five "Master Form" intake columns. See schema.pg.sql for
 * what each one holds and why intake_receiver_type / intake_is_doctor are
 * constrained rather than free text.
 *
 * One function for all five rather than five near-identical ones — the pattern
 * above was already repeating itself, and a table of {name, type} is easier to
 * read than five copies of the same information_schema probe. The CHECK
 * constraints ride along in the type string, which is what ALTER TABLE ADD
 * COLUMN accepts.
 */
const MASTER_FORM_COLUMNS = [
  ['intake_expected_shipment_date', 'TEXT'],
  ['intake_gl_number', 'TEXT'],
  [
    'intake_receiver_type',
    "TEXT CHECK(intake_receiver_type IS NULL OR intake_receiver_type IN ('patient','representative'))",
  ],
  ['intake_is_doctor', 'INTEGER CHECK(intake_is_doctor IS NULL OR intake_is_doctor IN (0,1))'],
  ['intake_tin', 'TEXT'],
];

async function reconcileMasterFormColumns(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders'`
  );
  const present = new Set(rows.map((r) => r.column_name));

  for (const [name, type] of MASTER_FORM_COLUMNS) {
    if (present.has(name)) {
      console.log(`  \u2714 orders.${name} already present`);
      continue;
    }
    console.log(`  \u21bb orders.${name} is missing \u2014 adding (existing rows default to NULL)`);
    await client.query(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
    console.log(`  \u2714 orders.${name} added`);
  }
}

/**
 * Sep 9, 2026: the three columns behind "a sign-up must be approved by an
 * admin". See schema.pg.sql for why approval_status is separate from
 * is_active.
 *
 * Existing rows get 'approved' — the column's own DEFAULT does that for the
 * backfill, which is the whole reason the default is 'approved' rather than
 * 'pending'. Adding it the other way round would lock every existing account
 * out of the system the moment this ran.
 */
const APPROVAL_COLUMNS = [
  [
    'approval_status',
    "TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending','approved','rejected'))",
  ],
  ['approved_at', 'TEXT'],
  ['approved_by', 'INTEGER REFERENCES users(id)'],
];

async function reconcileUserApproval(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users'`
  );
  const present = new Set(rows.map((r) => r.column_name));

  for (const [name, type] of APPROVAL_COLUMNS) {
    if (present.has(name)) {
      console.log(`  \u2714 users.${name} already present`);
      continue;
    }
    console.log(`  \u21bb users.${name} is missing \u2014 adding`);
    await client.query(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    console.log(`  \u2714 users.${name} added`);
  }
}

/**
 * Sep 10, 2026: Zoho's four status axes on `orders`. See schema.pg.sql for why
 * one rollup status was not enough. Existing rows default to NULL and are
 * filled in by the next Zoho list walk — nothing depends on them being
 * present, so a database mid-backfill behaves exactly as it did before.
 */
const ZOHO_STATUS_COLUMNS = [
  'zoho_order_status',
  'zoho_invoiced_status',
  'zoho_paid_status',
  'zoho_shipped_status',
];

async function reconcileZohoStatusColumns(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders'`
  );
  const present = new Set(rows.map((r) => r.column_name));

  for (const name of ZOHO_STATUS_COLUMNS) {
    if (present.has(name)) {
      console.log(`  \u2714 orders.${name} already present`);
      continue;
    }
    console.log(`  \u21bb orders.${name} is missing \u2014 adding`);
    await client.query(`ALTER TABLE orders ADD COLUMN ${name} TEXT`);
    console.log(`  \u2714 orders.${name} added`);
  }
}

/**
 * Sep 11, 2026: `users.order_scope` — how much of the order list a management
 * user may see.
 *
 * Existing rows get 'all', NOT because that is the safe default but because it
 * is what they already had: every management user could see every order before
 * this column existed, and a migration must not quietly revoke access that was
 * working yesterday. New scoped managers are created with 'divisions'
 * explicitly.
 *
 * The fail-closed rule lives one level up, in orderScopeService: a user set to
 * 'divisions' with no scope rows sees nothing.
 */
async function reconcileUserOrderScope(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users'`
  );
  if (rows.some((r) => r.column_name === 'order_scope')) {
    console.log('  ✔ users.order_scope already present');
    return;
  }
  console.log('  ↻ users.order_scope is missing — adding');
  // DEFAULT 'all' so a user created by any path that does not mention this
  // column keeps the access management users have always had — see the
  // opt-in note in services/orderScopeService.js.
  await client.query(`ALTER TABLE users ADD COLUMN order_scope TEXT DEFAULT 'all'`);
  // Preserve what every management user could already do.
  const upd = await client.query(
    `UPDATE users SET order_scope = 'all' WHERE order_scope IS NULL`
  );
  console.log(`  ✔ users.order_scope added (${upd.rowCount} existing user(s) kept at 'all')`);
}

/**
 * Sep 11, 2026: `users.salesperson` stops being a generated column.
 *
 * It was GENERATED ALWAYS AS (division || ' | ' || display_name). See
 * schema.pg.sql for why that was wrong: Zoho's Salesperson list has no single
 * convention, and a name that does not match one CREATES a new Salesperson in
 * the org rather than failing, so every wrong guess is permanent junk in the
 * company's Zoho.
 *
 * DROP EXPRESSION converts the column in place and KEEPS the values already
 * computed. That matters: three real accounts hold a value that does match a
 * Zoho Salesperson, and rebuilding the column would throw those away and make
 * an admin re-enter them from memory.
 */
async function reconcileUserSalespersonColumn(client) {
  const { rows } = await client.query(
    `SELECT is_generated FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users' AND column_name = 'salesperson'`
  );
  if (!rows.length) {
    console.log('  ✔ users.salesperson not present yet (fresh schema will create it plain)');
    return;
  }
  if (rows[0].is_generated !== 'ALWAYS') {
    console.log('  ✔ users.salesperson is already a plain column');
    return;
  }

  console.log('  ↻ users.salesperson is GENERATED — converting to a plain column (values kept)');
  await client.query(`ALTER TABLE users ALTER COLUMN salesperson DROP EXPRESSION`);

  const { rows: kept } = await client.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE salesperson IS NOT NULL`
  );
  console.log(`  ✔ users.salesperson converted (${kept[0].n} existing value(s) preserved)`);
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
    await reconcilePaymentProofs(client);
    await reconcileOrdersSubDivision(client);
    await reconcileOrdersDivisionSalesperson(client);
    await reconcileCustomersTin(client);
    await reconcileOrdersGmLeadId(client);
    await reconcileOrdersZohoDetailSyncedAt(client);
    await reconcileMasterFormColumns(client);
    await reconcileUserApproval(client);
    await reconcileZohoStatusColumns(client);
    await reconcileUserOrderScope(client);
    await reconcileUserSalespersonColumn(client);

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
