PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('medrep','finance','dispatch','management','admin')),
  is_active INTEGER DEFAULT 1,
  is_test_account INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('credit','direct')),
  credit_limit REAL DEFAULT 0 CHECK(credit_limit >= 0),
  contact_person TEXT,
  contact_number TEXT,
  address TEXT,
  is_active INTEGER DEFAULT 1,
  -- Populated only by a READ from Zoho (customers.controller.js's
  -- syncFromZoho, which calls zoho.listContacts()) — never written back to
  -- Zoho. A Sales Order can only be created for a customer that has this
  -- set, since LiveZohoAdapter.createSalesOrder requires an existing Zoho
  -- contact id and never looks one up or creates one itself.
  zoho_contact_id TEXT,
  source TEXT DEFAULT 'local' CHECK(source IN ('local','zoho')),
  last_synced_at TEXT,
  -- Purely local classification tag (Aug 27, 2026) — separate from `type`
  -- (credit/direct), which keeps driving payment-workflow routing exactly
  -- as before. This is never read from or written to Zoho; it's just how
  -- Management tags a client for the Clients Directory view.
  category TEXT CHECK(category IS NULL OR category IN ('doctor','hospital','distributor','pwd')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT UNIQUE NOT NULL,
  unit_price REAL NOT NULL CHECK(unit_price >= 0),
  unit TEXT DEFAULT 'pc',
  stock INTEGER DEFAULT 0 CHECK(stock >= 0),
  zoho_item_id TEXT,
  -- Aug 27, 2026: a snapshot of what Zoho reported the last time
  -- syncPullStock actually ran (a real GET) — NOT re-fetched from Zoho on
  -- every page view. getInventoryStatus compares current `stock` against
  -- this stored snapshot entirely locally, so opening/refreshing the
  -- Inventory page never blocks on a live multi-page Zoho call. NULL means
  -- this product has never been matched to a Zoho item.
  zoho_stock REAL,
  zoho_price REAL,
  last_synced_at TEXT,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  getmeds_order_id TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  medrep_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
    'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'waiting_for_payment', 'invoice_drafted', 'payment_verified', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared', 'completed',
    'on_hold', 'exception', 'cancelled'
  )),
  customer_type TEXT NOT NULL CHECK(customer_type IN ('credit','direct')),
  total_amount REAL DEFAULT 0 CHECK(total_amount >= 0),
  delivery_address TEXT NOT NULL,
  delivery_notes TEXT,
  -- Aug 27, 2026: optional order-intake fields, added so the MedRep order
  -- form can capture the same information the team's old paper/spreadsheet
  -- intake sheet did (Courier, Doctor, Hospital, Patient, MOP, Receiver,
  -- Contact No., Source, "Pls Give" notes). Purely informational — never
  -- required, never read by the Zoho Sales Order payload builder
  -- (orders.controller.js only ever sends customer/items/address/total to
  -- Zoho), so leaving all of these blank changes nothing about how an
  -- order is created or synced.
  intake_courier TEXT,
  intake_doctor TEXT,
  intake_hospital TEXT,
  intake_patient TEXT,
  intake_mop TEXT,
  intake_receiver TEXT,
  intake_contact_no TEXT,
  intake_source TEXT,
  intake_pls_give TEXT,
  zoho_so_id TEXT,
  zoho_so_number TEXT,
  -- Populated when Finance converts the Sales Order to an Invoice in Zoho
  -- (webhook: invoice.created) — see 'invoice_drafted' status above.
  zoho_invoice_id TEXT,
  zoho_invoice_number TEXT,
  zoho_sync_status TEXT DEFAULT 'pending' CHECK(zoho_sync_status IN ('pending','synced','failed','skipped')),
  exception_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price REAL NOT NULL CHECK(unit_price >= 0),
  subtotal REAL NOT NULL CHECK(subtotal >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected')),
  payment_reference TEXT,
  payment_date TEXT,
  amount REAL CHECK(amount IS NULL OR amount >= 0),
  payment_method TEXT,
  notes TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatch_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','picking','packing','dispatched')),
  courier TEXT,
  tracking_number TEXT,
  dispatch_notes TEXT,
  dispatched_by INTEGER REFERENCES users(id),
  dispatched_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT,
  notes TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES users(id),
  channel TEXT NOT NULL CHECK(channel IN ('in_app','email_log','google_chat_log')),
  message TEXT NOT NULL,
  payload TEXT,
  is_read INTEGER DEFAULT 0,
  sent_at TEXT DEFAULT (datetime('now'))
);

-- Zoho outbox: when a Zoho Sales Order call fails (API downtime, timeout,
-- etc.), the order itself is never blocked or left half-written — it still
-- proceeds through the internal state machine with zoho_sync_status='failed'
-- — and a row is queued here so a background job can retry automatically
-- without the MedRep losing any order data or re-entering anything.
CREATE TABLE IF NOT EXISTS zoho_sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed_permanent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_orders_medrep_created ON orders(medrep_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_submitted ON orders(status, submitted_at ASC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

CREATE INDEX IF NOT EXISTS idx_order_events_order_created ON order_events(order_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications(recipient_id, channel, is_read, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_active_name ON products(is_active, name);
CREATE INDEX IF NOT EXISTS idx_customers_active_name ON customers(is_active, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_zoho_contact_id ON customers(zoho_contact_id) WHERE zoho_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zoho_sync_queue_pending ON zoho_sync_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_zoho_sync_queue_order ON zoho_sync_queue(order_id);
