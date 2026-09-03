/**
 * Scratch verification for the batched reconcileContacts rewrite (Sep 3, 2026).
 *
 * Not a Jest suite — it needs a database big enough to make the round-trip
 * count visible, and it counts queries, which the suite has no way to observe.
 * Run it by hand:
 *
 *   TEST_DATABASE_URL=... node tests/reconcileBatch.verify.js
 */
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.ZOHO_MODE = 'mock';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const db = require('../src/db/database');

// Count every query that reaches the database, so "did batching actually
// happen" is a measurement rather than an assumption.
let queries = 0;
const pg = require('pg');
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  queries++;
  return origQuery.apply(this, args);
};

const { __test__ } = require('../src/controllers/customers.controller');

function contact(i, over = {}) {
  return {
    contact_id: `VERIFY-${i}`,
    contact_name: `Verify Client ${i}`,
    customer_sub_type: i % 3 === 0 ? 'business' : 'individual',
    first_name: 'Ver',
    last_name: `Ify${i}`,
    phone: `0917000${String(i).padStart(4, '0')}`,
    billing_address: { address: `${i} Test St`, city: 'Manila' },
    status: 'active',
    ...over
  };
}

async function main() {
  const N = 2500;
  await db.prepare("DELETE FROM customers WHERE zoho_contact_id LIKE 'VERIFY-%'").run();

  const batch1 = [];
  for (let i = 0; i < N; i++) batch1.push(contact(i));
  batch1.push({ contact_name: 'No contact_id at all' }); // must be skipped
  batch1.push(contact(7)); // duplicate of an earlier one, must collapse

  queries = 0;
  let t = Date.now();
  const first = await __test__.reconcileContacts(batch1);
  const firstQueries = queries;
  const firstMs = Date.now() - t;

  console.log('first pass  ', first, `${firstQueries} queries, ${firstMs}ms`);
  assert(first.created === N, `created ${first.created}, expected ${N}`);
  assert(first.skipped === 1, `skipped ${first.skipped}, expected 1`);
  assert(first.updated === 1, `updated ${first.updated}, expected 1 (the duplicate)`);

  // 2500 rows / 500 per batch = 5 batches x (probe + upsert) = 10, plus
  // BEGIN/COMMIT and the DELETE above. The old per-row loop would be 5000+.
  assert(firstQueries < 40, `expected well under 40 queries, got ${firstQueries}`);

  // Second pass: same payload, so everything is an update and nothing is new.
  const batch2 = [];
  for (let i = 0; i < N; i++) batch2.push(contact(i, { contact_name: `Renamed ${i}` }));

  queries = 0;
  t = Date.now();
  const second = await __test__.reconcileContacts(batch2);
  console.log('second pass ', second, `${queries} queries, ${Date.now() - t}ms`);
  assert(second.created === 0, `created ${second.created}, expected 0`);
  assert(second.updated === N, `updated ${second.updated}, expected ${N}`);

  const renamed = await db
    .prepare('SELECT name, type, source FROM customers WHERE zoho_contact_id = ?')
    .get('VERIFY-9');
  assert(renamed.name === 'Renamed 9', `name not refreshed: ${renamed.name}`);
  assert(renamed.source === 'zoho', `source clobbered: ${renamed.source}`);

  // `type` must survive a local admin correction — the upsert must not
  // re-derive it from Zoho's customer_sub_type on every sync.
  await db.prepare('UPDATE customers SET type = ? WHERE zoho_contact_id = ?').run('credit', 'VERIFY-1');
  await __test__.reconcileContacts([contact(1)]);
  const corrected = await db
    .prepare('SELECT type FROM customers WHERE zoho_contact_id = ?')
    .get('VERIFY-1');
  assert(corrected.type === 'credit', `local type correction was overwritten: ${corrected.type}`);

  // is_active must mirror Zoho, including on update.
  await __test__.reconcileContacts([contact(2, { status: 'inactive' })]);
  const deactivated = await db
    .prepare('SELECT is_active FROM customers WHERE zoho_contact_id = ?')
    .get('VERIFY-2');
  assert(Number(deactivated.is_active) === 0, `is_active not mirrored: ${deactivated.is_active}`);

  // Progress must be reported, and monotonically.
  const seen = [];
  await __test__.reconcileContacts(batch2, { onProgress: (w) => seen.push(w) });
  assert(seen.length === Math.ceil(N / 500), `expected 5 progress calls, got ${seen.length}`);
  assert(seen[seen.length - 1] === N, `final progress ${seen[seen.length - 1]}, expected ${N}`);
  for (let i = 1; i < seen.length; i++) assert(seen[i] > seen[i - 1], 'progress went backwards');

  await db.prepare("DELETE FROM customers WHERE zoho_contact_id LIKE 'VERIFY-%'").run();
  console.log('\nOK — batched reconcileContacts verified');
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
