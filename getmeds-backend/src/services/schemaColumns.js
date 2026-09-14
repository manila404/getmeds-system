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

function _resetForTest() {
  known.clear();
}

module.exports = { hasColumn, _resetForTest };
