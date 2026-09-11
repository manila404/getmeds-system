'use strict';

/**
 * Async PostgreSQL data layer that keeps better-sqlite3's call shape.
 *
 * Sep 2, 2026. Replaces src/db/database.js. The point of this file is that the
 * 183 query sites across the controllers and services do NOT get creatively
 * rewritten — they keep reading:
 *
 *     const row = await db.prepare(SQL).get(a, b);
 *
 * with `await` added and the enclosing function made async. That turns the
 * diff into something a human can review in an afternoon instead of 183
 * individual judgement calls, which is where subtle errors come from.
 *
 * Three things here are load-bearing and are explained at their definitions:
 *
 *   1. translate()      — ? -> $n, LIKE -> ILIKE, datetime('now') -> iso_now()
 *   2. AsyncLocalStorage — how db.transaction() keeps working unchanged
 *   3. RETURNING id      — how run().lastInsertRowid keeps working
 */

const pgLib = require('pg');
const { Pool } = pgLib;
const { AsyncLocalStorage } = require('async_hooks');
const { translate, insertTarget } = require('./sqlToPg');

/**
 * Return COUNT(*) as a NUMBER, the way SQLite did.
 *
 * PostgreSQL's COUNT() returns bigint (oid 20), and node-postgres hands bigint
 * back as a STRING because a 64-bit integer does not always fit a JS number.
 * Measured on this schema: `SELECT COUNT(*) AS c FROM customers` yields the
 * string "2", not 2.
 *
 * Left alone that is a silent, wide behaviour change:
 *
 *   - 22 query sites in src/ read a count. The management dashboard would
 *     serialise `total_orders: "8"` into its JSON instead of 8.
 *   - SUM(CASE WHEN ... THEN 1 ELSE 0 END) is also bigint, so every customer
 *     statistic (credit, direct, uncategorized, active, inactive) becomes a
 *     string too.
 *   - ~20 test assertions compare counts with toBe(n), which is strict: "5"
 *     is not 5. Those would fail — the lucky part, since arithmetic like
 *     Math.ceil(total / limit) coerces and keeps working, so the API would
 *     have shipped string totals without complaining.
 *
 * Parsing int8 as a number restores the old behaviour exactly. The tradeoff is
 * precision above 2^53, which for row counts in a 500 MB database is not a
 * real risk; the guard below makes it loud rather than silent if it ever is.
 *
 * SUM/AVG over DOUBLE PRECISION already return JS numbers — verified — so the
 * money columns need nothing here. That is a direct consequence of
 * schema.pg.sql choosing DOUBLE PRECISION over NUMERIC, which would have had
 * this same string problem on every amount.
 */
pgLib.types.setTypeParser(20, (val) => {
  if (val === null) return null;
  const n = Number(val);
  if (!Number.isSafeInteger(n)) {
    console.warn(`[db] bigint ${val} exceeds Number.MAX_SAFE_INTEGER; returning as string`);
    return val;
  }
  return n;
});

/**
 * The current transaction's dedicated client, if we are inside one.
 *
 * better-sqlite3's db.transaction(fn) is synchronous, so every statement fn
 * ran was implicitly on the one connection. With a pool that is no longer
 * true: a naive port would run the statements inside a transaction on
 * DIFFERENT pooled connections, so BEGIN would be on one and the INSERTs on
 * another. The transaction would silently protect nothing — no error, no
 * rollback, just a lost guarantee on the exact code paths (order creation,
 * webhook status transitions) whose correctness is the point of this system.
 *
 * AsyncLocalStorage carries the checked-out client down the async call tree,
 * so db.prepare(...).run(...) inside a transaction callback finds it without
 * any call site having to pass it. That is what lets 27 transaction blocks
 * stay as they are.
 */
const txStore = new AsyncLocalStorage();

let pool = null;
let tablesWithId = new Set();
let ready = false;
const stmtCache = new Map();
const seenNotes = new Set();

function noteOnce(sql, notes) {
  for (const n of notes) {
    if (!n.startsWith('UNTRANSLATED')) continue;
    const key = `${n}::${sql.slice(0, 120)}`;
    if (seenNotes.has(key)) continue;
    seenNotes.add(key);
    console.warn(`[db] ${n}\n     in: ${sql.trim().slice(0, 200)}`);
  }
}

