/**
 * Take a verified backup of the live database.
 *
 *   npm run backup                  # one backup, verified, old ones pruned
 *   npm run backup -- --keep 60     # override retention (default 30)
 *   npm run backup -- --quiet       # only print on failure (for cron)
 *
 * Sep 2, 2026. Written before go-live because ~120 rows in this database are
 * the only data Zoho cannot give back. Everything else — 94,980 customers and
 * 3,436 products — is a mirror that a Full Resync rebuilds. What it cannot
 * rebuild is `order_events` (who in THIS app did what, and when), `users`,
 * `dispatch_records`, `notifications`, the pipeline `status` of each order,
 * and the `intake_*` fields, which the schema says outright are never sent to
 * Zoho. Losing those means losing the audit trail, which is the thing this
 * system exists to produce.
 *
 * Two decisions worth knowing:
 *
 * 1. This uses better-sqlite3's ONLINE BACKUP API, not a file copy. In WAL
 *    mode, recent writes live in getmeds.db-wal, not in getmeds.db — so
 *    copying the .db file alone while the server is running yields a database
 *    missing the newest transactions, and copying the three files
 *    non-atomically can yield one that will not open at all. `db.backup()`
 *    takes a consistent snapshot of a live database, which is the entire
 *    reason it exists.
 *
 * 2. It VERIFIES before pruning. An unverified backup is a belief, not a
 *    backup: it opens the copy, runs PRAGMA integrity_check, and counts the
 *    rows that actually matter. If any of that fails the backup file is kept
 *    for inspection, nothing is deleted, and the exit code is non-zero so a
 *    cron job reports it.
 *
 * WHAT THIS DOES NOT DO: the copies land on the same disk as the original, so
 * this protects against a bad migration, an accidental delete, or corruption —
 * not against losing the server. Off-site copying is the next step and needs a
 * destination (Cloudflare R2, S3, a second machine). Until that exists, treat
 * this as half a backup strategy.
 *
 * TO RESTORE:
 *   1. Stop the server. On Windows a running process locks the file.
 *   2. Move data/getmeds.db, -wal and -shm somewhere safe. Do not delete them
 *      — the corrupt original is evidence if something needs diagnosing.
 *   3. Copy the chosen data/backups/getmeds-<timestamp>.db to
 *      data/getmeds.db. There is no -wal or -shm to restore; a backup is
 *      already a complete, checkpointed database.
 *   4. npm run migrate   (a backup from an older build may predate a column)
 *   5. Start the server, open an order, confirm its timeline is intact.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BACKEND = path.join(__dirname, '..');
const DB_DIR = process.env.GETMEDS_DB_DIR
  ? path.resolve(process.env.GETMEDS_DB_DIR)
  : path.join(BACKEND, 'data');
const SOURCE = path.join(DB_DIR, 'getmeds.db');
const BACKUP_DIR = path.join(DB_DIR, 'backups');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const keepIndex = args.indexOf('--keep');
const KEEP = keepIndex !== -1 ? Math.max(1, Number(args[keepIndex + 1]) || 30) : 30;

const log = (...a) => { if (!QUIET) console.log(...a); };
const fail = (msg) => { console.error(`\n❌ ${msg}\n`); process.exitCode = 1; };

/**
 * The tables Zoho cannot rebuild. Counted in both source and backup: a
 * backup that opens cleanly but lost the audit trail is the failure this is
 * actually guarding against, and integrity_check alone would not catch it.
 */
const IRREPLACEABLE = ['orders', 'order_events', 'order_items', 'users', 'dispatch_records', 'payments', 'notifications'];

/** Remove the -wal/-shm siblings of a database file, if any linger. */
const removeSiblings = (dbPath) => {
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
};

const countRows = (db, table) => {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  } catch {
    return null; // table absent on an older schema — reported, not fatal
  }
};

async function main() {
  if (!fs.existsSync(SOURCE)) {
    return fail(`No database at ${SOURCE}. Nothing to back up.`);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(BACKUP_DIR, `getmeds-${stamp}.db`);

  const source = new Database(SOURCE, { readonly: true });
  const before = Object.fromEntries(IRREPLACEABLE.map((t) => [t, countRows(source, t)]));

  log('\n── Database backup ─────────────────────────────────────\n');
  log(`  source: ${SOURCE}`);

  try {
    await source.backup(target);
  } catch (err) {
    source.close();
    return fail(`Backup failed: ${err.message}`);
  }
  source.close();

  // ---- verify -----------------------------------------------------------
  // Opened read-WRITE on purpose. The copy inherits WAL journal mode, so
  // merely opening it creates getmeds-<stamp>.db-wal and -shm beside it —
  // and a "backup" that is three files which must travel together is a worse
  // backup than one that is a single file. Switching the copy to journal_mode
  // = DELETE folds the WAL back in and removes them, leaving exactly one
  // self-contained file to copy off-site or restore. The app sets WAL again
  // itself whenever it opens a database (see db/database.js), so this costs
  // the restored copy nothing.
  let copy;
  try {
    copy = new Database(target);
  } catch (err) {
    return fail(`Backup was written but will not open: ${err.message}\n   Kept at ${target} for inspection.`);
  }

  const integrity = copy.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    copy.close();
    return fail(`Backup failed integrity_check: ${integrity}\n   Kept at ${target} for inspection.`);
  }

  const after = Object.fromEntries(IRREPLACEABLE.map((t) => [t, countRows(copy, t)]));
  try {
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.pragma('journal_mode = DELETE');
  } catch (err) {
    log(`  note: could not collapse the backup's WAL (${err.message}); siblings cleaned up below`);
  }
  copy.close();
  removeSiblings(target);

  const shortfalls = IRREPLACEABLE.filter(
    (t) => before[t] !== null && after[t] !== null && after[t] < before[t]
  );
  if (shortfalls.length) {
    // A snapshot may legitimately contain MORE rows than the pre-backup count
    // if someone wrote during it. Fewer is never legitimate.
    return fail(
      `Backup has fewer rows than the source in: ${shortfalls.join(', ')}.\n` +
        `   Kept at ${target}. Nothing was pruned.`
    );
  }

  const bytes = fs.statSync(target).size;
  log(`  backup: ${path.relative(BACKEND, target)}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  log('  integrity_check: ok');
  log('\n  Rows that Zoho cannot rebuild:');
  for (const t of IRREPLACEABLE) {
    log(`     ${String(after[t] === null ? 'n/a' : after[t]).padStart(7)}  ${t}`);
  }

  // ---- prune, only now that this backup is known good --------------------
  const existing = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^getmeds-.*\.db$/.test(f))
    .sort()
    .reverse();

  const stale = existing.slice(KEEP);
  for (const f of stale) {
    const p = path.join(BACKUP_DIR, f);
    fs.unlinkSync(p);
    removeSiblings(p); // -wal/-shm left by an older version of this script
  }

  log(`\n  ${existing.length - stale.length} backup(s) kept, ${stale.length} pruned (retention: ${KEEP}).`);
  log('\n  ⚠️  These sit on the same disk as the original, so this does not');
  log('      protect against losing the server. Copy them off-site too.\n');
}

main().catch((err) => fail(err.message));
