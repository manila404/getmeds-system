/**
 * Generate the production secrets and write them into .env, in place.
 *
 *   npm run secrets:init          # fills anything missing or still on a default
 *   npm run secrets:init -- --force   # regenerate even if already set
 *
 * Sep 2, 2026. Replaces a hand-edit in Notepad, which is a poor way to handle
 * a secret: easy to paste into the wrong line, easy to leave the old value
 * behind, and easy to end up with the dev default still in place while
 * believing otherwise.
 *
 * Values come from crypto.randomBytes — a real CSPRNG. Get-Random in
 * PowerShell is not one, which is the other reason this is a script.
 *
 * The JWT secret is never printed. The webhook secret is, exactly once,
 * because it has to be pasted into Zoho's webhook configuration as the
 * X-Zoho-Webhook-Token header — no copy of it exists anywhere else.
 *
 * The existing .env is backed up first. Nothing here contacts Zoho or the
 * network at all.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const FORCE = process.argv.includes('--force');

// Values that mean "not really set" — the dev defaults this repo shipped with.
const PLACEHOLDERS = new Set(['', 'getmeds_secret_jwt_key_2026_demo', 'changeme', 'change_me', 'todo']);

const secret = (bytes) => crypto.randomBytes(bytes).toString('base64url');

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`\n❌ No .env found at ${ENV_PATH}.`);
    console.error('   Copy .env.example to .env first, then run this again.\n');
    process.exit(1);
  }
  return fs.readFileSync(ENV_PATH, 'utf8');
}

/** Current value of KEY=..., ignoring a trailing " # comment". */
function currentValue(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) return null;
  return match[1].replace(/\s+#.*$/, '').trim();
}

/** Replace KEY=... in place, or append it if the key is absent. */
function upsert(text, key, value, eol) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(text)) {
    return text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const sep = text.endsWith('\n') ? '' : eol;
  return `${text}${sep}${line}${eol}`;
}

function main() {
  let text = readEnv();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  // Into data/, NOT beside .env. .gitignore lists ".env" as an exact name, so
  // a sibling called ".env.bak-2026-09-02..." would not be ignored — a backup
  // full of live secrets, one `git add .` away from the repo. data/ is
  // ignored wholesale.
  const backupDir = path.join(__dirname, '..', 'data', 'env-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `env.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.copyFileSync(ENV_PATH, backup);

  const results = [];
  const plan = [
    { key: 'JWT_SECRET', bytes: 48, show: false },
    { key: 'ZOHO_WEBHOOK_SECRET', bytes: 32, show: true }
  ];

  for (const { key, bytes, show } of plan) {
    const existing = currentValue(text, key);
    const isPlaceholder = existing === null || PLACEHOLDERS.has(existing);

    if (!isPlaceholder && !FORCE) {
      results.push({ key, action: 'kept', show, value: existing });
      continue;
    }
    const value = secret(bytes);
    text = upsert(text, key, value, eol);
    results.push({ key, action: existing === null ? 'added' : 'replaced', show, value });
  }

  // Sep 11, 2026: SIGNUP_ENABLED / SIGNUP_ALLOWED_EMAIL_DOMAINS are no longer
  // written here — self-service sign-up was removed and nothing reads them.

  fs.writeFileSync(ENV_PATH, text);

  console.log('\n── Secrets ─────────────────────────────────────────────\n');
  for (const r of results) {
    const verb = { added: 'added', replaced: 'replaced', kept: 'already set — left alone' }[r.action];
    console.log(`  ${r.action === 'kept' ? '•' : '✅'} ${r.key}: ${verb}`);
  }

  const webhook = results.find((r) => r.key === 'ZOHO_WEBHOOK_SECRET');
  if (webhook && webhook.action !== 'kept') {
    console.log('\n  Paste this into Zoho as the X-Zoho-Webhook-Token header value:\n');
    console.log(`      ${webhook.value}\n`);
    console.log('  It is not stored anywhere else. Until Zoho sends this header, the');
    console.log('  receiver rejects its calls — which is the correct failure: while the');
    console.log('  secret was blank, it accepted calls from anyone.');
  }

  const jwt = results.find((r) => r.key === 'JWT_SECRET');
  if (jwt && jwt.action === 'replaced') {
    console.log('\n  JWT_SECRET was rotated, so every existing login is now invalid.');
    console.log('  Everyone signs in again. Restart the server to pick it up.');
  }

  console.log(`\n  Backup of the previous .env: data/env-backups/${path.basename(backup)}`);
  console.log('  (data/ is gitignored, so the backup cannot reach the repo.)\n');
}

main();
