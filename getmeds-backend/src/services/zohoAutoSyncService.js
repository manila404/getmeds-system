const db = require('../db/database');
const { reconcileOrderFully } = require('./zohoReconcileService');
// Sep 11, 2026: the live copy of Zoho's Salesperson list.
const zohoSalespersonSync = require('./zohoSalespersonSync');
const zohoQuotaGuard = require('./zohoQuotaGuard');

/**
 * Keeps the audit trail current without anyone pressing a button.
 *
 * Sep 1, 2026 (3). Until now the only way a missed Zoho event reached this
 * app was a human opening the order and clicking "Sync from Zoho" — which is
 * why every entry on TestGM-20260901-0002 reads "backfilled by manual sync".
 * Webhooks are still the real mechanism and this does not replace them; four
 * of the seven Workflow Rules are not built yet, and the ones that are only
 * arrive while the tunnel to this machine is up. This is the safety net under
 * both of those.
 *
 * Two entry points, deliberately different in character:
 *
 *   1. A background poller (`start()`), every ZOHO_AUTO_SYNC_INTERVAL_MS,
 *      reconciling at most ZOHO_AUTO_SYNC_BATCH open orders per tick, oldest
 *      first. This is what makes notifications fire while nobody is looking.
 *   2. `shouldRefreshOnOpen()` / `markRefreshed()`, used by GET
 *      /api/orders/:id, so the order a human is actually staring at is fresh
 *      rather than up to a poll-interval stale.
 *
 * WHY THE THROTTLE MATTERS. Every reconcile is a real Zoho API read against
 * the live org, and the frontend re-fetches an order on a timer. Without a
 * cooldown, one person leaving the Order Detail page open would generate a
 * steady stream of Zoho calls for a single order, and the poller would
 * re-read orders it had just read seconds earlier. `orders.last_reconciled_at`
 * is the shared record of when each order was last pulled, so both paths
 * back off the same way and neither re-reads work the other just did.
 *
 * Terminal orders (completed / cancelled / deleted) are never polled — there
 * is nothing left in Zoho that can change their state, and they would
 * otherwise accumulate forever and crowd real work out of every batch.
 */

const INTERVAL_MS = parseInt(process.env.ZOHO_AUTO_SYNC_INTERVAL_MS, 10) || 15 * 60 * 1000; // 15 min on active pipeline (tracking_shared tiered to 6h)
const BATCH_SIZE = parseInt(process.env.ZOHO_AUTO_SYNC_BATCH, 10) || 10;
// A page open won't re-read an order Zoho was asked about this recently.
const OPEN_COOLDOWN_MS = parseInt(process.env.ZOHO_AUTO_SYNC_OPEN_COOLDOWN_MS, 10) || 3 * 60 * 1000; // 3 min
// Spacing between orders inside one tick, so a batch is a trickle rather than
// simultaneous requests at Zoho's rate limiter.
const STAGGER_MS = parseInt(process.env.ZOHO_AUTO_SYNC_STAGGER_MS, 10) || 400;
const TRACKING_SHARED_POLL_MS = parseInt(process.env.ZOHO_TRACKING_SHARED_POLL_MS, 10) || 6 * 60 * 60 * 1000; // 6h safety poll
const SALESPERSON_REFRESH_MS = parseInt(process.env.ZOHO_SALESPERSON_REFRESH_MS, 10) || 4 * 60 * 60 * 1000; // 4h
const SALESPERSON_SYNC_KEY = 'zoho_salesperson_sync:last_run';

