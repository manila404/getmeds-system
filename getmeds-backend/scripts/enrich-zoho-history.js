#!/usr/bin/env node
/**
 * Fill in Zoho detail and history for orders that were adopted from the list
 * but never enriched — 3c-2.
 *
 * ── WHY THIS IS A SEPARATE SCRIPT ───────────────────────────────────────────
 *
 * Sep 10, 2026. The full import (scripts/import-zoho-orders.js) does two jobs
 * in one pass: adopt every Sales Order from Zoho's list, then spend a capped
 * budget pulling per-order detail. Once the first job is done — and one full
 * run finishes it — repeating the whole thing to make progress on the second
 * means re-walking ~305 pages of a list whose answer is already in the orders
 * table.
 *
 * That matters because of the arithmetic. This org has ~60,800 adopted orders
 * and each costs TWO Zoho GETs (detail + comments), so enriching all of them
 * is ~121,600 requests. Zoho Books enforces a per-minute rate limit and a
 * daily call budget per org, which makes this a campaign run over days, not an
 * afternoon. Spending ~305 calls per pass re-reading the list is a third of a
 * small pass thrown away, every pass.
 *
 * So this drives enrichPendingDetail, which asks Postgres what is outstanding
 * instead of asking Zoho.
 *
 * ── IT SHARES THE DATABASE WITH REAL USERS ──────────────────────────────────
 *
 * Sep 11, 2026. This is the longest-running job in the system, and it points
 * at the same Supabase pooler the deployed app uses. An earlier bulk run took
 * ten connections and made `POST /api/auth/login` return 500 — not 401 — for
 * valid accounts, intermittently, for as long as the run lasted.
 *
 * So it runs in batch mode (see lib/batch-job.js) and takes two connections,
 * and `--stop-at` exists so an overnight run ends before the working day
 * rather than whenever the backlog happens to run out.
 *
 * ── READ-ONLY TOWARD ZOHO ───────────────────────────────────────────────────
 * Two GETs per order — detail and comments. Nothing here can change anything
 * in Zoho; the adapter has no method that could (see ZohoAdapter.js). In
 * particular NO SALES ORDER IS EVER DELETED OR MODIFIED. Every write is local.
 *
 *   node scripts/enrich-zoho-history.js                  # what's outstanding (no Zoho calls)
 *   node scripts/enrich-zoho-history.js --yes            # one pass of 500
 *   node scripts/enrich-zoho-history.js --yes --limit 250
 *   node scripts/enrich-zoho-history.js --yes --orders 2000
 *                                                        # keep passing until 2000
 *                                                        # orders are done, then stop
 *   node scripts/enrich-zoho-history.js --yes --all --stop-at 06:00
 *                                                        # drain overnight, stop at 6am
 *
 * `--orders` is a session ceiling in ORDERS; the call cost is twice that. Pick
 * it from whatever is left of the org's daily budget rather than from how long
 * you are willing to wait.
 */
require('dotenv').config();
// Share the database politely: this is a bulk job, and the deployed app is on
// the same Supabase pooler. See lib/batch-job.js.
const batch = require('./lib/batch-job');

const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');
const {
  enrichPendingDetail,
  countAwaitingDetail,
  IMPORT_MAX
} = require('../src/services/zohoOrderImportService');

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const all = args.includes('--all');

const numArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const strArg = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] || null;
};

const PASS_SIZE = numArg('--limit', IMPORT_MAX);
/** Session ceiling in ORDERS. Twice this many Zoho requests will be made. */
const ORDER_BUDGET = numArg('--orders', all ? Infinity : PASS_SIZE);

/**
 * Wall-clock deadline, as HH:MM in local time, resolved to its NEXT
 * occurrence. So `--stop-at 06:00` started at 22:00 means tomorrow morning,
 * and started at 07:00 also means tomorrow morning — never a deadline that is
 * already in the past, which would make the run a no-op.
 */
function parseStopAt(value) {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`--stop-at expects HH:MM (24-hour), got "${value}"`);
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) throw new Error(`--stop-at is not a real time: "${value}"`);

  const at = new Date();
  at.setHours(h, min, 0, 0);
  if (at <= new Date()) at.setDate(at.getDate() + 1);
  return at;
}

const STOP_AT = parseStopAt(strArg('--stop-at'));

const fmt = (n) => (n === Infinity ? 'no limit' : n.toLocaleString());
const clock = (d) => d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Ctrl-C should stop between passes, not mid-pass. A pass that is interrupted
 * partway has still committed every order it finished — importOne stamps
 * zoho_detail_synced_at last, per order — so the work is never lost, but
 * letting the current pass drain keeps the output honest about what was done.
 */
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\n\n  Stopping after this pass finishes. Ctrl-C again to quit now.\n');
});

