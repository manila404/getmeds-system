'use strict';

/**
 * Cron endpoints — the serverless replacement for the two setInterval loops.
 *
 * Sep 3, 2026. `server.js` starts zohoAutoSyncService and zohoRetryService with
 * setInterval AFTER app.listen(). Vercel never calls app.listen(), and timers
 * die when an invocation ends, so on serverless both loops simply do not exist.
 * These endpoints are what a scheduler calls instead.
 *
 * READ THIS BEFORE RELYING ON IT: on the Vercel Hobby plan, cron runs ONCE PER
 * DAY with up to 59 minutes of timing slop. A once-daily reconcile is not the
 * 5-minute cadence the auto-sync service was designed around — orders can sit
 * for most of a day if their Zoho webhook never arrives, and four of the seven
 * Workflow Rules do not exist yet. Per-minute cron needs Vercel Pro. This is a
 * platform limit, not something these endpoints can work around; the honest
 * options are Pro, an external scheduler (cron-job.org, GitHub Actions) hitting
 * these same URLs, or a host that keeps a process alive.
 */

const zohoAutoSyncService = require('../services/zohoAutoSyncService');
const zohoRetryService = require('../services/zohoRetryService');
const notificationRetentionService = require('../services/notificationRetentionService');
const { withLock } = require('../services/cronLock');

/**
 * Authenticate the caller.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is
 * set as an environment variable. Without that check these are public URLs that
 * trigger real Zoho traffic, which is both a cost and a way to hold the lock
 * open. Refusing when CRON_SECRET is unset is deliberate: an unset secret must
 * fail closed, the same way CORS_ALLOWED_ORIGINS does in app.js. The blank
 * ZOHO_WEBHOOK_SECRET is exactly this mistake and it is already on the go-live
 * blocker list.
 */
function authorize(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({
      success: false,
      error: {
        code: 'CRON_NOT_CONFIGURED',
        message: 'CRON_SECRET is not set. Refusing to run an unauthenticated scheduled job.',
      },
    });
    return false;
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.query.key;
  if (provided !== secret) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Bad cron secret' } });
    return false;
  }
  return true;
}

/**
 * POST/GET /api/cron/auto-sync
 *
 * Reconciles a batch of open orders against Zoho. Equivalent to one tick of
 * zohoAutoSyncService's interval.
 *
 * The batch is deliberately bounded. A Full Resync is ~475 sequential Zoho
 * reads and will not fit in a 300s function; this endpoint is the incremental
 * job, not the bulk one.
 */
exports.autoSync = async (req, res, next) => {
  if (!authorize(req, res)) return;
  try {
    // Sep 23, 2026: notification retention rides this same tick rather than
    // getting its own vercel.json cron entry — this project's plan already
    // uses both cron slots it has (auto-sync, zoho-retry), and unlike Zoho
    // sync this has no staleness requirement that needs its own schedule.
    // Own lock and own try/catch: a failure or overlap here must never block
    // or be blocked by the Zoho sync below, which is the part this endpoint
    // exists for. See notificationRetentionService.js for what/why.
    let retention = { ran: false, reason: 'skipped' };
    try {
      retention = await withLock('notification_retention', 4 * 60 * 1000, async () => await notificationRetentionService.purgeOnce());
    } catch (err) {
      console.error('[CRON] notification retention failed:', err.message);
      retention = { ran: false, reason: err.message };
    }

    if (!zohoAutoSyncService.isEnabled()) {
      return res.json({ success: true, data: { ran: false, reason: 'ZOHO_AUTO_SYNC_ENABLED=false', retention } });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || zohoAutoSyncService.BATCH_SIZE, 50);

    // 4-minute lease: shorter than the 300s function ceiling, so a killed
    // invocation's lock expires rather than blocking the next run.
    const outcome = await withLock('auto_sync', 4 * 60 * 1000, async () => await zohoAutoSyncService.runOnce({ limit, source: 'cron' })
    );

    if (!outcome.ran) {
      return res.json({ success: true, data: { ran: false, reason: 'another run holds the lock', retention } });
    }
    return res.json({ success: true, data: { ran: true, ...outcome.result, retention } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST/GET /api/cron/zoho-retry
 *
 * Drains the zoho_sync_queue outbox. Off unless ZOHO_AUTO_RETRY_ENABLED=true,
 * matching server.js — automatic retry was deliberately turned off on Aug 30
 * because a failing sync retried every 30s forever and buried the audit
 * timeline while a real problem was being diagnosed.
 */
exports.zohoRetry = async (req, res, next) => {
  if (!authorize(req, res)) return;
  try {
    if (process.env.ZOHO_AUTO_RETRY_ENABLED !== 'true') {
      return res.json({ success: true, data: { ran: false, reason: 'ZOHO_AUTO_RETRY_ENABLED is not true' } });
    }
    const outcome = await withLock('zoho_retry', 4 * 60 * 1000, async () => await zohoRetryService.processQueue());
    if (!outcome.ran) {
      return res.json({ success: true, data: { ran: false, reason: 'another run holds the lock' } });
    }
    return res.json({ success: true, data: { ran: true, ...outcome.result } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST/GET /api/cron/notification-retention
 *
 * Purges old `notifications` rows — see notificationRetentionService.js for
 * why this exists and the retention windows. Always on (no env-flag gate,
 * unlike zoho-retry): this is a plain cleanup with no Zoho traffic or
 * externally-visible side effect, so there's no failure mode worth an opt-in
 * switch for.
 */
exports.notificationRetention = async (req, res, next) => {
  if (!authorize(req, res)) return;
  try {
    const outcome = await withLock('notification_retention', 4 * 60 * 1000, async () => await notificationRetentionService.purgeOnce());
    if (!outcome.ran) {
      return res.json({ success: true, data: { ran: false, reason: 'another run holds the lock' } });
    }
    return res.json({ success: true, data: { ran: true, ...outcome.result } });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/cron/health
 *
 * Answers "did the scheduled jobs actually run?" — which on a once-a-day cron
 * with 59 minutes of slop is a question someone will need to ask. Reads the
 * lease rows cronLock leaves behind.
 */
exports.health = async (req, res, next) => {
  if (!authorize(req, res)) return;
  try {
    const db = require('../db/database');
    const rows = await db
      .prepare("SELECT key, value, updated_at FROM sync_state WHERE key ILIKE 'cron_lock:%' ORDER BY key")
      .all();
    res.json({
      success: true,
      data: {
        now: new Date().toISOString(),
        jobs: rows.map((r) => ({
          job: r.key.replace('cron_lock:', ''),
          lastRunAt: r.updated_at,
          leaseUntil: r.value,
          currentlyRunning: r.value > new Date().toISOString(),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};