const TERMINAL = ['completed', 'cancelled', 'deleted'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is `orders.last_reconciled_at` actually present?
 *
 * Sep 1, 2026 (4). This whole feature depends on a column added by
 * `npm run migrate`, and a running server can easily be ahead of its
 * database — pull the code, restart, forget the migration. That happened
 * immediately: the stamp write threw "no such column", the exception
 * escaped through GET /api/orders/:id, and the Order Detail page showed
 * "Failed to load order". An automatic convenience took out the page whose
 * entire job is displaying the order.
 *
 * So the feature now detects its own absence and switches itself off, loudly,
 * instead of breaking the app. Cached after the first look — the answer only
 * changes when someone runs a migration, which means a restart.
 */
let _hasColumn = null;
async function hasReconcileColumn() {
  if (_hasColumn !== null) return _hasColumn;
  try {
    _hasColumn = (await db.prepare('PRAGMA table_info(orders)').all()).some((c) => c.name === 'last_reconciled_at');
  } catch (err) {
    _hasColumn = false;
  }
  if (!_hasColumn) {
    console.warn(
      '\n⚠️  Zoho auto-sync is OFF: this database has no `orders.last_reconciled_at` column.\n' +
        '   Orders still load and the manual "Sync from Zoho" button still works.\n' +
        '   Fix: stop the server and run  npm run migrate\n'
    );
  }
  return _hasColumn;
}

/** Test hook — forget the cached answer after a migration inside one process. */
function _resetColumnCache() {
  _hasColumn = null;
}

function isEnabled() {
  // On by default. Set ZOHO_AUTO_SYNC_ENABLED=false to stop all background
  // polling (the refresh-on-open path keeps working — it costs nothing while
  // nobody is looking at an order).
  return (process.env.ZOHO_AUTO_SYNC_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

/**
 * Orders worth asking Zoho about: live, synced, and least-recently checked.
 * Active pipeline orders always run before old `tracking_shared` orders, which
 * only re-poll after TRACKING_SHARED_POLL_MS (6h) since invoice copy + webhooks
 * deliver credit payment settlements without polling 1,600+ shipped orders every tick.
 */
async function pickBatch(limit = BATCH_SIZE) {
  if (!(await hasReconcileColumn())) return [];
  const trackingCutoff = new Date(Date.now() - TRACKING_SHARED_POLL_MS).toISOString();
  return await db
    .prepare(
      `SELECT id, getmeds_order_id, status
       FROM orders
       WHERE zoho_so_id IS NOT NULL
         AND status NOT IN (${TERMINAL.map(() => '?').join(',')})
         AND (
           status <> 'tracking_shared'
           OR last_reconciled_at IS NULL
           OR last_reconciled_at <= ?
         )
       ORDER BY
         CASE WHEN status = 'tracking_shared' THEN 1 ELSE 0 END ASC,
         COALESCE(last_reconciled_at, '') ASC,
         updated_at ASC
       LIMIT ?`
    )
    .all(...TERMINAL, trackingCutoff, limit);
}

async function markRefreshed(orderId, when = new Date().toISOString()) {
  if (!(await hasReconcileColumn())) return false;
  try {
    await db.prepare('UPDATE orders SET last_reconciled_at = ? WHERE id = ?').run(when, orderId);
    return true;
  } catch (err) {
    // Bookkeeping. Never worth failing a request or a poll over.
    console.warn(`[ZOHO_AUTO_SYNC] could not stamp order ${orderId}: ${err.message}`);
    return false;
  }
}

/**
 * Has it been long enough since this order was last pulled from Zoho to be
 * worth doing again on a page open? Terminal orders always answer no.
 *
 * Answers no when the column is missing, rather than yes. Without somewhere to
 * record the stamp there is no cooldown, so every single page load — and the
 * frontend re-fetches on a timer — would be another read against the live org.
 * Off is the safe failure direction.
 */
async function shouldRefreshOnOpen(order) {
  if (!order || !order.zoho_so_id) return false;
  if (TERMINAL.includes(order.status)) return false;
  if (!(await hasReconcileColumn())) return false;
  const limitState = await zohoQuotaGuard.getDailyLimitStatus();
  if (limitState.limited) return false;
  if (!order.last_reconciled_at) return true;
  const age = Date.now() - new Date(order.last_reconciled_at).getTime();
  return !Number.isFinite(age) || age >= OPEN_COOLDOWN_MS;
}

/**
 * Reconcile one order and stamp it, whatever the outcome.
 *
 * The stamp is written even on failure ON PURPOSE: if Zoho is unreachable, an
 * unstamped order would sort to the front of the very next batch and the
 * poller would spend every tick retrying the same broken order instead of
 * moving through the queue. A transient failure costs one interval, not the
 * whole batch.
 */
async function reconcileOne(order, source) {
  // Sep 1, 2026 (6): ...Fully, not a single pass. One pass only ever backfills
  // ONE checkpoint, so an order several stages along in Zoho would have crept
  // forward one step per five-minute tick — half an hour to rebuild a trail
  // that Zoho could describe in full immediately.
  const result = await reconcileOrderFully({
    orderId: order.id,
    actorId: null,
    actorName: source === 'page_open' ? 'Auto Sync (order opened)' : 'Auto Sync',
    source
  });
  await markRefreshed(order.id);

  if (!result.ok) {
    console.warn(`[ZOHO_AUTO_SYNC] ${order.getmeds_order_id}: ${result.code} — ${result.message}`);
  } else if (result.actions && result.actions.length) {
    console.log(`[ZOHO_AUTO_SYNC] ${order.getmeds_order_id}: ${result.actions.join(' → ')}`);
  }
  return result;
}

/** One pass over a batch. Never throws — a bad order must not stop the rest. */
async function runOnce({ limit = BATCH_SIZE, source = 'auto_sync' } = {}) {
  const limitState = await zohoQuotaGuard.getDailyLimitStatus();
  if (limitState.limited) {
    return [];
  }

  // Gate Salesperson full-list sync to once every SALESPERSON_REFRESH_MS (4h)
  // via sync_state instead of spending an extra API read on every poller tick.
  try {
    const lastSpSyncRaw = await zohoQuotaGuard.readState(SALESPERSON_SYNC_KEY);
    const lastSpSyncMs = lastSpSyncRaw ? Date.parse(lastSpSyncRaw) : NaN;
    const spDue = !Number.isFinite(lastSpSyncMs) || Date.now() - lastSpSyncMs >= SALESPERSON_REFRESH_MS;
    if (spDue) {
      const summary = await zohoSalespersonSync.refresh();
      await zohoQuotaGuard.writeState(SALESPERSON_SYNC_KEY, new Date().toISOString()).catch(() => {});
      const changed = summary && ['added', 'renamed', 'deactivated', 'reactivated', 'removed', 'restored']
        .filter((k) => summary[k]).map((k) => `${summary[k]} ${k}`);
      if (changed && changed.length && !summary.first_run) {
        console.log(`[ZOHO_AUTO_SYNC] Salesperson list: ${changed.join(', ')}`);
        require('./salespersonService').clearCache();
      }
    }
  } catch (err) {
    console.warn('[ZOHO_AUTO_SYNC] Salesperson list refresh failed:', err.message);
    if (zohoQuotaGuard.isZohoDailyLimitError(err)) {
      await zohoQuotaGuard.tripDailyLimit(err.message);
      console.warn('[ZOHO_AUTO_SYNC] Zoho daily API rate limit hit — tripping shared circuit breaker.');
      return [];
    }
  }

  const orders = await pickBatch(limit);
  const results = [];
  for (const order of orders) {
    try {
      const res = await reconcileOne(order, source);
      results.push({ order: order.getmeds_order_id, ...res });
      if (res?.ok) {
        await zohoQuotaGuard.clearDailyLimit();
      } else if (!res?.ok && zohoQuotaGuard.isZohoDailyLimitError(res)) {
        await zohoQuotaGuard.tripDailyLimit(res.message);
        console.warn('[ZOHO_AUTO_SYNC] Zoho daily API rate limit hit — pausing rest of batch.');
        break;
      }
    } catch (err) {
      console.error(`[ZOHO_AUTO_SYNC] ${order.getmeds_order_id} threw:`, err.message);
      results.push({ order: order.getmeds_order_id, ok: false, message: err.message });
      if (zohoQuotaGuard.isZohoDailyLimitError(err)) {
        await zohoQuotaGuard.tripDailyLimit(err.message);
        console.warn('[ZOHO_AUTO_SYNC] Zoho daily API rate limit hit — pausing rest of batch.');
        break;
      }
    }
    if (STAGGER_MS > 0) await sleep(STAGGER_MS);
  }
  return results;
}

let intervalHandle = null;
let running = false;

/** Start the background poller. No-op if already started or disabled. */
function start(intervalMs = INTERVAL_MS) {
  if (intervalHandle) return intervalHandle;
  if (!isEnabled()) return null;

  intervalHandle = setInterval(() => {
    // Skip rather than overlap: a slow tick (twenty orders staggered against a
    // sluggish Zoho) can outlast the interval, and two concurrent passes would
    // pick the same batch — neither having stamped it yet — and double every
    // API call.
    if (running) return;
    running = true;
    runOnce()
      .catch((err) => console.error('[ZOHO_AUTO_SYNC] pass failed:', err.message))
      .finally(() => { running = false; });
  }, intervalMs);

  if (intervalHandle.unref) intervalHandle.unref();
  return intervalHandle;
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  running = false;
}

module.exports = {
  start,
  stop,
  runOnce,
  pickBatch,
  reconcileOne,
  shouldRefreshOnOpen,
  markRefreshed,
  hasReconcileColumn,
  isEnabled,
  _resetColumnCache,
  INTERVAL_MS,
  BATCH_SIZE,
  OPEN_COOLDOWN_MS
};
