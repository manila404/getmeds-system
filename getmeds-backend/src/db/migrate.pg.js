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
 * The roles this build writes to users.role and order_events.actor_role.
 * Kept in the same order as schema.pg.sql and src/constants/roles.js so the
 * three can be eyeballed against each other, same convention as
 * REQUIRED_STATUSES above.
 *
 * Sep 21, 2026: 'team_lead' added — a view-only role scoped to the MedReps
 * assigned to it (users.team_lead_id), not to a division. Both CHECK
 * constraints this list feeds are widened by reconcileUserRoleCheck /
 * reconcileOrderEventsActorRole below, on a database created before this.
 */
const REQUIRED_ROLES = ['medrep', 'finance', 'dispatch', 'management', 'admin', 'team_lead'];

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
// Sep 15, 2026: 'dispatch_proof' — Dispatch's photo of the order going out.
const REQUIRED_FILE_TYPES = ['payment_proof', 'other', 'purchase_order', 'gl', 'prescription', 'id', 'dispatch_proof'];

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
 * Find the CHECK constraint on `table` that constrains EXACTLY `column`, by
 * matching `conkey` against the column's own attnum rather than text-
 * searching the constraint definition — see statusCheckConstraint's own
 * comment below for why a text match is unsafe (it once matched two
 * constraints at once and nearly dropped the wrong one).
 *
 * Sep 21, 2026: generalized out of statusCheckConstraint/
 * fileTypeCheckConstraint, which are this exact same ~20 lines with a
 * different table/column baked in — needed a third and fourth time for
 * users.role and order_events.actor_role, so this is the one shared version
 * from here on.
 */
