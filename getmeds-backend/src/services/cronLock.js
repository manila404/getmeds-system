'use strict';

/**
 * A lock that survives having no process.
 *
 * Sep 3, 2026. `zohoAutoSyncService` guards against overlapping runs with a
 * module-level `let running = false`. That worked because there was one
 * long-lived process. On Vercel there is no process: every cron firing and
 * every request may be a different function instance with its own fresh copy
 * of that variable, so the guard silently protects nothing and two concurrent
 * reconciles can hit Zoho's rate limit or double-write the audit trail.
 *
 * The lock therefore has to live where the state lives — in the database.
 *
 * Implementation notes:
 *
 *   - The lock is a LEASE, not a flag. A flag set by a function that then times
 *     out or is killed stays set forever and the job never runs again, with no
 *     error anywhere. A lease expires on its own.
 *
 *   - Acquisition is ONE atomic statement. Read-then-write loses the race it is
 *     meant to prevent: two instances both read "free", both write "mine", both
 *     proceed.
 *
 *   - The stored value is an ISO-8601 expiry timestamp compared as a STRING.
 *     That is not a shortcut — it is the convention this schema already runs on
 *     (see the iso_now() note in schema.pg.sql), and ISO-8601 in UTC with fixed
 *     millisecond precision sorts identically as text and as time.
 */

const db = require('../db/database');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const keyFor = (name) => `cron_lock:${name}`;

/**
 * Try to take the lock. Returns true if this caller now holds it.
 *
 * The WHERE clause on the DO UPDATE is what makes this safe: the row is only
 * overwritten when the existing lease has already expired. A live lease makes
 * the statement affect zero rows, and `changes === 0` means "someone else has
 * it" rather than an error.
 */
async function acquire(name, ttlMs = DEFAULT_TTL_MS) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const res = await db
    .prepare(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES (?, ?, iso_now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = iso_now()
         WHERE sync_state.value < ?`
    )
    .run(keyFor(name), expiresAt, now);

  return res.changes === 1;
}

/**
 * Release the lock.
 *
 * Sets the lease to a past timestamp rather than deleting the row, so the row
 * remains as a record that the job exists and when it last ran — useful when
 * the question is "did the cron fire at all last night?".
 */
async function release(name) {
  const past = new Date(Date.now() - 1000).toISOString();
  await db.prepare('UPDATE sync_state SET value = ?, updated_at = iso_now() WHERE key = ?').run(past, keyFor(name));
}

/** Run `fn` only if the lock is free. Returns { ran, result }. */
async function withLock(name, ttlMs, fn) {
  if (!(await acquire(name, ttlMs))) return { ran: false, reason: 'locked' };
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    // Always released, including when fn throws — otherwise one failing run
    // blocks every subsequent one until the lease expires.
    await (await release(name)).catch((err) => console.error('[cronLock] release failed:', err.message));
  }
}

module.exports = { acquire, release, withLock, DEFAULT_TTL_MS };
