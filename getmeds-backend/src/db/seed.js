require('dotenv').config();
const db = require('./database');
const bcrypt = require('bcryptjs');

// Aug 28, 2026: this script wipes and reseeds the database with fixed demo
// data on every run — safe on a brand-new dev DB, but this app's database now
// also holds REAL customers/inventory pulled in from the live Zoho org (see
// customers.controller.js's sync-from-zoho / inventory.controller.js's
// sync-pull). Running `npm run seed` (or `npm run setup`, which chains
// migrate + seed) against that same database would silently delete all of
// that real synced data. Nothing here ever calls the Zoho API — this is a
// local-only wipe, not a push to Zoho — but it's exactly the kind of
// "missing customer" bug this project already spent a session chasing, so
// this refuses to run against a database carrying real Zoho-synced rows
// unless explicitly forced.
//
// Sep 2, 2026: the 5 demo customers and 10 demo products this used to insert
// are GONE, and so are the DELETEs that used to clear those two tables.
// Customers and products come from ONE place now — a read-only pull from the
// real Zoho org — and a hand-written row alongside them was actively harmful:
// it carried no zoho_contact_id / zoho_item_id, so an order raised against
// "St. Luke's Medical Center" or "Amoxicillin 500mg Cap" could never reach
// Zoho (createSalesOrder requires both ids and fails loudly without them).
// A tester hitting that failure learns nothing about the real flow.
//
// Consequence worth knowing: seeding no longer gives you anything to order.
// After `npm run seed`, log in as admin and run Full Resync for customers and
// inventory to populate them from Zoho.
//
// The guard below stays, and now protects the orders/users/roles wipe rather
// than the customer/product one — running this against a working database is
// still destructive, just no longer destructive to the Zoho mirror.
async function hasRealZohoData(db) {
  try {
    const customers = (await db
      .prepare("SELECT COUNT(*) as c FROM customers WHERE source = 'zoho' OR zoho_contact_id IS NOT NULL")
      .get()).c;
    const products = (await db
      .prepare('SELECT COUNT(*) as c FROM products WHERE zoho_item_id IS NOT NULL OR zoho_stock IS NOT NULL')
      .get()).c;
    return { customers, products };
  } catch (e) {
    // Tables don't exist yet (fresh install, before migrate has ever run) — nothing to protect.
    return { customers: 0, products: 0 };
  }
}