async function checkConstraintOnColumn(client, table, column) {
  const { rows } = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class     t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = $1
        AND n.nspname = current_schema()
        AND c.contype = 'c'
        AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid = t.oid AND a.attname = $2 AND NOT a.attisdropped)
            ]::smallint[]`,
    [table, column]
  );
  if (!rows.length) return null;
  if (rows.length > 1) {
    throw new Error(
      `${table} has ${rows.length} CHECK constraints on ${column} alone: ` +
        rows.map((r) => r.conname).join(', ') +
        '. Resolve by hand — this script will not guess which to replace.'
    );
  }
  const values = new Set();
  for (const m of rows[0].def.matchAll(/'([a-z_]+)'::text/g)) values.add(m[1]);
  return { name: rows[0].conname, def: rows[0].def, values };
}

/**
 * Widen a `CHECK (column IN (...))` (or `CHECK (column IS NULL OR column IN
 * (...))`) constraint to include every value in `required`, preserving any
 * extra value the constraint already allows — existing rows may still hold
 * it, same reasoning reconcileStatusCheck gives for `extra`. No-ops if the
 * constraint already allows everything in `required`.
 */
async function widenCheckConstraint(client, table, column, required) {
  const current = await checkConstraintOnColumn(client, table, column);
  if (!current) {
    console.log(`  – ${table}.${column} has no CHECK constraint; schema.pg.sql should have created one`);
    return;
  }
  const missing = required.filter((v) => !current.values.has(v));
  if (!missing.length) {
    console.log(`  ✔ ${table}.${column} CHECK is current`);
    return;
  }
  console.log(`  ↻ widening ${table}.${column} CHECK — adding: ${missing.join(', ')}`);
  const allowed = [...new Set([...required, ...current.values])];
  const list = allowed.map((v) => `'${v}'`).join(', ');
  const nullable = current.def.includes('IS NULL OR');
  const clause = nullable ? `${column} IS NULL OR ${column} IN (${list})` : `${column} IN (${list})`;
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(current.name)}`);
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(current.name)} CHECK (${clause})`);
    await client.query('COMMIT');
    console.log(`  ✔ ${table}.${column} CHECK updated`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

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
 * Sep 21, 2026: `users.role` widened to accept 'team_lead' — a view-only role
 * scoped to whichever MedReps have team_lead_id pointing back at them (see
 * reconcileTeamLead below and services/teamScopeService.js). Uses the same
 * drop-and-re-add approach reconcileStatusCheck uses for orders.status;
 * Postgres cannot add a single value to an existing CHECK.
 */
async function reconcileUserRoleCheck(client) {
  await widenCheckConstraint(client, 'users', 'role', REQUIRED_ROLES);
}

/**
 * Sep 21, 2026: `users.team_lead_id` — which Team Lead this MedRep reports
 * to, if any. Nullable, one per MedRep, no CHECK tying it to role on either
 * end (same as division/sub_division — validated in application code, see
 * admin.controller.js's update()).
 */
async function reconcileTeamLead(client) {
  await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS team_lead_id INTEGER REFERENCES users(id)');
  console.log('  ✔ users.team_lead_id present');
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

/**
 * Sep 11, 2026: `customers.email` and `customers.lto_license_number`, for
 * customers created from the order form. See schema.pg.sql for why the
 * licence number is kept locally rather than left to Zoho's unique index.
 */
const CUSTOMER_CREATE_COLUMNS = [
  ['email', 'TEXT'],
  ['lto_license_number', 'TEXT'],
  // Sep 11, 2026: the hold queue for customers Zoho cannot accept yet. See
  // schema.pg.sql. Existing rows default to 'synced' because they came FROM
  // Zoho — only ones created here can be pending.
  ['zoho_sync_status', "TEXT DEFAULT 'synced'"],
  ['zoho_pending_payload', 'TEXT'],
  ['zoho_sync_error', 'TEXT'],
];

async function reconcileCustomerCreateColumns(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'customers'`
  );
  const present = new Set(rows.map((r) => r.column_name));

  for (const [name, type] of CUSTOMER_CREATE_COLUMNS) {
    if (present.has(name)) {
      console.log(`  ✔ customers.${name} already present`);
      continue;
    }
    console.log(`  ↻ customers.${name} is missing — adding`);
    await client.query(`ALTER TABLE customers ADD COLUMN ${name} ${type}`);
    console.log(`  ✔ customers.${name} added`);
  }

  // Finding a customer by licence is the whole point of storing it.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_customers_lto ON customers(lower(trim(lto_license_number)))`
  );

  // The pending queue is read on every admin page load and after every token
  // change; it must not scan 95,000 rows to find the handful that are waiting.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_customers_zoho_sync_status
       ON customers(zoho_sync_status) WHERE zoho_sync_status <> 'synced'`
  );

  // Added as nullable so the ALTER is instant on a large table, then
  // constrained once every row has a value. The other order locks the table.
  const { rows: missing } = await client.query(
    `SELECT COUNT(*)::int AS n FROM customers WHERE zoho_sync_status IS NULL`
  );
  if (missing[0].n) {
    console.log(`  ↻ backfilling customers.zoho_sync_status for ${missing[0].n} row(s)`);
    await client.query(`UPDATE customers SET zoho_sync_status = 'synced' WHERE zoho_sync_status IS NULL`);
  }
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'customers_zoho_sync_status_check'
      ) THEN
        ALTER TABLE customers ADD CONSTRAINT customers_zoho_sync_status_check
          CHECK (zoho_sync_status IN ('synced','pending','failed'));
      END IF;
    END $$;
  `);
}

/**
 * Sep 11, 2026: seed user_salespersons from users.salesperson.
 *
 * schema.pg.sql creates the table (an account can now hold several Zoho
 * Salespersons); this copies each account's existing single one in as its
 * primary, so nobody loses the Salesperson they already had.
 *
 * Only for accounts that have no rows yet. An account whose list an admin has
 * already edited is never touched, which is also what makes re-running this a
 * no-op.
 */
async function reconcileUserSalespersons(client) {
  const res = await client.query(
    `INSERT INTO user_salespersons (user_id, salesperson, is_primary)
     SELECT u.id, TRIM(u.salesperson), 1
       FROM users u
      WHERE u.salesperson IS NOT NULL AND TRIM(u.salesperson) <> ''
        AND NOT EXISTS (SELECT 1 FROM user_salespersons s WHERE s.user_id = u.id)`
  );
  if (res.rowCount) {
    console.log(`  ↻ user_salespersons: seeded ${res.rowCount} account(s) from users.salesperson`);
  } else {
    console.log('  ✔ user_salespersons already seeded');
  }
}


