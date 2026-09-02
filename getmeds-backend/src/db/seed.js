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
function hasRealZohoData(db) {
  try {
    const customers = db
      .prepare("SELECT COUNT(*) as c FROM customers WHERE source = 'zoho' OR zoho_contact_id IS NOT NULL")
      .get().c;
    const products = db
      .prepare('SELECT COUNT(*) as c FROM products WHERE zoho_item_id IS NOT NULL OR zoho_stock IS NOT NULL')
      .get().c;
    return { customers, products };
  } catch (e) {
    // Tables don't exist yet (fresh install, before migrate has ever run) — nothing to protect.
    return { customers: 0, products: 0 };
  }
}

function run() {
  const forced = process.argv.includes('--force') || process.env.SEED_FORCE === 'true';
  const { customers: realCustomers, products: realProducts } = hasRealZohoData(db);

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
  const seedTransaction = db.transaction(() => {
    // 1. Child tables first (Reverse-relational order)
    db.prepare('DELETE FROM notifications').run();
    db.prepare('DELETE FROM order_events').run();
    db.prepare('DELETE FROM dispatch_records').run();
    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();

    // 2. Accounts. `customers` and `products` are deliberately NOT in this
    //    list — see the note at the top of this file. They belong to the Zoho
    //    mirror and are only ever filled by the read-only sync.
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM roles').run();

    // Reset autoincrement sequences for the tables actually cleared above.
    // 'customers' and 'products' are excluded on purpose: their rows survive,
    // so reusing their ids would collide.
    try {
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('roles','users','orders','order_items','payments','dispatch_records','order_events','notifications')").run();
    } catch (e) {
      // sqlite_sequence may not exist if no rows were ever inserted
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
      insRole.run(r.name, r.description);
    }
    console.log('✅ Seeded roles (Admin, MedRep, Finance, Dispatch).');

    // Seed Users
    // Sep 2, 2026 (2): division + display_name, so `users.salesperson` (a
    // generated column reading "<division> | <display name>") resolves for
    // these accounts. Not decoration: createSalesOrder now refuses an order
    // whose rep has no Salesperson mapping, because Salesperson is
    // mandatory in this Zoho org AND Zoho creates any name it does not
    // recognise. Without these the six demo logins could not place an
    // order at all. The names match MockZohoAdapter's seeded list.
    const insUser = db.prepare(
      'INSERT INTO users (name, email, password_hash, role, display_name, division) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insUser.run('Admin User', 'admin@getmeds.ph', hash('demo123'), 'admin', 'Admin User', 'TEST');
    insUser.run('Juan dela Cruz', 'medrep@getmeds.ph', hash('demo123'), 'medrep', 'Juan dela Cruz', 'NORTH');
    insUser.run('Maria Santos', 'medrep2@getmeds.ph', hash('demo123'), 'medrep', 'Maria Santos', 'NORTH');
    insUser.run('Rosa Reyes', 'finance@getmeds.ph', hash('demo123'), 'finance', 'Rosa Reyes', 'TEST');
    insUser.run('Ben Ramos', 'dispatch@getmeds.ph', hash('demo123'), 'dispatch', 'Ben Ramos', 'TEST');
    insUser.run('Carlo Tan', 'manager@getmeds.ph', hash('demo123'), 'management', 'Carlo Tan', 'TEST');
    console.log('✅ Seeded users.');
  });

  seedTransaction();

  const count = (t) => {
    try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (e) { return 'n/a'; }
  };
  console.log(`\n   Customers: ${count('customers')}   Products: ${count('products')}  (untouched — pulled from Zoho, never seeded)`);
  if (count('customers') === 0 || count('products') === 0) {
    console.log('   ⚠️  Nothing to order yet. Log in as admin and run Full Resync for customers and inventory.');
  }
  return true;
}

if (run()) {
  console.log('🎉 Seeding complete.');
}
