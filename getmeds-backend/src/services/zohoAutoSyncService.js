const db = require('../db/database');
const { reconcileOrderFully } = require('./zohoReconcileService');
// Sep 11, 2026: the live copy of Zoho's Salesperson list.
const zohoSalespersonSync = require('./zohoSalespersonSync');

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

const INTERVAL_MS = parseInt(process.env.ZOHO_AUTO_SYNC_INTERVAL_MS, 10) || 5 * 60 * 1000; // 5 min
const BATCH_SIZE = parseInt(process.env.ZOHO_AUTO_SYNC_BATCH, 10) || 20;
// A page open won't re-read an order Zoho was asked about this recently.
const OPEN_COOLDOWN_MS = parseInt(process.env.ZOHO_AUTO_SYNC_OPEN_COOLDOWN_MS, 10) || 60 * 1000; // 1 min
// Spacing between orders inside one tick, so a batch is a trickle rather than
// twenty simultaneous requests at Zoho's rate limiter.
const STAGGER_MS = parseInt(process.env.ZOHO_AUTO_SYNC_STAGGER_MS, 10) || 400;

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

/** Orders worth asking Zoho about: live, synced, and least-recently checked. */
async function pickBatch(limit = BATCH_SIZE) {
  if (!(await hasReconcileColumn())) return [];
  return await db
    .prepare(
      `SELECT id, getmeds_order_id, status
       FROM orders
       WHERE zoho_so_id IS NOT NULL
         AND status NOT IN (${TERMINAL.map(() => '?').join(',')})
       ORDER BY COALESCE(last_reconciled_at, '') ASC, updated_at ASC
       LIMIT ?`
    )
    .all(...TERMINAL, limit);
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
  // Sep 11, 2026: Zoho's Salesperson list first — one read per tick. It goes
  // BEFORE the orders so a rename is carried to every stored copy of the old
  // name before any order is compared against Zoho; otherwise each order
  // reconciled in the same tick would log the rename as a Salesperson edit.
  try {
    const summary = await zohoSalespersonSync.refresh();
    const changed = summary && ['added', 'renamed', 'deactivated', 'reactivated', 'removed', 'restored']
      .filter((k) => summary[k]).map((k) => `${summary[k]} ${k}`);
    if (changed && changed.length && !summary.first_run) {
      console.log(`[ZOHO_AUTO_SYNC] Salesperson list: ${changed.join(', ')}`);
      require('./salespersonService').clearCache();
    }
  } catch (err) {
    console.warn('[ZOHO_AUTO_SYNC] Salesperson list refresh failed:', err.message);
  }

  const orders = await pickBatch(limit);
  const results = [];
  for (const order of orders) {
    try {
      results.push({ order: order.getmeds_order_id, ...(await reconcileOne(order, source)) });
    } catch (err) {
      console.error(`[ZOHO_AUTO_SYNC] ${order.getmeds_order_id} threw:`, err.message);
      results.push({ order: order.getmeds_order_id, ok: false, message: err.message });
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