/**
 * Sep 12, 2026: orders.raised_by_id — who FILLED THE FORM IN, when that is not
 * who the order belongs to.
 *
 * A MedRep can raise an order for a colleague. `medrep_id` is then the
 * colleague's, and until now the raiser's own involvement survived only as
 * JSON inside the submit event's metadata. That was enough to display a name
 * in the trail and nothing else: every permission check and every list query
 * compares against `medrep_id`, so the person who created the order could not
 * see it, open it, submit it, or attach the file they had just picked
 * (GM-20260911-0003).
 *
 * A real column rather than reading that metadata back, for one reason that
 * only shows up at scale: the orders list would need a correlated subquery
 * over order_events for all 60,955 rows to answer "and the ones I raised".
 * Indexed, it is a join key.
 *
 * NULL means the ordinary case — raised by whoever owns it. It is deliberately
 * NOT backfilled to medrep_id for the other 60,951 rows: "nobody else raised
 * this" and "the owner raised this" are the same fact, and storing it on every
 * historical row would only invite a future reader to think the column means
 * something it does not.
 */
async function reconcileOrderRaisedBy(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'orders'
        AND column_name = 'raised_by_id'`
  );

  if (rows.length) {
    console.log('  ✔ orders.raised_by_id already present');
  } else {
    console.log('  ↻ orders.raised_by_id is missing — adding');
    await client.query(
      'ALTER TABLE orders ADD COLUMN raised_by_id INTEGER REFERENCES users(id)'
    );
    console.log('  ✔ orders.raised_by_id added');
  }

  // Outside the branch above, and NOT in schema.pg.sql: that file is applied
  // to existing databases too, where CREATE TABLE is a no-op but an index on a
  // column this function has not added yet still runs, and fails the whole
  // migration. Here it is correct for a fresh build and a retrofit alike.
  //
  // Partial: only on-behalf rows are ever looked up by raiser, and they are a
  // rounding error against the table. A full index would be mostly NULLs.
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_orders_raised_by
       ON orders (raised_by_id) WHERE raised_by_id IS NOT NULL`
  );

  // Backfill from the only place the fact was previously recorded. Idempotent
  // — it only touches rows still NULL, so re-running cannot overwrite a value
  // set by create().
  const filled = await client.query(
    `UPDATE orders o
        SET raised_by_id = e.raiser
       FROM (
         SELECT DISTINCT ON (order_id)
                order_id,
                NULLIF(metadata::json->>'raisedByUserId', '')::int AS raiser
           FROM order_events
          WHERE metadata LIKE '%raisedByUserId%'
          ORDER BY order_id, id
       ) e
      WHERE o.id = e.order_id
        AND o.raised_by_id IS NULL
        AND e.raiser IS NOT NULL
        AND e.raiser <> o.medrep_id
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = e.raiser)`
  );
  if (filled.rowCount) {
    console.log(`  ✔ backfilled raised_by_id on ${filled.rowCount} on-behalf order(s)`);
  }
}

/**
 * Sep 12, 2026: columns for the Finance-confirms / Dispatch-in-Getmeds workflow
 * (services/workflowV2Service.js, behind GETMEDS_WORKFLOW_V2).
 *
 *   orders.action_claim, action_claim_at      who is acting on the order right
 *                                             now — "only the first click wins"
 *   dispatch_records.zoho_package_id/_number  the Zoho package Dispatch created
 *   dispatch_records.zoho_shipment_id/_number the Zoho shipment
 *   dispatch_records.delivered_at, delivered_by  when, and by whom, it arrived
 *
 * ADD COLUMN IF NOT EXISTS, so this is a no-op on a database built from
 * schema.pg.sql, which already carries them, and safe to run on every boot.
 * All nullable with no default: existing rows simply have nothing recorded.
 */
