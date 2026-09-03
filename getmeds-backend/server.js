require('dotenv').config();
const app = require('./src/app');
const db = require('./src/db/database');
const zohoRetryService = require('./src/services/zohoRetryService');
const zohoAutoSyncService = require('./src/services/zohoAutoSyncService');

const { isTestModeEnabled } = require('./src/middleware/testMode');

const PORT = process.env.PORT || 4000;

/**
 * Sep 3, 2026: `await db.init()` before app.listen().
 *
 * The old data layer exported an already-connected better-sqlite3 handle,
 * because opening a file is synchronous — so there was nothing to wait for and
 * no way for the database to be "not ready". A network database has both.
 *
 * Connecting BEFORE listening is the point. Listening first would mean the
 * server accepts requests it cannot serve, and a bad DATABASE_URL or an
 * unapplied schema would surface as a 500 on someone's login attempt instead of
 * a clear failure at startup. Here, a broken database means the process exits
 * with an explanation and the port never opens.
 */
async function main() {
  try {
    await db.init();
  } catch (err) {
    console.error(
      `\n❌ Could not reach the database.\n` +
        `   ${err.message}\n\n` +
        `   Check DATABASE_URL, and that the schema has been applied:\n` +
        `     npm run migrate:pg\n`
    );
    process.exit(1);
  }

  app.listen(PORT, () => {
    const isTestMode = isTestModeEnabled();
    const isDebug = process.env.DEBUG === 'true' || isTestMode;

    console.log(`\n🚀 Getmeds API Server running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Database:   PostgreSQL (${redactUrl(process.env.DATABASE_URL)})`);
    console.log(`   Debug Mode: ${isDebug ? 'ENABLED' : 'disabled'}`);
    console.log(`   Mode:       ${isTestMode ? '🧪 TEST MODE (Omni-Admin Active)' : '🛡️ NORMAL MODE (Standard RBAC)'}\n`);

    // Background Zoho sync retry loop — only in the real running server, never
    // under `jest` (tests drive zohoRetryService.processQueue() directly).
    //
    // Aug 30, 2026: switched to OFF by default while we're actively testing
    // live Zoho writes against the real company org. A failed sync used to
    // auto-retry every 30s forever (see zohoRetryService.js), which spammed
    // the audit timeline with repeat failures while a real issue (e.g. the
    // missing-Salesperson field) was being diagnosed. Retrying is now manual
    // only — see the "Retry Zoho Sync" button on the Order Detail page,
    // which calls POST /api/orders/:id/retry-zoho-sync on demand. Set
    // ZOHO_AUTO_RETRY_ENABLED=true in .env to restore the automatic
    // background loop later once the integration is trusted.
    //
    // Sep 3, 2026: these two loops exist ONLY in this process. On Vercel there
    // is no process and app.listen() is never called, so neither runs — see
    // src/controllers/cron.controller.js for the endpoints that replace them.
    if (process.env.ZOHO_AUTO_RETRY_ENABLED === 'true') {
      const intervalMs = parseInt(process.env.ZOHO_RETRY_INTERVAL_MS, 10) || 30000;
      zohoRetryService.start(intervalMs);
      console.log(`   Zoho Retry: polling every ${intervalMs / 1000}s for failed syncs to retry`);
    } else {
      console.log('   Zoho Retry: automatic background retry is OFF — use the "Retry Zoho Sync" button on an order instead.');
    }

    // Sep 1, 2026 (3): the PULL half — reconcile open orders against Zoho on a
    // schedule so the audit trail fills itself in when a webhook is missed
    // (a Workflow Rule that isn't built yet, or the tunnel to this machine
    // being down). Distinct from the retry loop above, which PUSHES failed
    // Sales Order creations. On by default; ZOHO_AUTO_SYNC_ENABLED=false stops
    // it. Opening an order still refreshes it either way.
    if (zohoAutoSyncService.isEnabled()) {
      zohoAutoSyncService.start();
      console.log(
        `   Zoho Auto-Sync: reconciling up to ${zohoAutoSyncService.BATCH_SIZE} open orders every ` +
          `${zohoAutoSyncService.INTERVAL_MS / 1000}s, plus on order open.\n`
      );
    } else {
      console.log('   Zoho Auto-Sync: background reconcile is OFF (ZOHO_AUTO_SYNC_ENABLED=false) — orders still refresh when opened.\n');
    }
  });
}

/** Never print the database password to a log. */
function redactUrl(url) {
  if (!url) return 'DATABASE_URL not set';
  return url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:****@');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
