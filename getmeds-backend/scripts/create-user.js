'use strict';

/**
 * Create a real user account.
 *
 * Sep 3, 2026. This exists because there is no safe way to do this by hand. The
 * `users` table stores a bcrypt hash, so an `INSERT` typed into the Supabase SQL
 * editor would need a hash generated somewhere else, and a password column
 * filled with anything else is an account nobody can log into — or worse, one
 * that stores a plaintext password.
 *
 * The alternative it replaces is `npm run seed`, which creates six accounts
 * with the password `demo123`, including an admin. That is fine for a laptop
 * and completely wrong for a database on the public internet.
 *
 * Interactive:
 *   node scripts/create-user.js
 *
 * Non-interactive (CI, or scripted onboarding):
 *   node scripts/create-user.js --email a@getmeds.ph --name "Ana Cruz" \
 *     --role medrep --division B2B --password '...'
 *
 * Passing --password puts it in your shell history. Prefer the prompt.
 */

require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');

const ROLES = ['medrep', 'finance', 'dispatch', 'management', 'admin'];

// Sep 11, 2026: IMPORTED, not mirrored.
//
// This used to be a copy of auth.controller.js's list, described as mirroring
// it "exactly". It did not. Divisions were added and removed there on Sep 5
// and Sep 10 and this copy was never touched, so by today it rejected three
// real divisions (TeleSales, MD Telesales, PS) and still accepted five that
// had been deliberately deleted (2MG Incorporated, GrabMart, Office of the
// President, PCSO, DSWD).
//
// The failure was silent in the worst direction: creating a TeleSales manager
// errored with "Division must be one of…", which reads like the division is
// wrong rather than like this file is out of date.
//
// Importing costs one require and cannot drift.
const { DIVISIONS } = require('../src/controllers/auth.controller');

// Same cost the app uses everywhere it hashes (auth, admin, seed). A different
// cost here would still verify correctly, but keeping them equal means one
// number to change if it is ever raised.
const BCRYPT_ROUNDS = 10;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

function ask(rl, question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => resolve(a.trim()));

    // Hide typed characters. Without this the password sits in the terminal
    // scroll-back, and on Windows PowerShell also in the PSReadLine history
    // file on disk.
    const onData = (char) => {
      if (['\n', '\r', ''].includes(char.toString())) {
        process.stdin.removeListener('data', onData);
        return;
      }
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(question, (a) => {
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

/**
 * Reject the passwords that make an account worse than no account.
 *
 * Not a policy engine — just the specific failures that matter for a system
 * holding a medical order audit trail on a public URL.
 */
function passwordProblems(pw) {
  const problems = [];
  if (pw.length < 12) problems.push('at least 12 characters');
  if (!/[a-z]/.test(pw)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) problems.push('a digit');
  if (/^(demo|password|getmeds|admin|test)/i.test(pw)) problems.push('not to start with an obvious word');
  return problems;
}

async function main() {
  const args = parseArgs(process.argv);
  await db.init();

  /**
   * Prompting is only possible on a terminal. Under CI, a pipe, or a scripted
   * run there is nobody to answer, and a readline question there does not fail
   * — it waits forever, which looks exactly like a hung database connection.
   * So a non-TTY run either has the flag or errors saying which flag it needs.
   */
  const INTERACTIVE = process.stdin.isTTY === true;
  const rl = INTERACTIVE ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  /**
   * Take the value from a flag if the flag was PASSED, else prompt, else fall
   * back.
   *
   * Presence, not truthiness: `--division ""` is a deliberate "no division",
   * but it is falsy, so `args.division || prompt()` would prompt anyway and a
   * scripted run would hang on input that never comes.
   */
  const field = async (key, promptText, opts, fallback) => {
    if (key in args) return args[key];
    if (!INTERACTIVE) {
      if (fallback !== undefined) return fallback;
      throw new Error(`--${key} is required when there is no terminal to prompt on.`);
    }
    return ask(rl, promptText, opts);
  };

  try {
    const email = (await field('email', 'Email: ')).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${email}" is not an email address.`);

    // Checked before anything else is typed: finding out the account exists
    // after entering a password twice is a small insult.
    const existing = await db.prepare('SELECT id, role, is_active FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new Error(
        `${email} already exists (id ${existing.id}, role ${existing.role}, ` +
          `${existing.is_active ? 'active' : 'inactive'}).\n` +
          `  To change its password, use the admin screens rather than a second row.`
      );
    }

    const name = await field('name', 'Full name: ');
    if (!name) throw new Error('A name is required.');

    let role = (await field('role', `Role (${ROLES.join(' / ')}): `)).toLowerCase();
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);

    /**
     * Division and display name are how `users.salesperson` gets its value.
     *
     * That column is GENERATED as "<division> | <display name>" and it is what
     * LiveZohoAdapter puts on the Sales Order. A MedRep created without a
     * division gets salesperson = NULL, and their orders reach Zoho with no
     * salesperson on them — which is exactly the bug that was chased on Sep 2.
     * So it is required for medreps and optional for everyone else.
     */
    const needsSalesperson = role === 'medrep';
    const division = await field(
      'division',
      needsSalesperson ? `Division (required for medrep, one of: ${DIVISIONS.join(', ')}): ` : 'Division (optional): '
    );
    if (needsSalesperson && !division) {
      throw new Error(
        'A medrep needs a division. Without one users.salesperson is NULL and\n' +
          '  their Sales Orders reach Zoho with no salesperson attached.'
      );
    }
    if (division && !DIVISIONS.includes(division)) {
      throw new Error(`Division must be one of: ${DIVISIONS.join(', ')} (or blank for none).`);
    }
    const displayName = (await field('display_name', `Display name [${name}]: `, {}, name)) || name;

    let password = 'password' in args ? args.password : null;
    if (password === null && !INTERACTIVE) {
      throw new Error('--password is required when there is no terminal to prompt on.');
    }
    if (password === null) {
      for (;;) {
        password = await ask(rl, 'Password: ', { hidden: true });
        const problems = passwordProblems(password);
        if (problems.length) {
          console.log(`  Needs ${problems.join(', ')}.`);
          continue;
        }
        const again = await ask(rl, 'Confirm password: ', { hidden: true });
        if (again !== password) {
          console.log('  They do not match.');
          continue;
        }
        break;
      }
    } else {
      const problems = passwordProblems(password);
      if (problems.length) throw new Error(`Password needs ${problems.join(', ')}.`);
    }

    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    const res = await db
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, display_name, division, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(name, email, hash, role, displayName, division || null);

    const created = await db
      .prepare('SELECT id, name, email, role, division, display_name, salesperson, created_at FROM users WHERE id = ?')
      .get(res.lastInsertRowid);

    console.log('\n✅ Created:');
    console.log(`   id          ${created.id}`);
    console.log(`   email       ${created.email}`);
    console.log(`   role        ${created.role}`);
    console.log(`   salesperson ${created.salesperson || '(none — not a medrep, or no division)'}`);
    console.log('\nYou can log in with this account now.\n');
  } finally {
    if (rl) rl.close();
    await db.close();
  }
}

main().catch(async (err) => {
  console.error(`\n❌ ${err.message}\n`);
  await db.close().catch(() => {});
  process.exit(1);
});
