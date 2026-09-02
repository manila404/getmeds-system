const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

/**
 * Guards the `users` sign-up columns added Sep 2, 2026 — first/middle/last
 * name, display name, division, sub-division, and the GENERATED
 * `salesperson` column that reads "<division> | <display name>".
 *
 * Same shape as statusMigration.test.js: migrate.js runs in a CHILD PROCESS
 * with GETMEDS_DB_DIR pointed at a temp directory, because the db module is a
 * long-lived singleton and this is the only way to migrate a database that is
 * not data/getmeds.db.
 *
 * The reason this file exists rather than trusting ensureColumn:
 * `PRAGMA table_info` does NOT list generated columns. The first version of
 * this migration therefore decided `salesperson` was still missing on every
 * run after the first, tried to ALTER TABLE ADD it again, and blew up with
 * "duplicate column name: salesperson". A first migration always looked
 * fine; the SECOND one failed. So the important assertion here is not that
 * migrating works — it is that migrating TWICE works.
 */
describe('users sign-up fields migration', () => {
  const BACKEND = path.join(__dirname, '..');
  const NEW_COLUMNS = [
    'first_name',
    'middle_name',
    'last_name',
    'display_name',
    'division',
    'sub_division',
    'salesperson'
  ];

  let tmpDir;
  let dbPath;

  const openDb = () => new Database(dbPath);
  // table_xinfo, not table_info — see the note above. table_info would report
  // `salesperson` as absent even when it is right there.
  const columnsOf = (db, table) => db.prepare(`PRAGMA table_xinfo(${table})`).all().map((c) => c.name);

  const runMigrate = () =>
    execFileSync(process.execPath, [path.join(BACKEND, 'src/db/migrate.js')], {
      cwd: BACKEND,
      env: { ...process.env, GETMEDS_DB_DIR: tmpDir },
      stdio: 'pipe'
    });

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getmeds-userfields-'));
    dbPath = path.join(tmpDir, 'getmeds.db');

    // A database on the OLD users schema: schema.sql with the whole new
    // block — first_name through the generated salesperson column — cut out
    // of the CREATE TABLE, which is what a machine migrated before today has
    // on disk. Whitespace-agnostic, so a change in indentation (or line
    // endings) cannot quietly turn this fixture into a copy of the current
    // schema and leave the suite passing while testing nothing.
    const currentSchema = fs.readFileSync(path.join(BACKEND, 'src/db/schema.sql'), 'utf8');
    const oldSchema = currentSchema.replace(/\s*first_name\s+TEXT,[\s\S]*?\)\s*VIRTUAL,/, '');
    expect(oldSchema).not.toBe(currentSchema); // the cut actually matched

    const db = openDb();
    db.pragma('foreign_keys = ON');
    db.exec(oldSchema);

    // Read the fixture back from SQLite rather than trusting the string edit.
    for (const col of NEW_COLUMNS) expect(columnsOf(db, 'users')).not.toContain(col);

    // An account that predates the fields — the seeded logins look like this.
    db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('Admin User','admin@getmeds.ph','x','admin')").run();
    db.close();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('adds every sign-up column without disturbing the accounts already there', () => {
    runMigrate();

    const db = openDb();
    for (const col of NEW_COLUMNS) expect(columnsOf(db, 'users')).toContain(col);

    const admin = db.prepare("SELECT * FROM users WHERE email = 'admin@getmeds.ph'").get();
    expect(admin.name).toBe('Admin User');
    expect(admin.role).toBe('admin');
    // No division, so no Zoho salesperson mapping — and NULL says exactly that.
    expect(admin.salesperson).toBeNull();
    db.close();
  });

  test('derives salesperson as "<division> | <display name>"', () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO users (name,email,password_hash,role,first_name,middle_name,last_name,display_name,division,sub_division)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('Aaron Manila', 'aaron@getmeds.ph', 'x', 'medrep', 'Aaron', 'Pun-an', 'Manila', 'Aaron Manila', 'TEST', 'sample');

    expect(db.prepare("SELECT salesperson FROM users WHERE email='aaron@getmeds.ph'").get().salesperson)
      .toBe('TEST | Aaron Manila');
    db.close();
  });

  // The regression this whole file is really for.
  test('running the migration a second time is a clean no-op', () => {
    expect(() => runMigrate()).not.toThrow();

    const db = openDb();
    // Still exactly one of each — nothing was added twice, nothing was lost.
    const cols = columnsOf(db, 'users');
    for (const col of NEW_COLUMNS) {
      expect(cols.filter((c) => c === col)).toHaveLength(1);
    }
    expect(db.prepare("SELECT salesperson FROM users WHERE email='aaron@getmeds.ph'").get().salesperson)
      .toBe('TEST | Aaron Manila');
    expect(db.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(2);
    db.close();
  });

  // Documents the trap, so the next person to reach for table_info sees why.
  test('PRAGMA table_info hides the generated column — table_xinfo is the one to use', () => {
    const db = openDb();
    const info = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const xinfo = columnsOf(db, 'users');

    expect(info).not.toContain('salesperson');
    expect(xinfo).toContain('salesperson');
    // It is still perfectly readable — only the introspection pragma omits it.
    expect(db.prepare("SELECT salesperson FROM users WHERE email='aaron@getmeds.ph'").get()).toBeDefined();
    db.close();
  });
});
