const db = require('../db/database');

/**
 * Does this column exist yet?
 *
 * Sep 14, 2026. Code and schema reach production separately: a push deploys
 * the code at once, while the migration runs whenever somebody runs it. On
 * this project that gap has already taken the Dispatch queue down once, when
 * a query named columns the migration had not added.
 *
 * A try/catch around the write is NOT enough, and the reason is Postgres
 * specific: inside a transaction, any failed statement aborts the whole
 * transaction, and everything after it — including COMMIT — fails too. So an
 * optional write inside order creation that hits a missing column takes the
 * whole order down with it, caught or not. The only safe move is to ask first
 * and skip the write, which is what this is for.
 *
 * A column that exists is cached for good — schemas only grow. A column that
 * does not is re-checked at most once a minute, so running the migration takes
 * effect without a restart.
 */

const RECHECK_MS = 60_000;
const known = new Map(); // "table.column" -> { present, at }

async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  const hit = known.get(key);
  if (hit && (hit.present || Date.now() - hit.at < RECHECK_MS)) return hit.present;

  let present = false;
  try {
    const row = await db
      .prepare(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`
      )
      .get(table, column);
    present = Boolean(row);
  } catch {
    present = false;
  }

  if (!present && !hit) {
    console.warn(
      `[SCHEMA] ${key} does not exist yet — the write that needs it is being skipped. ` +
        'Run `node src/db/migrate.pg.js`.'
    );
  }
  known.set(key, { present, at: Date.now() });
  return present;
}

/**
 * Does a CHECK constraint on this column accept this value yet?
 *
 * Sep 15, 2026: the same gap as hasColumn, for a new allowed value — the
 * 'dispatch_proof' attachment type is added to payment_proofs.file_type's
 * CHECK by the migration, and an INSERT before then fails as a database
 * error. Asked first so the caller can say "run the migration" instead.
 *
 * Reads the constraint's definition only to see whether the literal is in
 * it; no constraint on the column at all means anything goes. Same caching
 * as hasColumn: yes is kept, no is re-checked at most once a minute.
 */
const allowedValues = new Map(); // "table.column=value" -> { allowed, at }

async function constraintAllows(table, column, value) {
  const key = `${table}.${column}=${value}`;
  const hit = allowedValues.get(key);
  if (hit && (hit.allowed || Date.now() - hit.at < RECHECK_MS)) return hit.allowed;

  let allowed = false;
  try {
    const rows = await db
      .prepare(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema() AND t.relname = ? AND c.contype = 'c'`
      )
      .all(table);
    const onColumn = rows.map((r) => String(r.def || '')).filter((d) => d.includes(column));
    allowed = onColumn.length === 0 || onColumn.every((d) => d.includes(`'${value}'`));
  } catch {
    allowed = false;
  }

  if (!allowed && !hit) {
    console.warn(`[SCHEMA] ${table}.${column} does not accept '${value}' yet. Run \`node src/db/migrate.pg.js\`.`);
  }
  allowedValues.set(key, { allowed, at: Date.now() });
  return allowed;
}

function _resetForTest() {
  known.clear();
  allowedValues.clear();
}

module.exports = { hasColumn, constraintAllows, _resetForTest };