async function reconcileWorkflowV2Columns(client) {
  const columns = [
    ['orders', 'action_claim', 'TEXT'],
    ['orders', 'action_claim_at', 'TEXT'],
    ['dispatch_records', 'zoho_package_id', 'TEXT'],
    ['dispatch_records', 'zoho_package_number', 'TEXT'],
    ['dispatch_records', 'zoho_shipment_id', 'TEXT'],
    ['dispatch_records', 'zoho_shipment_number', 'TEXT'],
    ['dispatch_records', 'delivered_at', 'TEXT'],
    ['dispatch_records', 'delivered_by', 'INTEGER REFERENCES users(id)'],
  ];
  for (const [table, column, type] of columns) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
  }
  console.log('  ✔ workflow columns present (orders.action_claim*, dispatch_records Zoho ids and delivery)');
}


/**
 * Sep 14, 2026: orders.is_inclusive_tax — Tax Exclusive (0) or Inclusive (1).
 *
 * Every existing order is exclusive, which is exactly what DEFAULT 0 says, so
 * the column arrives already correct for all 60,000-odd rows. On Postgres 11+
 * a constant default is recorded in the catalogue rather than written into
 * each row, so this is instant on a large table.
 */
async function reconcileOrderTaxPreference(client) {
  await client.query(
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_inclusive_tax INTEGER NOT NULL DEFAULT 0'
  );
  console.log('  ✔ orders.is_inclusive_tax present');
}

/** Sep 14, 2026: orders.headquarter — Zoho's cf_head_quarter. Existing rows stay NULL. */
async function reconcileOrderHeadquarter(client) {
  await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS headquarter TEXT');
  console.log('  ✔ orders.headquarter present');
}


/**
 * Sep 14, 2026: each product's Zoho sales tax (id, name, percentage).
 *
 * Zoho applies the ITEM's own tax to a Sales Order line and ignores anything
 * this app sends for it, so the app mirrors the item's tax instead of asking
 * the MedRep. Nullable: a product nobody has pulled from Zoho since this
 * shipped simply has no tax recorded yet, and falls back to what it did before.
 */
async function reconcileProductTaxColumns(client) {
  for (const [name, type] of [['zoho_tax_id', 'TEXT'], ['tax_name', 'TEXT'], ['tax_percentage', 'DOUBLE PRECISION']]) {
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
  console.log('  ✔ products tax columns present');
}

/**
 * Sep 18, 2026: order_events.actor_role — the actor's role AT THE TIME of
 * the event, so the trail can say "by Management" / "by MedRep" without a
 * live join to users.role, which would rewrite history for every past event
 * the moment someone's role changes (see admin role-change). Same guarded-
 * CHECK pattern as reconcileStatusCheck: Postgres cannot add a value to an
 * existing CHECK, only drop and re-add it, but this is the column's first
 * version so there is nothing to widen yet — just add it if missing.
 * Existing rows stay NULL: nobody recorded a role before this column
 * existed, and there is no reliable way to reconstruct one after the fact
 * (a live join would give a WRONG, not merely missing, answer for anyone
 * whose role has since changed) — same "don't invent history" reasoning as
 * raised_by_id not being backfilled onto every historical row.
 */
async function reconcileOrderEventsActorRole(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'order_events' AND column_name = 'actor_role'`
  );
  if (!rows.length) {
    console.log('  ↻ order_events.actor_role is missing — adding (existing rows stay NULL — no reliable way to know a past role now)');
    const list = REQUIRED_ROLES.map((r) => `'${r}'`).join(', ');
    await client.query(
      `ALTER TABLE order_events ADD COLUMN actor_role TEXT
         CHECK (actor_role IS NULL OR actor_role IN (${list}))`
    );
    console.log('  ✔ order_events.actor_role added');
    return;
  }
  console.log('  ✔ order_events.actor_role already present');
  // Sep 21, 2026: 'team_lead' — widen the same way reconcileUserRoleCheck
  // does, for a database where this column already existed before that role.
  await widenCheckConstraint(client, 'order_events', 'actor_role', REQUIRED_ROLES);
}

/**
 * Sep 18, 2026: order_items.price_remark — the MedRep's own note on a
 * line's pricing (why a discount was given, why the rate differs from the
 * product's own), so Management and Finance see the reason next to the
 * number wherever they review the order's items. Existing rows stay NULL:
 * nobody recorded a reason before this column existed.
 */
async function reconcileOrderItemsPriceRemark(client) {
  await client.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price_remark TEXT');
  console.log('  ✔ order_items.price_remark present');
}

/**
 * Sep 22, 2026: order_items.invoicing_from — a per-line override of the
 * order's own invoicing_from, the trigger for a split-invoicing order (see
 * order_split_sales_orders in schema.pg.sql and services/orderSplitService.js).
 * NULL on every existing row: nothing about an order that predates this
 * column changes — NULL means "follow the order", exactly what every order
 * has always done.
 */
async function reconcileOrderItemsInvoicingFrom(client) {
  await client.query(
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS invoicing_from TEXT
       CHECK (invoicing_from IS NULL OR invoicing_from IN ('2mg Incorporated', 'Getmeds Philippines Inc.'))`
  );
  console.log('  ✔ order_items.invoicing_from present');
}