async function run() {
  const forced = process.argv.includes('--force') || process.env.SEED_FORCE === 'true';
  const { customers: realCustomers, products: realProducts } = await hasRealZohoData(db);

  if (!forced && (realCustomers > 0 || realProducts > 0)) {
    console.error('\n🛑 Refusing to run: this database holds REAL data synced from Zoho, not just demo data.');
    console.error(`   Found ${realCustomers} customer(s) and ${realProducts} product(s) carrying Zoho sync fields (zoho_contact_id / zoho_item_id / zoho_stock).`);
    console.error('   npm run seed deletes every order, event, payment, dispatch record, notification, user and');
    console.error('   role and recreates the six demo logins — a working database would lose all of that.');
    console.error('   (Customers and products are no longer touched either way, and Zoho itself is never');
    console.error('   contacted by this script — the real Zoho org is completely unaffected.)');
    console.error('\n   If you really do want to reset the accounts on this database, run: npm run seed -- --force\n');
    process.exitCode = 1;
    return false;
  }

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  // Clean wipe in reverse-relational order to prevent foreign key errors and guarantee idempotency
  const seedTransaction = db.transaction(async () => {
    // 1. Child tables first (Reverse-relational order)
    await db.prepare('DELETE FROM notifications').run();
    await db.prepare('DELETE FROM order_events').run();
    await db.prepare('DELETE FROM dispatch_records').run();
    await db.prepare('DELETE FROM payments').run();
    await db.prepare('DELETE FROM order_items').run();
    await db.prepare('DELETE FROM orders').run();

    // 2. Accounts. `customers` and `products` are deliberately NOT in this
    //    list — see the note at the top of this file. They belong to the Zoho
    //    mirror and are only ever filled by the read-only sync.
    await db.prepare('DELETE FROM users').run();
    await db.prepare('DELETE FROM roles').run();

    // Reset autoincrement sequences for the tables actually cleared above.
    // 'customers' and 'products' are excluded on purpose: their rows survive,
    // so reusing their ids would collide.
    // Sep 3, 2026: SQLite kept these counters in a sqlite_sequence table that
    // could be DELETEd from. Postgres attaches a real sequence to each identity
    // column, so the equivalent is ALTER TABLE ... RESTART. Attempted one table
    // at a time: in a single statement the first table without an identity
    // column would abort the rest.
    for (const t of ['roles','users','orders','order_items','payments','dispatch_records','order_events','notifications']) {
      try {
        await db.prepare(`ALTER TABLE "${t}" ALTER COLUMN id RESTART WITH 1`).run();
      } catch (e) {
        // No identity column on this table, or nothing was ever inserted.
      }
    }

    // Seed Roles
    const insRole = db.prepare('INSERT INTO roles (name, description) VALUES (?, ?)');
    const defaultRoles = [
      { name: 'Admin', description: 'System Administrator with full access' },
      { name: 'MedRep', description: 'Medical Representative' },
      { name: 'Finance', description: 'Finance Officer' },
      { name: 'Dispatch', description: 'Dispatch and Logistics Officer' }
    ];
    for (const r of defaultRoles) {
      await insRole.run(r.name, r.description);
    }
    console.log('✅ Seeded roles (Admin, MedRep, Finance, Dispatch).');

    // Seed Users
    // Sep 2, 2026 (2): division + display_name, so a seeded account matches a
    // Salesperson the mock Zoho org actually has.
    //
    // Sep 11, 2026: `salesperson` is now written EXPLICITLY. It used to be a
    // generated column reading "<division> | <display name>", so seeding those
    // two produced it for free. It is a plain column now — assigned by an
    // admin from Zoho's list, because no formula reproduces that list (see
    // schema.pg.sql).
    //
    // Which means the seed has to do what an admin would, and these strings
    // are not decorative: MockZohoAdapter matches on them, and an order whose
    // salesperson_name it does not recognise fails the sync. A NULL here made
    // zohoRetryService.test.js fail with 'retry_scheduled' and no mention of a
    // salesperson anywhere in the error.
    const insUser = db.prepare(
      'INSERT INTO users (name, email, password_hash, role, display_name, division, salesperson) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await insUser.run('Admin User', 'admin@getmeds.ph', hash('demo123'), 'admin', 'Admin User', 'TEST', 'TEST | Admin User');
    await insUser.run('Juan dela Cruz', 'medrep@getmeds.ph', hash('demo123'), 'medrep', 'Juan dela Cruz', 'NORTH', 'NORTH | Juan dela Cruz');
    await insUser.run('Maria Santos', 'medrep2@getmeds.ph', hash('demo123'), 'medrep', 'Maria Santos', 'NORTH', 'NORTH | Maria Santos');
    await insUser.run('Rosa Reyes', 'finance@getmeds.ph', hash('demo123'), 'finance', 'Rosa Reyes', 'TEST', 'TEST | Rosa Reyes');
    await insUser.run('Ben Ramos', 'dispatch@getmeds.ph', hash('demo123'), 'dispatch', 'Ben Ramos', 'TEST', 'TEST | Ben Ramos');
    await insUser.run('Carlo Tan', 'manager@getmeds.ph', hash('demo123'), 'management', 'Carlo Tan', 'TEST', 'TEST | Carlo Tan');
    console.log('✅ Seeded users.');
  });

  await seedTransaction();

  const count = async t => {
    try { return (await db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get()).c; } catch (e) { return 'n/a'; }
  };
  console.log(`\n   Customers: ${await count('customers')}   Products: ${await count('products')}  (untouched — pulled from Zoho, never seeded)`);
  if ((await count('customers')) === 0 || (await count('products')) === 0) {
    console.log('   ⚠️  Nothing to order yet. Log in as admin and run Full Resync for customers and inventory.');
  }
  return true;
}

if (run()) {
  console.log('🎉 Seeding complete.');
}
