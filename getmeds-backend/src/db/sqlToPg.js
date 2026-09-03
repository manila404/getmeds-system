'use strict';

/**
 * SQLite -> PostgreSQL statement translation.
 *
 * Sep 2, 2026. This is the whole reason the port is mechanical instead of 183
 * individual rewrites. The governing rule is the one already set in
 * schema.pg.sql: CHANGE THE DIALECT, NOT THE DATA SHAPES. Everything here
 * exists to make Postgres behave the way SQLite behaved, so that 420 existing
 * tests remain a meaningful check on the port rather than a list of things
 * that were "expected" to change.
 *
 * Every transformation is literal-aware: the tokenizer below walks the string
 * once and only rewrites text OUTSIDE of '...' literals, "..." identifiers,
 * $$...$$ blocks, -- line comments and slash-star block comments. A naive
 * regex would corrupt data — `INSERT INTO notifications (message) VALUES
 * ('Order? LIKE this')` is a real shape in this codebase.
 */

/** Statement kinds we care about. */
const INSERT_RE = /^\s*(?:WITH[\s\S]+?\)\s*)?INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
const HAS_RETURNING_RE = /\bRETURNING\b/i;

/**
 * Walk `sql` and call back for each region, telling the caller whether it is
 * "code" (rewritable) or "quoted" (must be preserved byte for byte).
 */
function scan(sql, onCode, onQuoted) {
  let i = 0;
  let code = '';
  const n = sql.length;

  const flushCode = () => {
    if (code) {
      onCode(code);
      code = '';
    }
  };

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // -- line comment
    if (c === '-' && c2 === '-') {
      flushCode();
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      onQuoted(sql.slice(i, stop));
      i = stop;
      continue;
    }

    // /* block comment */  (SQLite and Postgres both have these)
    if (c === '/' && c2 === '*') {
      flushCode();
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      onQuoted(sql.slice(i, stop));
      i = stop;
      continue;
    }

    // '...' string literal, with '' as the escape (SQL standard, both engines)
    if (c === "'") {
      flushCode();
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      onQuoted(sql.slice(i, j));
      i = j;
      continue;
    }

    // "..." quoted identifier, with "" as the escape
    if (c === '"') {
      flushCode();
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      onQuoted(sql.slice(i, j));
      i = j;
      continue;
    }

    // $$ ... $$ / $tag$ ... $tag$ dollar quoting (schema.pg.sql uses it)
    if (c === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        flushCode();
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        onQuoted(sql.slice(i, stop));
        i = stop;
        continue;
      }
    }

    code += c;
    i += 1;
  }

  flushCode();
}

/**
 * SQLite date builtins -> the iso_now() function defined in schema.pg.sql.
 *
 * This is NOT cosmetic and it is NOT only a Postgres problem.
 *
 * SQLite's datetime('now') returns '2026-09-02 08:47:34' — space separated,
 * no T, no milliseconds, no Z. The application everywhere else writes
 * new Date().toISOString() -> '2026-09-02T08:47:34.376Z', and the schema
 * column defaults produce that too. So the 13 call sites using datetime('now')
 * are ALREADY writing a second, different format into columns that the code
 * SORTS AND COMPARES AS STRINGS. Space (0x20) sorts before 'T' (0x54), so a
 * row stamped by datetime('now') always sorts before an ISO-stamped row
 * regardless of actual time. That bug exists in SQLite today.
 *
 * In Postgres datetime() simply does not exist, so those 13 sites would throw
 * `function datetime(unknown) does not exist` — loudly, which is the one mercy.
 * Mapping them to iso_now() both fixes the pre-existing inconsistency and
 * makes them run.
 */
/**
 * Translate one SQLite statement into its PostgreSQL equivalent.
 *
 * Returns { text, paramCount, notes } where `notes` records every rewrite that
 * changed meaning, so a caller can log them once at boot instead of leaving
 * them invisible.
 */
