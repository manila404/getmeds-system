#!/usr/bin/env node
/**
 * Reissue the Zoho refresh token with the scopes this app actually needs.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * Sep 11, 2026. Creating a customer failed with "You are not authorized to
 * perform this operation", which reads like a bad request and is not one. The
 * token this org runs on was issued with:
 *
 *   ZohoInventory.salesorders.CREATE  ZohoInventory.salesorders.READ
 *   ZohoInventory.contacts.READ       ZohoInventory.items.READ
 *
 * Contacts are READ-only, so no payload can ever create one. The same gap
 * means `updateContactTin` — built Sep 8 to satisfy Zoho's TIN requirement on
 * business contacts — has never worked against live either.
 *
 * A refresh token's scopes are fixed at the moment it is issued. They cannot
 * be widened later, so the only fix is to issue a new one.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/zoho-reissue-token.js --check
 *     What the CURRENT token in .env can do. Read-only, safe any time.
 *
 *   node scripts/zoho-reissue-token.js --scopes
 *     Prints the scope string to paste into a SELF CLIENT's Generate Code box.
 *     This org uses a Self Client, which is the simpler of Zoho's two flows:
 *     no redirect URI, no browser round trip, and the code is generated in the
 *     console itself.
 *
 *   node scripts/zoho-reissue-token.js --code PASTE_IT --self-client
 *     Exchanges a Self Client code. Sends no redirect_uri, because a Self
 *     Client has none and Zoho rejects the exchange if one is supplied.
 *
 *   node scripts/zoho-reissue-token.js --url
 *     The other flow, for a Server-based client with a registered redirect
 *     URI. Not what this org has.
 *
 * Nothing here writes to .env. The token is printed once and pasting it is a
 * deliberate act — a script that edits your secrets file while you are reading
 * its output is how the wrong token ends up in production.
 */
require('dotenv').config();

const ACCOUNTS = (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/$/, '');

/**
 * Credentials, overridable from the command line.
 *
 * Sep 11, 2026: added because a STALE CLIENT SECRET is indistinguishable from
 * every other failure here — Zoho answers `invalid_code` for a bad secret, a
 * bad code, and an expired code alike. Being able to try a secret without
 * first editing .env is the difference between testing a theory and betting
 * production on it.
 *
 *   --client-id 1000.XXX --client-secret YYY
 */
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
};
const CLIENT_ID = argOf('--client-id') || process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = argOf('--client-secret') || process.env.ZOHO_CLIENT_SECRET;

/**
 * Everything this app is allowed to do, in one place.
 *
 * The four it already has, plus the two it needs. Listed in full rather than
 * as "the new ones": consent REPLACES a token's scopes, it does not add to
 * them, so asking for only the missing two would produce a token that can
 * create contacts and no longer read items.
 */
const SCOPES = [
  'ZohoInventory.salesorders.CREATE',
  'ZohoInventory.salesorders.READ',
  'ZohoInventory.contacts.READ',
  'ZohoInventory.contacts.CREATE', // new — create a customer from the order form
  'ZohoInventory.contacts.UPDATE', // new — updateContactTin (TIN on a business contact)
  'ZohoInventory.items.READ'
];

const args = process.argv.slice(2);
const arg = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] || null;
};

/**
 * Zoho registers a redirect URI per client and refuses any other. Whatever was
 * registered for THIS client has to be passed back here byte-for-byte.
 */
const REDIRECT = arg('--redirect-uri') || process.env.ZOHO_REDIRECT_URI || 'https://www.zoho.com';

function requireCreds() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('\n✗ ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set in .env\n');
    process.exit(1);
  }
}