/**
 * Sep 22, 2026: zoho_sync_queue.invoicing_from — which Sales Order a queued
 * retry is for. NULL on every existing row (and every row a non-split order
 * ever enqueues): the primary, exactly today's behavior. See
 * zohoRetryService.js's processOne.
 */
async function reconcileZohoSyncQueueInvoicingFrom(client) {
  await client.query(
    `ALTER TABLE zoho_sync_queue ADD COLUMN IF NOT EXISTS invoicing_from TEXT
       CHECK (invoicing_from IS NULL OR invoicing_from IN ('2mg Incorporated', 'Getmeds Philippines Inc.'))`
  );
  console.log('  ✔ zoho_sync_queue.invoicing_from present');
}

/**
 * Sep 22, 2026: orders.primary_finance_verified_at — see finance.controller.js's
 * verifyAccount and schema.pg.sql's own comment on the column. Only read/
 * written for a split-invoicing order; NULL and inert for every other one.
 */
async function reconcileOrderPrimaryFinanceVerified(client) {
  await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS primary_finance_verified_at TEXT');
  console.log('  ✔ orders.primary_finance_verified_at present');
}

/**
 * Sep 24, 2026: users.updated_at, and the trigger that keeps it.
 *
 * A trigger rather than `updated_at = ...` in each UPDATE because users is
 * written from many places (admin.controller, auth.controller, the Salesperson
 * services) and a column each of them has to remember to set is one that some
 * of them will not. Postgres fires it on every UPDATE, so nothing is missed.
 *
 * Existing accounts are backfilled with created_at: the honest answer for a
 * row whose real last change was never recorded is "no later than it was made"
 * rather than "just now", which would make every account look freshly edited.
 * The default is added AFTER the backfill for the same reason -- adding a
 * column with a volatile default stamps every existing row with the moment of
 * the migration.
 *
 * Idempotent: the column is IF NOT EXISTS, the backfill only touches NULLs,
 * the function is CREATE OR REPLACE and the trigger is dropped and recreated.
 */
async function reconcileUserUpdatedAt(client) {
  await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TEXT');
  await client.query('UPDATE users SET updated_at = COALESCE(created_at, iso_now()) WHERE updated_at IS NULL');
  await client.query('ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT iso_now()');
  await client.query(`
    CREATE OR REPLACE FUNCTION touch_user_updated_at() RETURNS trigger AS $touch$
    BEGIN
      -- An UPDATE that sets updated_at itself (a backfill, a restore) is left alone.
      IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
        NEW.updated_at := iso_now();
      END IF;
      RETURN NEW;
    END;
    $touch$ LANGUAGE plpgsql
  `);
  await client.query('DROP TRIGGER IF EXISTS trg_users_touch_updated_at ON users');
  await client.query(
    `CREATE TRIGGER trg_users_touch_updated_at
       BEFORE UPDATE ON users
       FOR EACH ROW EXECUTE FUNCTION touch_user_updated_at()`
  );
  console.log('  ✔ users.updated_at present, kept by trigger');
}

