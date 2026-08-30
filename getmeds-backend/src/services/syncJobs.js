const crypto = require('crypto');

/**
 * In-memory job registry for the background Quick Sync / Full Resync pulls
 * (customers and inventory) — this is what lets the frontend show a live
 * percentage instead of a plain spinner for however long a full pull of a
 * large Zoho org takes, without adding WebSocket/SSE infrastructure to this
 * stack: the frontend starts a job (POST .../start, returns 202 + job_id
 * immediately) and polls GET /api/sync-jobs/:jobId every second or two.
 *
 * Deliberately in-memory, not persisted to the database — a job here is a
 * transient progress report for one in-flight pull, not a durable record of
 * anything. If the server process restarts mid-job, the job is simply gone
 * and the frontend's next poll gets a 404, which the UI treats as "this job
 * no longer exists" (show an error, let the user retry) rather than hanging
 * forever.
 *
 * This module itself never calls Zoho and never touches the local database
 * — it only tracks progress numbers for pulls that were already pure reads
 * before this feature existed (see customers.controller.js's and
 * inventory.controller.js's existing sync-from-zoho/sync-pull, and
 * ZohoAdapter.js's read-only contract).
 */

const jobs = new Map();

// Finished/errored jobs are swept out after this long — long enough that a
// client polling every second or two will always see the final status at
// least once, without jobs piling up in memory forever.
const RETENTION_MS = 15 * 60 * 1000;

function createJob({ type, mode }) {
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    type, // 'customers' | 'inventory'
    mode, // 'quick' | 'full'
    status: 'running', // 'running' | 'done' | 'error'
    processed: 0,
    // `total` is a best-effort ESTIMATE (from the previous Full Resync's
    // count, when known) — never an authoritative count. null means
    // unknown, and the frontend shows an indeterminate "N found so far"
    // counter instead of a percentage bar.
    total: null,
    percent: null,
    truncated: false,
    stoppedEarly: false,
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function updateProgress(id, { processed, total } = {}) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  if (processed !== undefined) job.processed = processed;
  if (total !== undefined && total !== null) job.total = total;
  // Capped at 99% while still running — even a good-faith estimate from a
  // prior Full Resync can be off (the org grows between runs), and nothing
  // should ever visually read as "100% done" before finishJob actually says so.
  job.percent = job.total ? Math.min(99, Math.round((job.processed / job.total) * 100)) : null;
}

function finishJob(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'done';
  job.result = result || null;
  job.truncated = !!result?.truncated;
  job.stoppedEarly = !!result?.stopped_early;
  job.percent = 100;
  job.finishedAt = new Date().toISOString();
  scheduleSweep(id);
}

function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.error = (error && error.message) || String(error);
  job.finishedAt = new Date().toISOString();
  scheduleSweep(id);
}

function scheduleSweep(id) {
  const t = setTimeout(() => jobs.delete(id), RETENTION_MS);
  if (typeof t.unref === 'function') t.unref();
}

module.exports = { createJob, getJob, updateProgress, finishJob, failJob };
