require('dotenv').config();
const app = require('./src/app');
const zohoRetryService = require('./src/services/zohoRetryService');

const { isTestModeEnabled } = require('./src/middleware/testMode');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  const isTestMode = isTestModeEnabled();
  const isDebug = process.env.DEBUG === 'true' || isTestMode;

  console.log(`\n🚀 Getmeds API Server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
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
  if (process.env.ZOHO_AUTO_RETRY_ENABLED === 'true') {
    const intervalMs = parseInt(process.env.ZOHO_RETRY_INTERVAL_MS, 10) || 30000;
    zohoRetryService.start(intervalMs);
    console.log(`   Zoho Retry: polling every ${intervalMs / 1000}s for failed syncs to retry\n`);
  } else {
    console.log('   Zoho Retry: automatic background retry is OFF — use the "Retry Zoho Sync" button on an order instead.\n');
  }
});
