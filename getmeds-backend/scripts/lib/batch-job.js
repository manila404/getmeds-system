'use strict';

/**
 * Declare this process a BULK BATCH JOB, and make it a considerate one.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * Sep 11, 2026. Written after the bulk import and the trail repair knocked
 * real users off the deployed app. The symptom was the one that wastes the
 * most time: `POST /api/auth/login` returning 500 — not 401 — for a valid
 * account, intermittently, and looking perfectly healthy by the time anyone
 * went to investigate.
 *
 * The cause is that the scripts and the deployed app share ONE Supabase
 * pooler, and the defaults are lopsided:
 *
 *   deployed app   PGPOOL_MAX = 1   per serverless function instance
 *   local script   PGPOOL_MAX = 10  plus concurrent Zoho fetchers each writing
 *
 * So a script quietly claims ten times what a user-facing request gets, and it
 * holds them for as long as the run lasts. When the pooler has nothing left,
 * a function waits `connectionTimeoutMillis` (15s) and then throws — and an
 * unhandled database error surfaces as a 500. Login is simply the first thing
 * anyone notices, because it is the first thing anyone does.
 *
 * That was survivable for a 10-minute import. The enrichment campaign is
 * ~120,000 Zoho calls spread over days (see enrich-zoho-history.js), which
 * would mean days of intermittent 500s that no amount of reading the auth
 * code would explain.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *
 * Lowers this process's ceiling so the pooler keeps headroom for real
 * requests. A batch job has all night; a person waiting on a login page does
 * not, so the job is the one that should yield.
 *
 * Both values are DEFAULTS — an explicit environment variable still wins, so
 * a deliberate `PGPOOL_MAX=8 node scripts/…` for a maintenance window is
 * unaffected.
 *
 * ── HOW TO USE ──────────────────────────────────────────────────────────────
 *
 * Require it at the top of a bulk script, before the first query:
 *
 *   require('./lib/batch-job');
 *
 * Require order is forgiving on purpose: src/db/pg.js builds its pool lazily
 * on the first query, not at require time, so this only has to run before any
 * query is issued rather than before the db module is loaded.
 */

/** Connections a batch job may hold. Low enough to leave the app room. */
const BATCH_POOL_MAX = 2;

/**
 * Concurrent Zoho fetchers. Each one writes as it goes, so this multiplies
 * database pressure as well as API pressure — 3 was chosen for speed against
 * an idle database, before the two were known to contend.
 */
const BATCH_ZOHO_CONCURRENCY = 2;

process.env.GETMEDS_BATCH_JOB = '1';

if (!process.env.PGPOOL_MAX) {
  process.env.PGPOOL_MAX = String(BATCH_POOL_MAX);
}
if (!process.env.ZOHO_SO_IMPORT_CONCURRENCY) {
  process.env.ZOHO_SO_IMPORT_CONCURRENCY = String(BATCH_ZOHO_CONCURRENCY);
}

module.exports = {
  BATCH_POOL_MAX,
  BATCH_ZOHO_CONCURRENCY,
  /** One line for a script to print, so a run says what it is being polite about. */
  banner() {
    return (
      `Batch mode: ${process.env.PGPOOL_MAX} DB connection(s), ` +
      `${process.env.ZOHO_SO_IMPORT_CONCURRENCY} concurrent Zoho fetch(es) — ` +
      'leaving pooler headroom for the deployed app.'
    );
  }
};