(async () => {
  const outstanding = await countAwaitingDetail();
  const total = (await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE zoho_so_id IS NOT NULL').get())?.c || 0;
  const done = total - outstanding;

  console.log(`\n[${new Date().toISOString()}] Zoho mode: ${zoho.mode}`);
  if (zoho.mode === 'mock') {
    console.log('⚠️  ZOHO_MODE=mock — this will read the in-memory fixture, not your real org.');
  }
  console.log(batch.banner());

  console.log(`\n  adopted from Zoho    ${fmt(total)}`);
  console.log(`  already enriched     ${fmt(done)}`);
  console.log(`  still summary-only   ${fmt(outstanding)}`);
  console.log(`  Zoho calls to finish ${fmt(outstanding * 2)}  (2 per order)`);

  if (!outstanding) {
    console.log('\n✅ Nothing outstanding — every adopted order has its Zoho detail and history.\n');
    await db.close();
    return;
  }

  if (!confirmed) {
    console.log(
      `\nDry run. Add --yes to enrich. Default pass size is ${fmt(PASS_SIZE)} order(s) ` +
        `(${fmt(PASS_SIZE * 2)} Zoho calls).\n` +
        `Use --orders N for a session ceiling, --all to drain it, and --stop-at HH:MM\n` +
        `to end before the working day.\n`
    );
    await db.close();
    return;
  }

  const ceiling = Math.min(ORDER_BUDGET, outstanding);
  console.log(`\nEnriching up to ${fmt(ceiling)} order(s), ${fmt(PASS_SIZE)} per pass…`);
  if (STOP_AT) console.log(`Stopping at ${clock(STOP_AT)} whatever is left.`);
  console.log('');

  let enriched = 0;
  let failed = 0;
  let pass = 0;
  let ranOutOfTime = false;
  const startedAt = Date.now();

  while (enriched < ceiling && !stopping) {
    // Checked between passes only. A pass is ~4 minutes at 500 orders, so the
    // deadline is honoured to within one pass — use a smaller --limit if the
    // exact minute matters.
    if (STOP_AT && new Date() >= STOP_AT) {
      ranOutOfTime = true;
      break;
    }

    pass++;
    const take = Math.min(PASS_SIZE, ceiling - enriched);

    const summary = await enrichPendingDetail({
      limit: take,
      onProgress: (n, of) =>
        process.stdout.write(`\r  pass ${pass}: ${n}/${of}   (${fmt(enriched + n)} of ${fmt(ceiling)} this session)      `)
    });

    enriched += summary.detailed;
    failed += summary.failed;

    const mins = (Date.now() - startedAt) / 60000;
    const rate = mins > 0 ? Math.round(enriched / mins) : 0;
    process.stdout.write('\r' + ' '.repeat(78) + '\r');
    console.log(
      `  pass ${String(pass).padStart(3)}  +${String(summary.detailed).padStart(5)} enriched` +
        `  ${String(summary.log_entries).padStart(6)} log entries` +
        `  ${String(summary.checkpoints).padStart(5)} checkpoints` +
        (summary.failed ? `  ${summary.failed} failed` : '') +
        `  |  ${fmt(summary.awaiting_detail)} left  (~${rate}/min)`
    );

    for (const f of summary.failures.slice(0, 3)) {
      console.log(`        - ${f.salesorder_id}: ${f.message}`);
    }

    // A pass that took nothing means the backlog is empty or unreachable.
    // Without this the loop spins making no calls and no progress.
    if (!summary.detailed) {
      console.log('\n  A pass came back empty — nothing left to take. Stopping.');
      break;
    }
  }

  const left = await countAwaitingDetail();
  const mins = Math.round((Date.now() - startedAt) / 60000);

  if (ranOutOfTime) console.log(`\n  Reached ${clock(STOP_AT)} — stopping as instructed.`);

  console.log(`\n  enriched this session  ${fmt(enriched)}`);
  if (failed) console.log(`  failed                 ${fmt(failed)}`);
  console.log(`  still summary-only     ${fmt(left)}`);
  console.log(`  elapsed                ${mins} min`);

  if (left) {
    console.log(
      `\n  Run this again to take the next batch. ${fmt(left * 2)} Zoho call(s) remain to finish.\n` +
        `  Until then those orders show their stages from Zoho's status — true, but with\n` +
        `  no timestamp and no name against them.\n`
    );
  } else {
    console.log('\n✅ Every adopted order now carries its Zoho detail and history.\n');
  }

  await db.close();
})().catch(async (err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