/**
 * Sep 26, 2026: sales_managers.scope_note. The sales_* tables are new tables and
 * arrive with the schema file; this only matters for a database that already had
 * sales_managers before the column was added. Idempotent.
 */
async function reconcileSalesManagerScopeNote(client) {
  await client.query('ALTER TABLE sales_managers ADD COLUMN IF NOT EXISTS scope_note TEXT');
  console.log('  ✔ sales_managers.scope_note present');
}

/**
 * Sep 24, 2026: 'patient' added to the customer categories. The category is a
 * CHECK-constrained column, so the list has to widen in the database as well as
 * in the code, or setting it fails with a constraint error.
 */
async function reconcileCustomerCategoryCheck(client) {
  await widenCheckConstraint(client, 'customers', 'category', ['doctor', 'hospital', 'distributor', 'pwd', 'patient']);
}

/**
 * Sep 24, 2026: users.username — see schema.pg.sql's comment on the column.
 * Nullable and not backfilled; the unique index is partial so the many NULLs
 * do not collide with each other.
 */
async function reconcileUserUsername(client) {
  await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT');
  await client.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username)) WHERE username IS NOT NULL'
  );
  console.log('  ✔ users.username present, unique case-insensitively');
}

/**
 * Sep 23, 2026: order_events.occurred_at_exact — see schema.pg.sql's comment
 * on the column for what it means. Defaults TRUE, so every existing row
 * (every one of them logged before this column existed, all with a genuine
 * time — Zoho's date-only backfill is the one case that needed FALSE, and it
 * only started being written the moment this migration lands) keeps reading
 * as exact, which is correct: nothing about a past row's own time changed by
 * this column showing up.
 */
async function reconcileOrderEventsOccurredAtExact(client) {
  await client.query('ALTER TABLE order_events ADD COLUMN IF NOT EXISTS occurred_at_exact BOOLEAN NOT NULL DEFAULT TRUE');
  console.log('  ✔ order_events.occurred_at_exact present');
}

/**
 * Sep 23, 2026: order_events, converted from a plain table into one
 * PARTITIONED BY RANGE (created_at) — see schema.pg.sql's comment on the
 * table for the full reasoning (this is the durable audit trail; 63% of its
 * 197,597 rows are a one-time historical Zoho import backfill; several
 * features query it in bulk across orders, which is what ruled out moving
 * old rows into a separate table instead). Every existing reader and writer
 * keeps querying `order_events` by the same name — Postgres routes each
 * query to the right partition transparently, so this needs zero changes
 * anywhere else in the codebase.
 *
 * Postgres cannot convert a plain table into a partitioned one in place, so
 * this builds the partitioned version alongside the original and swaps:
 * bulk-copy first (cheap at this row count), then a SHORT exclusive lock
 * only for the final catch-up-and-rename — `order_events` writes are
 * fire-and-forget audit logging, never on a request's critical path, so a
 * brief lock here is low-risk. The original table is kept, renamed rather
 * than dropped, as a safety net.
 *
 * Two partitions: `order_events_historical` (everything before a cutoff —
 * almost entirely the backfill, which Zoho itself dates as far back as
 * 2021) and `order_events_current` (the cutoff forward). The cutoff is
 * computed here, not hardcoded, as the start of the month six months before
 * whenever this migration actually runs — comfortably covers the backfill
 * (concentrated around Sep 10, 2026 and earlier) with a wide berth of real
 * activity left untouched, and stays correct no matter which day `npm run
 * migrate:pg` is actually run.
 *
 * Idempotent like every other reconcile here: checks pg_class.relkind = 'p'
 * (partitioned table) before doing anything, so a second run is a no-op.
 */
