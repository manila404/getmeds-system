#!/usr/bin/env node
/**
 * Why is the Zoho sync returning nothing?
 *
 * Sep 2, 2026. Written after "Quick Sync / Full Resync gives 0 clients" —
 * the failure is real but invisible: the background job logs its reason to
 * the SERVER console and reports it through a toast that is easy to miss,
 * and neither says which of the half-dozen possible causes it was.
 *
 * This walks the same path the sync does, one step at a time, and stops at
 * the first thing that is actually wrong:
 *
 *   1. Is the .env being read, and does it say `live`?
 *   2. Do the fail-closed org-id checks pass? (index.js refuses to build a
 *      live adapter otherwise, and that throw happens at import time.)
 *   3. Does the OAuth refresh-token grant actually return an access token?
 *      This is the most common one — a refresh token revoked in the API
 *      console, or a client secret with a stray character.
 *   4. Does ONE page of GET /contacts come back, and how many contacts are
 *      on it? A successful call returning zero is a completely different
 *      problem from a call that fails.
 *   5. What does the local database currently hold, and is a Quick Sync
 *      watermark set that would legitimately return nothing?
 *
 * READ-ONLY. It refreshes a token and reads one page of contacts. It writes
 * nothing to Zoho and nothing to the database.
 *
 *   node scripts/check-zoho.js
 */
require('dotenv').config();
const path = require('path');

