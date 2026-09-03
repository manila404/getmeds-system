process.env.IS_JEST = 'true';
process.env.ZOHO_MODE = 'mock';
process.env.NODE_ENV = 'test';

// Sep 3, 2026: every worker connects to the throwaway PostgreSQL database that
// tests/globalSetup.js builds, and never the real one.
//
// The original note here is worth keeping, because the hazard got WORSE rather
// than better when the database stopped being a local file:
//
//   Until Sep 2 the suite ran against the REAL database - the one holding ~95k
//   customers mirrored from the live Zoho org and the actual orders.
//   customersSync.test.js opens with
//       DELETE FROM customers WHERE source = 'zoho'
//   which, against that database, is an attempt to delete the entire mirror. It
//   failed only because a foreign key from an existing order refused it, which
//   is luck rather than a safeguard - with no order referencing a synced
//   customer it would have succeeded silently, and the only way back would have
//   been a Full Resync (~475 paginated Zoho reads).
//
// A hosted database cannot be restored by deleting a local file, so
// tests/globalSetup.js now REFUSES outright to run against a URL that looks
// hosted, or whose database name does not say "test". This line is only the
// default; that check is the actual safeguard.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/getmeds_test';

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
