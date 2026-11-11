#!/usr/bin/env node
'use strict';

/**
 * Turn on withholding tax (TDS) for existing Zoho customers. Oct 9, 2026.
 *
 * WHY: Zoho shows "Tax deducted?" when a payment is recorded only for a customer with
 * is_tds_registered on. About 9 in 10 of the ~95,000 customers have it off (sampled), so
 * the option is missing when Finance records their payments. The 211 customers the app
 * created were fixed by hand (10.10 to 10.10.4); this does the older ones.
 *
 * WHICH CUSTOMERS: active customers with an order in the last N months (default 12),
 * newest orders first, skipping any already done (the progress file) and the 211 above.
 *
 * HOW: Zoho Books API, one customer at a time, throttled:
 *   1. GET the contact. Already on -> skip. Not a customer -> skip.
 *   2. PUT it back with the SAME contact_name and is_tds_registered true. The contact_name
 *      comes from Zoho itself, never from our copy, so nothing can be renamed.
 * Only that one flag is sent. Nothing is ever deleted.
 *
 * SAFE BY DEFAULT: without --apply it only reads our database and prints the plan. It never
 * calls Zoho. With --apply it stops by itself after --max-calls Zoho calls (a day's worth of
 * API allowance), on 3 errors in a row, or on a Zoho rate-limit answer. Rerun to continue:
 * progress is saved after every customer in zoho-tds-backfill-progress.json.
 *
 * TOKEN: needs a Zoho token with ZohoBooks.contacts.READ and ZohoBooks.contacts.UPDATE.
 * Put it in .env as ZOHO_SCRIPT_REFRESH_TOKEN (NOT ZOHO_REFRESH_TOKEN: that one is the live
 * app's and must not change). Same client id and secret as the app.
 *
 *   node scripts/zoho-tds-backfill.js                      dry run: counts and the first customers
 *   node scripts/zoho-tds-backfill.js --months 6           a smaller window
 *   node scripts/zoho-tds-backfill.js --apply --limit 5    try 5 customers for real
 *   node scripts/zoho-tds-backfill.js --apply --max-calls 4000
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPLY = process.argv.includes('--apply');
const MONTHS = Number(arg('--months', 12));
const LIMIT = Number(arg('--limit', 0)) || Infinity;
const MAX_CALLS = Number(arg('--max-calls', 4000));
const PAUSE_MS = Number(arg('--pause-ms', 700));
const ORG = process.env.ZOHO_ORG_ID || '714292728';
const PROGRESS = path.join(__dirname, 'zoho-tds-backfill-progress.json');
const DONE_CSV = path.join(__dirname, '..', '..', '..', 'getmeds-documents', 'zoho-customers-created-by-app-tds-2026-10-09.csv');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadProgress = () => (fs.existsSync(PROGRESS) ? JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) : { done: {}, skipped: {}, failed: {} });
const saveProgress = (p) => fs.writeFileSync(PROGRESS, JSON.stringify(p));

/** The 211 app-created customers already turned on by hand (id is the first CSV column). */
function alreadyDone() {
  const ids = new Set();
  if (!fs.existsSync(DONE_CSV)) return ids;
  for (const line of fs.readFileSync(DONE_CSV, 'utf8').split(/\r?\n/).slice(1)) {
    const id = line.split(',')[0];
    if (/^\d+$/.test(id)) ids.add(id);
  }
  return ids;
}

async function targets() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SET LOCAL statement_timeout = '30s'");
    const r = await c.query(
      `SELECT cu.zoho_contact_id AS id, cu.name, MAX(o.created_at) AS last_order
         FROM customers cu JOIN orders o ON o.customer_id = cu.id
        WHERE cu.zoho_contact_id IS NOT NULL AND cu.is_active = 1
          AND o.created_at >= to_char(now() - ($1 || ' months')::interval, 'YYYY-MM-DD')
        GROUP BY cu.zoho_contact_id, cu.name
        ORDER BY MAX(o.created_at) DESC`,
      [String(MONTHS)]
    );
    await c.query('ROLLBACK');
    return r.rows.map((x) => ({ id: String(x.id), name: x.name, lastOrder: x.last_order }));
  } finally {
    await c.end();
  }
}