const mask = (v) => {
  if (!v) return '(not set)';
  const s = String(v);
  if (s.length <= 8) return `${s[0]}***`;
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)`;
};

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const info = (m) => console.log(`     ${m}`);

async function main() {
  console.log('\n── Zoho connection check ───────────────────────────────\n');

  // ── 1. Environment ────────────────────────────────────────────────────
  console.log('1. Environment');
  const mode = (process.env.ZOHO_MODE || 'mock').toLowerCase();
  console.log(`  ZOHO_MODE                 ${mode}`);
  console.log(`  ZOHO_API_BASE_URL         ${process.env.ZOHO_API_BASE_URL || '(default)'}`);
  console.log(`  ZOHO_ACCOUNTS_URL         ${process.env.ZOHO_ACCOUNTS_URL || '(default) https://accounts.zoho.com'}`);
  console.log(`  ZOHO_ORG_ID               ${process.env.ZOHO_ORG_ID || '(not set)'}`);
  console.log(`  ZOHO_ALLOWED_ORG_IDS      ${process.env.ZOHO_ALLOWED_ORG_IDS || '(not set)'}`);
  console.log(`  ZOHO_CLIENT_ID            ${mask(process.env.ZOHO_CLIENT_ID)}`);
  console.log(`  ZOHO_CLIENT_SECRET        ${mask(process.env.ZOHO_CLIENT_SECRET)}`);
  console.log(`  ZOHO_REFRESH_TOKEN        ${mask(process.env.ZOHO_REFRESH_TOKEN)}`);
  console.log(`  ZOHO_DRY_RUN              ${process.env.ZOHO_DRY_RUN || '(not set)'}`);

  if (mode !== 'live') {
    bad(`ZOHO_MODE is "${mode}", not "live" — the sync is talking to the mock adapter, which has 3 fixture contacts.`);
    info('Set ZOHO_MODE=live in .env and restart the backend.');
    return;
  }

  // A trailing space or a stray quote in a credential is invisible in an
  // editor and produces a completely generic "invalid client" from Zoho.
  for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID']) {
    const raw = process.env[key];
    if (raw && raw !== raw.trim()) bad(`${key} has leading/trailing whitespace — that alone can break the token refresh.`);
    if (raw && /['"]/.test(raw)) bad(`${key} contains a quote character — check .env for stray quotes.`);
  }
  ok('.env loaded');

  // ── 2. Adapter construction (the fail-closed org allowlist) ───────────
  console.log('\n2. Adapter');
  let zoho;
  try {
    zoho = require(path.join(__dirname, '..', 'src', 'integrations', 'zoho'));
    ok(`built, mode=${zoho.mode}`);
  } catch (err) {
    bad(`refused to build: ${err.message}`);
    info('This is index.js\'s fail-closed check — fix ZOHO_ORG_ID / ZOHO_ALLOWED_ORG_IDS and re-run.');
    return;
  }

  // ── 3. OAuth ─────────────────────────────────────────────────────────
  console.log('\n3. OAuth token refresh');
  const accountsUrl = (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, '');
  let accessToken = null;
  try {
    const params = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });
    const res = await fetch(`${accountsUrl}/oauth/v2/token`, { method: 'POST', body: params });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      bad(`Zoho refused: ${data.error || res.statusText} (HTTP ${res.status})`);
      if (data.error === 'invalid_client') info('Client id or secret is wrong for this accounts domain.');
      if (data.error === 'invalid_code') info('The refresh token has been revoked or was never valid. Generate a new one.');
      info(`Accounts domain tried: ${accountsUrl} — a .com token does NOT work against .in/.eu/.com.au and vice versa.`);
      return;
    }
    accessToken = data.access_token;
    ok(`access token received (expires in ${data.expires_in || '?'}s, scope: ${data.scope || 'n/a'})`);
    if (data.api_domain) {
      info(`Zoho says api_domain = ${data.api_domain}`);
      const base = process.env.ZOHO_API_BASE_URL || '';
      if (base && !base.startsWith(data.api_domain)) {
        bad(`ZOHO_API_BASE_URL (${base}) is on a different domain than Zoho's api_domain — calls will 401.`);
        info(`Set ZOHO_API_BASE_URL=${data.api_domain}/inventory/v1`);
      }
    }
  } catch (err) {
    bad(`could not reach ${accountsUrl}: ${err.message}`);
    // undici hides the real reason on err.cause — "fetch failed" alone is
    // exactly the message that sent us looking in the wrong place.
    if (err.cause) info(`cause: ${err.cause.code || ''} ${err.cause.message || err.cause}`.trim());
    info('Network/proxy/firewall, or the accounts domain is wrong.');
    return;
  }

  // ── 4. One real read ─────────────────────────────────────────────────
  console.log('\n4. Reading contacts (ONE page, read-only)');
  // Deliberately a raw fetch rather than zoho.listContacts(): that method
  // walks EVERY page until Zoho says there are none left — ~475 calls for a
  // 95k-contact org, which is not a thing a diagnostic should spend. One
  // page is enough to tell a working connection from a broken one.
  const baseUrl = (process.env.ZOHO_API_BASE_URL || 'https://www.zohoapis.com/inventory/v1').replace(/\/+$/, '');
  try {
    const url =
      `${baseUrl}/contacts?organization_id=${encodeURIComponent(process.env.ZOHO_ORG_ID)}&page=1&per_page=25`;
    info(`GET ${baseUrl}/contacts (page 1, 25 per page)`);
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      bad(`HTTP ${res.status} — ${body.message || res.statusText}`);
      if (body.code) info(`Zoho code ${body.code}`);
      if (res.status === 401) info('401 — token rejected by this API domain. Usually a datacentre mismatch (see api_domain above).');
      if (res.status === 400) info('400 — often a wrong organization_id for this token.');
      return;
    }

    const contacts = body.contacts || [];
    if (contacts.length === 0) {
      bad('Zoho answered successfully but returned ZERO contacts.');
      info('So the credentials work — this org has no contacts visible to this token.');
      info('Check ZOHO_ORG_ID names the right organization, and that the token scope includes ZohoInventory.contacts.READ.');
    } else {
      ok(`${contacts.length} contact(s) on page 1${body.page_context ? ` — more pages: ${!!body.page_context.has_more_page}` : ''}`);
      for (const c of contacts.slice(0, 3)) {
        info(`${c.contact_name || c.company_name || '(unnamed)'} [${c.contact_id}] status=${c.status || 'n/a'}`);
      }
      info('The connection is fine — if the UI still shows 0, the failure is after this point (see the backend console).');
    }
  } catch (err) {
    bad(`could not reach ${baseUrl}: ${err.message}`);
    if (err.cause) info(`cause: ${err.cause.code || ''} ${err.cause.message || err.cause}`.trim());
    return;
  }

  // ── 5. Local state ───────────────────────────────────────────────────
  console.log('\n5. Local database');
  try {
    const db = require(path.join(__dirname, '..', 'src', 'db', 'database'));
    const n = (sql) => { try { return db.prepare(sql).get().c; } catch (e) { return 'n/a'; } };
    console.log(`  customers total           ${n('SELECT COUNT(*) c FROM customers')}`);
    console.log(`  customers active          ${n('SELECT COUNT(*) c FROM customers WHERE is_active = 1')}`);
    console.log(`  customers inactive        ${n('SELECT COUNT(*) c FROM customers WHERE is_active = 0')}`);
    console.log(`  products total            ${n('SELECT COUNT(*) c FROM products')}`);

    const watermark = db
      .prepare("SELECT value FROM sync_state WHERE key = 'customers_last_modified_watermark'")
      .get();
    if (watermark && watermark.value) {
      console.log(`  quick-sync watermark      ${watermark.value}`);
      info('A Quick Sync only asks for contacts modified AFTER this. If it returns 0, that may be correct —');
      info('use Full Resync (which ignores the watermark) to pull everything.');
    } else {
      console.log('  quick-sync watermark      (none — a Quick Sync will pull everything)');
    }
  } catch (err) {
    bad(`could not read the local database: ${err.message}`);
    info('If this says a column is missing, run: npm run migrate');
  }

  console.log('\nDone. Nothing was written to Zoho.\n');
}

main().catch((err) => {
  console.error('\n❌ Unexpected failure:', err);
  process.exitCode = 1;
});