async function post(url) {
  const res = await fetch(url, { method: 'POST' });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Zoho returned something that is not JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

function printScopeReport(granted) {
  const have = new Set(String(granted || '').split(/\s+/).filter(Boolean));
  console.log('\n  scopes on this token:');
  for (const s of SCOPES) {
    console.log(`    ${have.has(s) ? '✓' : '✗ MISSING'}  ${s}`);
  }
  const extra = [...have].filter((s) => !SCOPES.includes(s));
  for (const s of extra) console.log(`    +  ${s}   (extra, not required)`);
  const missing = SCOPES.filter((s) => !have.has(s));
  return missing;
}

(async () => {
  requireCreds();

  // ── what the current token can do ─────────────────────────────────────────
  if (args.includes('--check')) {
    if (!process.env.ZOHO_REFRESH_TOKEN) {
      console.error('\n✗ No ZOHO_REFRESH_TOKEN in .env to check.\n');
      process.exit(1);
    }
    const p = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token'
    });
    const json = await post(`${ACCOUNTS}/oauth/v2/token?${p.toString()}`);
    if (json.error) {
      console.error(`\n✗ Zoho rejected the current refresh token: ${json.error}\n`);
      process.exit(1);
    }
    const missing = printScopeReport(json.scope);
    console.log(
      missing.length
        ? `\n  ${missing.length} scope(s) missing — run with --scopes to reissue.\n`
        : '\n  ✅ This token has everything the app needs.\n'
    );
    return;
  }

  // ── the scope string, for a Self Client ─────────────────────────────
  if (args.includes('--scopes')) {
    console.log('\n1. API Console \u2192 Self Client \u2192 Generate Code.');
    console.log('\n2. Paste this into the Scope box (one line, commas, no spaces):\n');
    console.log(SCOPES.join(','));
    console.log('\n3. Set the expiry to 10 minutes rather than 3 \u2014 the default leaves very');
    console.log('   little room if anything needs re-reading. Description can be anything.');
    console.log('\n4. CREATE. Pick organisation ' + process.env.ZOHO_ORG_ID + ' if asked, then copy the code.');
    console.log('\n5. node scripts/zoho-reissue-token.js --code THE_CODE --self-client\n');
    console.log('   The code is single-use and expires \u2014 generate it when ready to paste.\n');
    return;
  }

  if (args.includes('--url')) {
    const p = new URLSearchParams({
      scope: SCOPES.join(','),
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT,
      // Without this Zoho returns an access token and NO refresh token, which
      // is the single most common way this goes wrong: everything looks fine
      // for an hour and then stops.
      access_type: 'offline',
      // Force the consent screen. Zoho skips it for an app already approved
      // and hands back a token with the OLD scopes — the exact failure this
      // script exists to fix, repeated silently.
      prompt: 'consent'
    });

    console.log('\n1. Open this URL, sign in as a Zoho user with admin rights on org ' + process.env.ZOHO_ORG_ID + ':\n');
    console.log(`${ACCOUNTS}/oauth/v2/auth?${p.toString()}\n`);
    console.log(`2. Approve. You will be redirected to ${REDIRECT} with ?code=... in the address bar.`);
    console.log('   Copy the code value. It expires in about a minute.\n');
    console.log('3. node scripts/zoho-reissue-token.js --code THE_CODE\n');
    console.log(`   Redirect URI used: ${REDIRECT}`);
    console.log('   It must match what is registered for this client in the Zoho API Console');
    console.log('   EXACTLY, or Zoho answers "invalid_redirect_uri".');
    console.log('   Override with --redirect-uri "https://..." if yours differs.\n');
    return;
  }

  // ── step 2: exchange the code ─────────────────────────────────────────────
  const code = arg('--code');
  if (!code) {
    console.log('\nUsage:');
    console.log('  node scripts/zoho-reissue-token.js --check    what the current token can do');
    console.log('  node scripts/zoho-reissue-token.js --scopes   scope string for a Self Client  <-- this org');
    console.log('  node scripts/zoho-reissue-token.js --code XXX --self-client   exchange it');
    console.log('');
    console.log('  node scripts/zoho-reissue-token.js --url        the redirect-URI flow instead');
    console.log('  node scripts/zoho-reissue-token.js --code XXX   exchange the code\n');
    return;
  }

  // A Self Client has NO redirect URI. Sending one makes Zoho reject the
  // exchange, so it is omitted rather than defaulted — the two flows differ in
  // exactly this parameter and nothing else.
  const selfClient = args.includes('--self-client');
  const p = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    ...(selfClient ? {} : { redirect_uri: REDIRECT })
  });
  const json = await post(`${ACCOUNTS}/oauth/v2/token?${p.toString()}`);

  if (json.error) {
    console.error(`\n✗ Zoho refused the code: ${json.error}`);
    if (String(json.error).includes('invalid_code')) {
      console.error('  A code is single-use and short-lived. Three things produce this error:');
      console.error('');
      console.error('   1. It expired. The Self Client box defaults to 3 minutes — set it to 10.');
      console.error('   2. It was already used, including by a failed attempt.');
      console.error('   3. ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET in .env belong to a DIFFERENT app');
      console.error('      than the one the code came from. Zoho reports that as invalid_code');
      console.error('      rather than as a client mismatch, which is why it is worth checking:');
      console.error('');
      console.error(`      .env client id: ${CLIENT_ID.slice(0, 18)}…${CLIENT_ID.slice(-6)}`);
      console.error('      Compare against API Console → your app → Client Secret tab.');
      console.error('');
      console.error(`   Generate a fresh code with:  node ${require('path').basename(process.argv[1])} --scopes`);
    }
    if (String(json.error).includes('redirect_uri')) {
      console.error(
        selfClient
          ? '  Unexpected for a Self Client — re-run WITHOUT --self-client if this is a Server-based app.'
          : `  The redirect URI must match the Zoho API Console exactly. Used: ${REDIRECT}` +
            '\n  If this is a SELF CLIENT, re-run with --self-client (it has no redirect URI).'
      );
    }
    if (String(json.error).includes('invalid_client')) {
      console.error('  ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET in .env must belong to the SAME');
      console.error('  API Console app the code was generated from.');
    }
    console.error('');
    process.exit(1);
  }

  if (!json.refresh_token) {
    console.error('\n✗ Zoho returned an access token but NO refresh token.');
    console.error('  That happens when access_type=offline is missing, or when this client has');
    console.error('  already issued one and consent was skipped. Use --url, which sets both');
    console.error('  access_type=offline and prompt=consent.\n');
    process.exit(1);
  }

  const missing = printScopeReport(json.scope);
  if (missing.length) {
    console.error(`\n✗ The new token is STILL missing ${missing.length} scope(s).`);
    console.error('  Do not put this in .env — it would replace a working token with a worse one.');
    console.error('  The usual cause is the Zoho user not having rights to grant them on this org.\n');
    process.exit(1);
  }

  console.log('\n✅ New refresh token — put this in .env as ZOHO_REFRESH_TOKEN:\n');
  console.log(`ZOHO_REFRESH_TOKEN=${json.refresh_token}\n`);
  console.log('Then redeploy, and confirm with:');
  console.log('  node scripts/zoho-reissue-token.js --check\n');
  console.log('The old token keeps working until you replace it, so nothing breaks in between.\n');
})().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