function translate(sql, opts = {}) {
  const likeToIlike = opts.likeToIlike !== false;
  const notes = [];
  let param = 0;
  let out = '';

  scan(
    sql,
    (code) => {
      let c = code;

      // ? -> $1..$n   (better-sqlite3 is positional only; this codebase never
      // uses :named or ?NNN forms, verified by survey)
      c = c.replace(/\?/g, () => `$${++param}`);

      // LIKE -> ILIKE.
      //
      // SQLite's LIKE is case-insensitive for ASCII by default; Postgres's is
      // not. Rewriting here rather than at 5 call sites means the semantics
      // travel with the dialect, and a LIKE added next month cannot silently
      // stop matching. ILIKE is strictly more permissive than SQLite's LIKE
      // only for non-ASCII, so nothing that matched before stops matching.
      if (likeToIlike) {
        c = c.replace(/\bNOT\s+LIKE\b/gi, (m) => {
          notes.push('NOT LIKE -> NOT ILIKE');
          return 'NOT ILIKE';
        });
        c = c.replace(/\bLIKE\b/gi, (m) => {
          notes.push('LIKE -> ILIKE');
          return 'ILIKE';
        });
      }

      out += c;
    },
    (quoted) => {
      out += quoted;
    }
  );

  // Date builtins. Done on the assembled string because the argument is itself
  // a quoted literal ('now'), so it spans a code/quoted boundary.
  const beforeDates = out;
  out = out.replace(
    /\bstrftime\s*\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi,
    'iso_now()'
  );
  out = out.replace(/\bdatetime\s*\(\s*'now'\s*\)/gi, 'iso_now()');
  if (out !== beforeDates) notes.push("datetime('now')/strftime(...) -> iso_now()");

  /**
   * JULIANDAY(x) -> EXTRACT(EPOCH FROM x::timestamptz) / 86400.0
   *
   * Postgres has no julianday(); `SELECT JULIANDAY(created_at)` fails outright
   * with "function julianday(text) does not exist". The one use in this
   * codebase is the management dashboard's average processing time:
   *
   *     AVG((JULIANDAY(updated_at) - JULIANDAY(submitted_at)) * 24) AS avg_hours
   *
   * Epoch-seconds/86400 is not the same NUMBER as a Julian day — the two differ
   * by a fixed offset of 2440587.5 days — but both are "days as a float from a
   * fixed origin", and this expression only ever takes a DIFFERENCE, where the
   * offset cancels exactly. Verified: 1.5 days apart yields 36 hours either way.
   *
   * The ::timestamptz cast is what makes it work on the TEXT ISO-8601 columns
   * this schema deliberately keeps (see schema.pg.sql). Anything that is not
   * parseable as a timestamp raises an error rather than returning nonsense.
   *
   * DATE(x) needs no translation: Postgres accepts DATE(text) via an implicit
   * cast and the three uses here are all in WHERE clauses, where the comparison
   * against a bound 'YYYY-MM-DD' string works. It is NOT equivalent in a SELECT
   * list — Postgres returns a Date object where SQLite returned a string — so
   * that is flagged below rather than silently translated.
   */
  const beforeJulian = out;
  out = out.replace(
    /\bjulianday\s*\(\s*([A-Za-z_][A-Za-z0-9_."]*)\s*\)/gi,
    (_m, col) => `(EXTRACT(EPOCH FROM ${col}::timestamptz) / 86400.0)`
  );
  if (out !== beforeJulian) notes.push('JULIANDAY(col) -> EXTRACT(EPOCH ...)/86400.0');

  // DATE() in a SELECT list changes type (text -> Date object). In a WHERE
  // clause it is fine. Warn only for the risky shape.
  if (/\bSELECT\b[^]*?\bDATE\s*\(/i.test(out) && !/\bWHERE\b[^]*\bDATE\s*\(/i.test(out)) {
    notes.push('DATE() in a SELECT list returns a Date object in Postgres, a string in SQLite');
  }

  // Any surviving SQLite-only date call is a hard error waiting to happen at
  // runtime; surface it at translate time instead. Case-insensitive: the one
  // real use in this codebase is spelled JULIANDAY in capitals, and a
  // lowercase-only check reported a clean bill of health for it.
  const leftover = /\b(datetime|strftime|julianday|unixepoch)\s*\(/i.exec(out);
  if (leftover) {
    notes.push(`UNTRANSLATED SQLite date function: ${leftover[1]}()`);
  }

  return { text: out, paramCount: param, notes };
}

/**
 * Should this INSERT get a `RETURNING id` appended so run() can report
 * lastInsertRowid? Only when the target table actually has an `id` column —
 * order_id_sequences (PK `prefix`) and sync_state (PK `key`) do not, and both
 * are written by this codebase.
 */
function insertTarget(sql) {
  if (HAS_RETURNING_RE.test(sql)) return null;
  const m = INSERT_RE.exec(sql);
  return m ? m[1].toLowerCase() : null;
}

module.exports = { translate, scan, insertTarget };
