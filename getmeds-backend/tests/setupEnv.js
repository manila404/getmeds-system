const path = require('path');

process.env.IS_JEST = 'true';
process.env.ZOHO_MODE = 'mock';
process.env.NODE_ENV = 'test';

// Sep 2, 2026: every worker opens the throwaway database that
// tests/globalSetup.js builds, and never data/getmeds.db.
//
// Until now the suite ran against the REAL database - the one holding ~95k
// customers mirrored from the live Zoho org and the actual orders. That was
// not merely untidy: customersSync.test.js opens with
//     DELETE FROM customers WHERE source = 'zoho'
// which, against that database, is an attempt to delete the entire mirror. It
// failed only because a foreign key from an existing order refused it, which
// is luck rather than a safeguard - with no order referencing a synced
// customer it would have succeeded silently, and the only way back would have
// been a Full Resync (~475 paginated Zoho reads).
//
// src/db/database.js has honoured GETMEDS_DB_DIR since Sep 1, added so
// statusMigration.test.js could migrate a scratch database; this points the
// whole suite at it. Keep the path in step with tests/globalSetup.js, which
// is what builds the database this line then opens.
process.env.GETMEDS_DB_DIR = path.join(__dirname, '..', 'data', 'test-db');

// Sep 2, 2026 (2): the suite must not inherit the developer's real webhook
// secret from .env. Once `npm run secrets:init` set one, every unauthenticated
// webhook post in webhook.test.js and api.http.test.js started coming back
// 401, and orders stopped advancing past so_created — 22 failures that looked
// like a pipeline bug and were really a config leak.
//
// Set to empty rather than deleted: dotenv does not overwrite a key that
// already exists, but it will happily fill in one that has been removed, so a
// `delete` here would be undone the moment app.js loads.
//
// webhook.test.js sets a real value itself for the test that covers the
// authenticated path, which is where that behaviour belongs.
process.env.ZOHO_WEBHOOK_SECRET = '';