let accessToken = null;
let tokenAt = 0;
async function token() {
  if (accessToken && Date.now() - tokenAt < 50 * 60 * 1000) return accessToken;
  const rt = process.env.ZOHO_SCRIPT_REFRESH_TOKEN;
  if (!rt) throw new Error('ZOHO_SCRIPT_REFRESH_TOKEN is not set in .env (see the header of this script).');
  const accounts = (process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, '');
  const res = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      refresh_token: rt, client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token'
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Zoho refused the token: ${j.error || res.status}`);
  if (!/ZohoBooks\.contacts\.UPDATE/.test(j.scope || '')) throw new Error(`The token has no ZohoBooks.contacts.UPDATE (scope: ${j.scope})`);
  accessToken = j.access_token;
  tokenAt = Date.now();
  return accessToken;
}

let calls = 0;
async function books(method, url, body) {
  calls += 1;
  const base = (process.env.ZOHO_BOOKS_API_BASE_URL || 'https://www.zohoapis.com/books/v3').replace(/\/+$/, '');
  const res = await fetch(`${base}${url}${url.includes('?') ? '&' : '?'}organization_id=${ORG}`, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, json: j };
}

async function main() {
  const progress = loadProgress();
  const skip = alreadyDone();
  const all = (await targets()).filter((t) => !skip.has(t.id) && !progress.done[t.id] && !progress.skipped[t.id]);
  const todo = all.slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);

  console.log(`Customers with an order in the last ${MONTHS} months, not yet done: ${all.length}`);
  console.log(`Already done before this run: ${Object.keys(progress.done).length} here, ${skip.size} by hand (the 211).`);
  console.log(`This run would handle: ${todo.length}${APPLY ? '' : '   (DRY RUN: nothing is sent to Zoho; add --apply)'}`);
  console.log('First customers:');
  for (const t of todo.slice(0, 8)) console.log(`  ${t.id}  ${String(t.lastOrder).slice(0, 10)}  ${t.name}`);
  if (!APPLY) return;

  let errorsInARow = 0;
  for (const t of todo) {
    if (calls >= MAX_CALLS) { console.log(`Stopped: reached --max-calls ${MAX_CALLS}. Rerun later to continue.`); break; }
    try {
      const got = await books('GET', `/contacts/${t.id}`);
      if (got.status === 429 || got.json.code === 1070) throw Object.assign(new Error('Zoho rate limit'), { limit: true });
      const c = got.json.contact;
      if (!c) throw new Error(`read failed: ${got.json.message || got.status}`);
      if (c.contact_type !== 'customer') { progress.skipped[t.id] = 'not a customer'; saveProgress(progress); continue; }
      if (c.is_tds_registered === true) { progress.done[t.id] = 'already on'; saveProgress(progress); errorsInARow = 0; continue; }
      await sleep(PAUSE_MS);
      const put = await books('PUT', `/contacts/${t.id}`, { contact_name: c.contact_name, contact_type: 'customer', is_tds_registered: true });
      if (put.status === 429 || put.json.code === 1070) throw Object.assign(new Error('Zoho rate limit'), { limit: true });
      const after = put.json.contact;
      if (!after || after.is_tds_registered !== true || after.contact_name !== c.contact_name) {
        throw new Error(`update did not confirm: ${put.json.message || put.status}`);
      }
      progress.done[t.id] = 'turned on';
      saveProgress(progress);
      errorsInARow = 0;
      console.log(`ON  ${t.id}  ${c.contact_name}`);
    } catch (err) {
      if (err.limit) { console.log('Stopped: Zoho says too many requests. Rerun later to continue.'); break; }
      progress.failed[t.id] = err.message;
      saveProgress(progress);
      errorsInARow += 1;
      console.log(`FAIL ${t.id}  ${t.name}: ${err.message}`);
      if (errorsInARow >= 3) { console.log('Stopped: 3 errors in a row.'); break; }
    }
    await sleep(PAUSE_MS);
  }
  console.log(`Zoho calls this run: ${calls}. Turned on: ${Object.values(progress.done).filter((v) => v === 'turned on').length} in total.`);
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