async function reconcileOrderEventsPartitioning(client) {
  const { rows: kindRows } = await client.query(
    `SELECT c.relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = 'order_events'`
  );
  if (!kindRows.length) {
    console.log('  ⚠ order_events table not found — skipping partitioning');
    return;
  }
  if (kindRows[0].relkind === 'p') {
    // Already partitioned — but a FRESH install's schema.pg.sql creates the
    // bare partitioned parent with no partition attached yet (a
    // `PARTITION OF` statement in that same file would fail against every
    // EXISTING database, which isn't partitioned until this function runs —
    // see schema.pg.sql's comment). So: partitioned with no partitions
    // means "brand new, empty, needs its one starter partition"; partitioned
    // WITH partitions means this already ran — nothing to do either way.
    const { rows: partRows } = await client.query(
      `SELECT 1 FROM pg_inherits WHERE inhparent = 'order_events'::regclass LIMIT 1`
    );
    if (!partRows.length) {
      await client.query(
        `CREATE TABLE order_events_current PARTITION OF order_events FOR VALUES FROM (MINVALUE) TO (MAXVALUE)`
      );
      console.log('  ✔ order_events partitioned parent had no partitions (fresh install) — added order_events_current covering everything');
      return;
    }
    console.log('  ✔ order_events is already partitioned');
    return;
  }

  console.log('  ↻ order_events is a plain table — converting to partitioned (copies ~200k rows)');

  // created_at is TEXT (this schema's iso_now() convention, not a native
  // timestamp type), so the partition bound must be a string in the exact
  // same format — iso_now()'s own format string, reused here rather than
  // duplicated by hand.
  const { rows: cutoffRows } = await client.query(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC' - interval '6 months'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff`
  );
  const cutoff = cutoffRows[0].cutoff;
  console.log(`  · partition cutoff: ${cutoff}`);

  const suffix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const legacyName = `order_events_legacy_${suffix}`;

  await client.query(`
    CREATE TABLE order_events_new (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY,
      order_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      actor_id INTEGER,
      actor_name TEXT,
      actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('medrep','finance','dispatch','management','admin','team_lead')),
      notes TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT iso_now(),
      occurred_at_exact BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `);
  await client.query(
    `ALTER TABLE order_events_new
       ADD CONSTRAINT order_events_new_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE`
  );
  await client.query(
    `ALTER TABLE order_events_new
       ADD CONSTRAINT order_events_new_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id)`
  );
  // Defined on the parent, propagates to every partition automatically —
  // same shape as the idx_order_events_order_created index every existing
  // per-order reader already depends on.
  await client.query(`CREATE INDEX order_events_new_order_created_idx ON order_events_new (order_id, created_at ASC)`);

  await client.query(
    `CREATE TABLE order_events_historical PARTITION OF order_events_new FOR VALUES FROM (MINVALUE) TO ('${cutoff}')`
  );
  await client.query(
    `CREATE TABLE order_events_current PARTITION OF order_events_new FOR VALUES FROM ('${cutoff}') TO (MAXVALUE)`
  );

  const copyAndSync = async () => {
    await client.query(`
      INSERT INTO order_events_new (id, order_id, event_type, old_status, new_status, actor_id, actor_name, actor_role, notes, metadata, created_at, occurred_at_exact)
      SELECT id, order_id, event_type, old_status, new_status, actor_id, actor_name, actor_role, notes, metadata, created_at, occurred_at_exact
        FROM order_events oe
       WHERE NOT EXISTS (SELECT 1 FROM order_events_new n WHERE n.id = oe.id)
    `);
    // The INSERT above supplies explicit ids, which does NOT advance a
    // GENERATED BY DEFAULT AS IDENTITY sequence on its own — without this,
    // the next real insert would try to reuse an id that already exists.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('order_events_new', 'id'), COALESCE((SELECT MAX(id) FROM order_events_new), 1))`
    );
  };

  await copyAndSync();
  const { rows: countRows } = await client.query('SELECT count(*)::int AS n FROM order_events_new');
  console.log(`  · copied ${countRows[0].n} rows into order_events_new`);

  // Short exclusive-lock window: catch up anything written to the OLD table
  // while the bulk copy above was running, then swap names — both renames
  // inside one transaction, so there's never a moment without an
  // `order_events` table under that name.
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE order_events IN EXCLUSIVE MODE');
    await copyAndSync();
    await client.query(`ALTER TABLE order_events RENAME TO ${legacyName}`);
    await client.query(`ALTER TABLE order_events_new RENAME TO order_events`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  console.log(`  ✔ order_events partitioned (historical/current split at ${cutoff}); original kept as ${legacyName}`);
}

