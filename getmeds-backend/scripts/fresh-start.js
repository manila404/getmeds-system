#!/usr/bin/env node
/**
 * Rebuild the local database from nothing, so testing can restart on a clean
 * system without touching Zoho.
 *
 * Sep 2, 2026. `reset-orders.js` (next to this file) clears orders but keeps
 * the ~95k-row Zoho customer/product mirror. This one goes further: the
 * database file itself is retired to data/backups/ and recreated from
 * schema.sql, which is what you want when a schema change or a half-migrated
 * table is part of what you are trying to leave behind.
 *
 * DOES:   back up data/getmeds.db (+ -wal/-shm) to data/backups/<timestamp>/
 *         create a new empty database from schema.sql   (npm run migrate)
 *         seed roles + the six login accounts            (npm run seed)
 *
 *         The database that comes out has NO customers and NO products. That
 *         is deliberate — as of Sep 2, 2026 seed.js no longer invents any
 *         (see the note at the top of it). Both tables are filled only by the
 *         read-only Full Resync from Zoho, which is step 2 below.
 *
 * NEVER:  calls the Zoho API. Not one request, in any direction. Nothing in
 *         the Zoho org is read, written, moved or deleted by this script —
 *         the local mirror is rebuilt afterwards by the existing read-only
 *         sync (customers.controller.js / inventory.controller.js).
 *
 * Requires --yes. Without it you get a dry run listing what would go where.
 *
 *   node scripts/fresh-start.js              # dry run
 *   node scripts/fresh-start.js --yes        # do it
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const force = args.includes('--force');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILES = ['getmeds.db', 'getmeds.db-wal', 'getmeds.db-shm'];
const PORT = Number(process.env.PORT) || 4000;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BACKUP_DIR = path.join(DATA_DIR, 'backups', stamp);

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The database must not be open when it is moved. On Windows a running server
// holds a lock and the rename fails with EBUSY/EPERM half way through, which
// would leave the data directory in a worse state than it started in.
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(700);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function main() {
  console.log('\n── Getmeds fresh start ─────────────────────────────────');

  const present = DB_FILES
    .map((f) => ({ name: f, full: path.join(DATA_DIR, f) }))
    .filter((f) => fs.existsSync(f.full))
    .map((f) => ({ ...f, size: fs.statSync(f.full).size }));

  if (!present.length) {
    console.log('\nNo existing database found — nothing to back up.');
  } else {
    console.log('\nWILL BACK UP  ->  ' + path.relative(ROOT, BACKUP_DIR));
    for (const f of present) console.log(`  ${f.name.padEnd(22)} ${bytes(f.size)}`);
  }

  console.log('\nWILL THEN');
  console.log('  npm run migrate            create an empty database from schema.sql');
  console.log('  npm run seed               roles + 6 login accounts, nothing else');
  console.log('\nWILL NOT');
  console.log('  touch Zoho                 no API call is made by this script');
  console.log('  invent customers/products  both tables come back empty, to be filled');
  console.log('                             by the read-only Full Resync afterwards');

  const busy = await portInUse(PORT);
  if (busy) {
    console.log(`\n⚠️  Something is listening on port ${PORT} — the backend looks like it is running.`);
    console.log('   Stop it first (Ctrl+C in its terminal), otherwise the database file is locked');
    console.log('   and the backup cannot be moved cleanly.');
    if (!force) {
      console.log('   Refusing to continue. Re-run once it is stopped (or add --force).\n');
      process.exitCode = 1;
      return;
    }
    console.log('   --force given, continuing anyway.');
  }

  if (!confirmed) {
    console.log('\nDry run — nothing was changed.');
    console.log('Re-run with --yes to go ahead:  node scripts/fresh-start.js --yes\n');
    return;
  }

  // 1. Back up
  if (present.length) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const f of present) {
      fs.renameSync(f.full, path.join(BACKUP_DIR, f.name));
      console.log(`  moved ${f.name}`);
    }
    console.log(`\n✅ Backup at ${path.relative(ROOT, BACKUP_DIR)}`);
  }

  // 2. Recreate
  const run = (cmd) => {
    console.log(`\n$ ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true });
  };
  run('npm run migrate');
  run('npm run seed');

  // 3. Report. Nothing left to clean up: seed.js stopped inventing customers
  //    and products on Sep 2, 2026, so they are already empty and stay that
  //    way until the Full Resync fills them from Zoho.
  const db = require('../src/db/database');

  const n = (t) => {
    try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { return 'n/a'; }
  };
  console.log('\nNEW DATABASE');
  for (const t of ['users', 'roles', 'customers', 'products', 'orders', 'order_items',
                   'order_events', 'payments', 'dispatch_records', 'notifications',
                   'zoho_sync_queue', 'sync_state']) {
    console.log(`  ${t.padEnd(20)} ${n(t)}`);
  }

  console.log('\nNEXT');
  console.log('  1. Start the backend:  npm start');
  console.log('  2. Log in as admin and run Full Resync for customers and inventory');
  console.log('     to pull the real ~95k contacts / ~3.4k items back from Zoho (reads only).');
  console.log('  3. Change the seeded demo123 passwords before anyone real uses this.\n');
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  console.error('   If the backup had already moved, the old database is under data/backups/.');
  process.exitCode = 1;
});