function connectionConfig() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at your Postgres connection string ' +
        '(Supabase: use the POOLED connection on port 6543 for serverless).'
    );
  }
  const cfg = { connectionString: url };

  // Supabase and Neon both terminate TLS with certificates Node does not have
  // in its default trust store for the pooler hostname. Every hosted provider
  // documents rejectUnauthorized:false here; it is not optional in practice.
  if (!/sslmode=disable/.test(url) && !/localhost|127\.0\.0\.1|\/tmp/.test(url)) {
    cfg.ssl = { rejectUnauthorized: false };
  }

  // Serverless: each function instance gets its own pool, and a Supabase free
  // project allows a modest number of direct connections. Keep it small and
  // let the provider's pooler do the real multiplexing.
  cfg.max = Number(process.env.PGPOOL_MAX || (process.env.VERCEL ? 1 : 10));
  cfg.idleTimeoutMillis = 10_000;
  cfg.connectionTimeoutMillis = 15_000;
  return cfg;
}

function getPool() {
  if (!pool) {
    pool = new Pool(connectionConfig());
    pool.on('error', (err) => {
      // A pooled connection dropped while idle (Supabase pausing, a network
      // blip). Log rather than let it become an unhandled 'error' event that
      // takes the process down.
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

/** The client to run on: the transaction's, or the pool. */
function runner() {
  return txStore.getStore() || getPool();
}

/**
 * Discover which tables have an `id` column, so run() knows where it can ask
 * for `RETURNING id`.
 *
 * Not hard-coded, because getting this list wrong is silent: an INSERT into a
 * table without `id` would fail, and an INSERT into one WITH `id` that we
 * forgot would return lastInsertRowid: undefined and the caller would look up
 * user `undefined`. Reading it from the live database cannot drift.
 */
async function loadIdTables() {
  const { rows } = await getPool().query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'id'`
  );
  tablesWithId = new Set(rows.map((r) => r.table_name.toLowerCase()));
}

/**
 * `PRAGMA table_info(x)` / `table_xinfo(x)` sent through prepare().
 *
 * db.pragma() has a shim for these, but the codebase also reaches them the
 * other way — `db.prepare('PRAGMA table_info(orders)').all()`. Left untranslated
 * that string goes to Postgres verbatim, raises a syntax error, and at the one
 * call site that matters it is caught:
 *
 *     try { _hasColumn = ...PRAGMA... } catch (err) { _hasColumn = false; }
 *
 * which SILENTLY TURNED THE ENTIRE ZOHO AUTO-SYNC FEATURE OFF. No crash, no
 * failing request — pickBatch() just returned [] forever and orders stopped
 * being reconciled. Ten tests caught it; nothing else would have.
 */
const PRAGMA_TABLE_INFO = /^\s*PRAGMA\s+table_x?info\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)\s*;?\s*$/i;

const COLUMNS_QUERY = `SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = $1
  ORDER BY ordinal_position`;

/** Shape the rows the way better-sqlite3's PRAGMA table_info did. */
const toPragmaRows = (rows) =>
  rows.map((r) => ({
    name: r.column_name,
    type: r.data_type,
    notnull: r.is_nullable === 'NO' ? 1 : 0,
    dflt_value: r.column_default,
  }));

class Statement {
  constructor(sql) {
    this.source = sql;

    const pragma = PRAGMA_TABLE_INFO.exec(sql);
    if (pragma) {
      this._pragmaTable = pragma[1].toLowerCase();
      this.text = COLUMNS_QUERY;
      this.paramCount = 1;
      this.notes = ['PRAGMA table_info -> information_schema.columns'];
      this._insertTable = null;
      this._returningText = null;
      return;
    }

    const t = translate(sql);
    noteOnce(sql, t.notes);
    this.notes = t.notes;
    this.text = t.text;
    this.paramCount = t.paramCount;

    const target = insertTarget(sql);
    this._insertTable = target;
    this._returningText = null; // resolved lazily, after loadIdTables()
  }

  _sqlFor(wantId) {
    if (!wantId || !this._insertTable) return this.text;
    if (this._returningText === null) {
      this._returningText = tablesWithId.has(this._insertTable)
        ? `${this.text} RETURNING id`
        : this.text;
    }
    return this._returningText;
  }

  async get(...params) {
    if (this._pragmaTable) return (await this.all())[0];
    const res = await runner().query(this.text, flatten(params));
    return res.rows[0];
  }

  async all(...params) {
    if (this._pragmaTable) {
      const res = await runner().query(this.text, [this._pragmaTable]);
      return toPragmaRows(res.rows);
    }
    const res = await runner().query(this.text, flatten(params));
    return res.rows;
  }

  /**
   * better-sqlite3 returns { changes, lastInsertRowid }.
   *
   * `changes` maps cleanly onto rowCount. `lastInsertRowid` has no Postgres
   * equivalent — there is no connection-scoped "last id" that is safe under a
   * pool — so INSERTs into tables that have an `id` get `RETURNING id`
   * appended and we read it back. Five call sites depend on this, including
   * admin account creation (admin.controller.js's create) and order creation
   * (orders.controller.js:875); both would break in ways that only show up
   * with a real user in front of them.
   */
  async run(...params) {
    const sql = this._sqlFor(true);
    const res = await runner().query(sql, flatten(params));
    const lastInsertRowid =
      sql !== this.text && res.rows && res.rows[0] ? res.rows[0].id : undefined;
    return { changes: res.rowCount, lastInsertRowid };
  }
}

/**
 * better-sqlite3 accepts both `.get(a, b)` and `.get([a, b])`. Preserve that,
 * since both forms appear in this codebase.
 */
function flatten(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

const db = {
  /** Statements are cached by source text, exactly as better-sqlite3 does. */
  prepare(sql) {
    let s = stmtCache.get(sql);
    if (!s) {
      s = new Statement(sql);
      stmtCache.set(sql, s);
    }
    return s;
  },

  /** Multi-statement DDL/DML with no parameters. */
  async exec(sql) {
    const t = translate(sql, { likeToIlike: false });
    await runner().query(t.text);
  },

  /**
   * db.transaction(fn) -> async (...args) => result
   *
   * Same call shape as better-sqlite3: it returns a function you invoke. The
   * only change at the 27 call sites is `await` and making the callback async.
   *
   * Nested calls join the outer transaction rather than opening a second one,
   * matching better-sqlite3's behaviour (it used SAVEPOINTs; joining is
   * sufficient here because no call site depends on partial rollback).
   */
  transaction(fn) {
    return async (...args) => {
      const existing = txStore.getStore();
      if (existing) return fn(...args); // already inside a transaction

      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const result = await txStore.run(client, () => fn(...args));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('[db] ROLLBACK failed:', rollbackErr.message);
        }
        throw err;
      } finally {
        client.release();
      }
    };
  },

  /**
   * PRAGMA shim. The 10 uses in this codebase are journal_mode, foreign_keys
   * and table_info(x) — the first two are SQLite storage concerns with no
   * Postgres meaning, the third is real introspection the auto-migrate code
   * needs.
   */
  async pragma(str) {
    const s = String(str).trim();
    const m = /^table_x?info\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)$/i.exec(s);
    if (m) {
      const { rows } = await runner().query(COLUMNS_QUERY, [m[1].toLowerCase()]);
      return toPragmaRows(rows);
    }
    // journal_mode / foreign_keys / anything else: no Postgres equivalent, and
    // nothing in this codebase reads the return value.
    return [];
  },

  /**
   * Must be awaited once at startup, before any query.
   *
   * The old database.js exported a CONNECTED instance and ran its auto-migrations
   * synchronously at require() time. Neither is possible against a network
   * database, so the work that used to happen implicitly on the first require
   * is explicit here.
   */
  async init() {
    if (ready) return db;
    await loadIdTables();
    if (!tablesWithId.size) {
      throw new Error(
        'Connected, but no tables found. Apply src/db/schema.pg.sql first.'
      );
    }
    ready = true;
    return db;
  },

  async close() {
    if (pool) {
      await pool.end();
      pool = null;
      ready = false;
      stmtCache.clear();
    }
  },

  /**
   * Escape hatch: run SQL with NO translation at all.
   *
   * Used by the verification harness to demonstrate what untranslated SQLite
   * SQL actually does on Postgres, and available for the rare hand-written
   * Postgres-specific query. Not for general use — anything going through here
   * loses the LIKE/datetime/placeholder guarantees.
   */
  async _rawQuery(sql, params = []) {
    const res = await runner().query(sql, params);
    return res.rows;
  },

  /** Exposed for tests and the migration checker. */
  _internals: { translate, get tablesWithId() { return tablesWithId; } },
};

module.exports = db;