/**
 * Sep 19, 2026: MedRep-requested, Management-approved attachment deletion —
 * see paymentProof.controller.js's requestDelete/decideDelete.
 *
 * `deletion_status` is the marker checked for the whole group: added first,
 * inline with its CHECK, the same way reconcileOrderEventsActorRole adds
 * actor_role. The rest are plain nullable columns with no default, added
 * alongside it — existing rows simply have nothing recorded, same reasoning
 * as reconcileWorkflowV2Columns.
 */
async function reconcileAttachmentDeletion(client) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'payment_proofs' AND column_name = 'deletion_status'`
  );
  if (rows.length) {
    console.log('  ✔ payment_proofs deletion-request columns already present');
    return;
  }
  console.log('  ↻ payment_proofs deletion-request columns are missing — adding');
  await client.query(
    `ALTER TABLE payment_proofs ADD COLUMN deletion_status TEXT NOT NULL DEFAULT 'none'
       CHECK (deletion_status IN ('none','requested','approved','rejected'))`
  );
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS zoho_pushed BOOLEAN NOT NULL DEFAULT false');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deletion_reason TEXT');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deletion_requested_by INTEGER REFERENCES users(id)');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deletion_requested_at TEXT');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deletion_decided_by INTEGER REFERENCES users(id)');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deletion_decided_at TEXT');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deletion_decision_note TEXT');
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS deleted_at TEXT');
  console.log('  ✔ payment_proofs deletion-request columns added');
}

/**
 * Sep 22, 2026: Phase 1 of moving attachment storage toward "Zoho is the
 * real, permanent copy" (see paymentProof.controller.js and
 * services/zohoAttachmentSync.js). `zoho_document_id` is what
 * getSalesOrderAttachment (ZohoAdapter.js) needs to read a file's bytes
 * back FROM Zoho — without it there is no way to know which of a Sales
 * Order's `documents[]` entries is this row. Null for every row uploaded
 * before this existed and for anything never successfully pushed; those
 * keep serving from local storage exactly as before, same as every other
 * additive column in this file.
 */
async function reconcileAttachmentZohoDocumentId(client) {
  await client.query('ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS zoho_document_id TEXT');
  console.log('  ✔ payment_proofs.zoho_document_id present');
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
    await reconcileUserRoleCheck(client);
    await reconcileTeamLead(client);
    await reconcileUserSalespersonColumn(client);
    await reconcileCustomerCreateColumns(client);
    await reconcileUserSalespersons(client);
    await reconcileOrderRaisedBy(client);
    await reconcileWorkflowV2Columns(client);
    await reconcileOrderTaxPreference(client);
    await reconcileOrderHeadquarter(client);
    await reconcileProductTaxColumns(client);
    await reconcileOrderEventsActorRole(client);
    await reconcileOrderItemsPriceRemark(client);
    await reconcileAttachmentDeletion(client);
    await reconcileAttachmentZohoDocumentId(client);
    await reconcileOrderItemsInvoicingFrom(client);
    await reconcileZohoSyncQueueInvoicingFrom(client);
    await reconcileOrderPrimaryFinanceVerified(client);
    await reconcileOrderEventsOccurredAtExact(client);
    await reconcileOrderEventsPartitioning(client);
    await reconcileUserUpdatedAt(client);
    await reconcileUserUsername(client);
    await reconcileCustomerCategoryCheck(client);
    await reconcileSalesManagerScopeNote(client);

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
