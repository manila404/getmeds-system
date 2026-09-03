'use strict';

/**
 * Verification harness for the database-backed cron lock.
 *
 * Run against a scratch Postgres:
 *   DATABASE_URL=postgres://... node tests/cronLock.verify.js
 *
 * The test that matters is "10 SIMULTANEOUS acquires: exactly one wins". The
 * lock replaces a module-level `let running = false` that was correct only
 * because there was one process; on serverless there are many, and a
 * read-then-write lock loses exactly the race it exists to prevent. Ten
 * concurrent acquires is the smallest thing that actually demonstrates the
 * atomic upsert holds.
 *
 * NOTE: this deletes rows under the 'cron_lock:' prefix in sync_state. It does
 * not touch the sync watermarks, but point it at a scratch database anyway.
 */

const assert = require('assert');
const db = require('./src/db/database');
const { acquire, release, withLock } = require('./src/services/cronLock');

let pass=0, fail=0;
async function t(name, fn){ try{ await fn(); pass++; console.log('  ok   '+name);}catch(e){fail++; console.log('  FAIL '+name+'\n       '+e.message);} }

(async () => {
  await db.init();
  await db.prepare("DELETE FROM sync_state WHERE key ILIKE 'cron_lock:%'").run();

  await t('first acquire succeeds', async () => {
    assert.strictEqual(await acquire('demo', 60000), true);
  });

  await t('second acquire while held FAILS', async () => {
    assert.strictEqual(await acquire('demo', 60000), false);
  });

  await t('acquire succeeds again after release', async () => {
    await release('demo');
    assert.strictEqual(await acquire('demo', 60000), true);
    await release('demo');
  });

  await t('an EXPIRED lease is stealable (a killed run does not block forever)', async () => {
    assert.strictEqual(await acquire('stale', 1), true);   // 1ms TTL
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(await acquire('stale', 60000), true, 'expired lease was not reclaimed');
    await release('stale');
  });

  await t('10 SIMULTANEOUS acquires: exactly one wins', async () => {
    await db.prepare('DELETE FROM sync_state WHERE key = ?').run('cron_lock:race');
    const results = await Promise.all(Array.from({length:10}, () => acquire('race', 60000)));
    const winners = results.filter(Boolean).length;
    assert.strictEqual(winners, 1, `expected exactly 1 winner, got ${winners}`);
    await release('race');
  });

  await t('withLock runs the job and releases', async () => {
    let ran = 0;
    const out = await withLock('job', 60000, async () => { ran++; return 'done'; });
    assert.strictEqual(out.ran, true);
    assert.strictEqual(out.result, 'done');
    assert.strictEqual(await acquire('job', 60000), true, 'lock not released after success');
    await release('job');
  });

  await t('withLock releases even when the job THROWS', async () => {
    await assert.rejects(withLock('boom', 60000, async () => { throw new Error('zoho down'); }), /zoho down/);
    assert.strictEqual(await acquire('boom', 60000), true, 'a failing run left the lock held forever');
    await release('boom');
  });

  await t('a second withLock during a running one is skipped, not queued', async () => {
    await db.prepare('DELETE FROM sync_state WHERE key = ?').run('cron_lock:overlap');
    let concurrent = 0, maxConcurrent = 0;
    const job = async () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await new Promise(r=>setTimeout(r,80)); concurrent--; };
    const [a,b] = await Promise.all([ withLock('overlap',60000,job), withLock('overlap',60000,job) ]);
    assert.strictEqual(maxConcurrent, 1, 'two reconciles ran at once');
    assert.strictEqual([a.ran,b.ran].filter(Boolean).length, 1, 'both runs executed');
    assert.ok([a,b].some(r => r.reason === 'locked'));
  });

  await t('health row records the last run time', async () => {
    const row = await db.prepare('SELECT key, value, updated_at FROM sync_state WHERE key = ?').get('cron_lock:job');
    assert.ok(row, 'no lease row left behind');
    assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.close();
  process.exit(fail?1:0);
})().catch(async e => { console.error(e); await db.close().catch(()=>{}); process.exit(1); });
