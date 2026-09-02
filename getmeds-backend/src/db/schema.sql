PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Sep 2, 2026: the name/division fields below arrived with the sign-up form
-- (POST /api/auth/register). `name` predates them and is what the whole
-- frontend already renders (Topbar, order lists, audit entries), so it is
-- kept in sync with `display_name` rather than replaced — one less thing to
-- chase through the UI.
--
-- `salesperson` is a GENERATED column on purpose. Zoho has "Salesperson"
-- configured as a MANDATORY field on every Sales Order in this org (see
-- LiveZohoAdapter.createSalesOrder), formatted "<division> | <display name>"
-- — e.g. "TEST | Aaron Manila". Deriving it in the schema means it can never
-- drift from the two columns it is built out of: there is no code path that
-- can update a division and forget the salesperson string, because there is
-- no stored string to forget. VIRTUAL rather than STORED since it costs
-- nothing to compute and STORED cannot be added by ALTER TABLE.
-- NULL when either part is missing — which is exactly right for the seeded
-- accounts and any user created before this existed: they have no Zoho
-- salesperson mapping, and NULL says so.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('medrep','finance','dispatch','management','admin')),
  is_active INTEGER DEFAULT 1,
  is_test_account INTEGER DEFAULT 0,
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  display_name TEXT,
  division TEXT,
  sub_division TEXT,
  salesperson TEXT GENERATED ALWAYS AS (
    CASE
      WHEN division IS NULL OR TRIM(division) = '' THEN NULL
      WHEN display_name IS NULL OR TRIM(display_name) = '' THEN NULL
      ELSE TRIM(division) || ' | ' || TRIM(display_name)
    END
  ) VIRTUAL,
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
  -- Sep 1, 2026: 'ready_for_dispatch' added — Finance marked the Invoice as Sent in
  -- Zoho, i.e. it has actually been issued to the customer rather than just
  -- existing as a draft. Changing this CHECK list does NOT reach a database
  -- that was already migrated (CREATE TABLE IF NOT EXISTS is a no-op once the
  -- table exists, and SQLite cannot ALTER a CHECK constraint) — migrate.js
  -- rebuilds the table when it finds an older constraint. See
  -- ensureOrderStatusValues() there.
  -- Sep 1, 2026 (2): 'deleted' added, separate from 'cancelled'. Zoho now
  -- fires a workflow when a Sales Order is removed, and the two are not the
  -- same event: cancelling/voiding leaves the Zoho record in place with a
  -- changed status, deleting removes it entirely and there is no way back
  -- short of recreating it. Both used to collapse to 'cancelled' here, so
  -- the badge and every status filter showed them identically and only the
  -- audit trail knew the difference.
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
'draft', 'submitted', 'validating', 'so_pending', 'so_created',
    'ready_for_finance_verified', 'ready_for_draft_invoice',
    'ready_for_invoice_sent', 'ready_for_dispatch',
    'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled', 'deleted'
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
  -- Aug 30, 2026: "Create New Order" form redesign — new fields chosen to
  -- line up 1:1 (where Zoho has an equivalent) with a Zoho Inventory Sales
  -- Order, so the data is already sitting here, correctly shaped, the day
  -- the real Zoho push is wired up. See
  -- getmeds-backend/ZOHO_SALES_ORDER_FIELD_MAPPING.md for the full
  -- field-by-field mapping and what's still needed to actually send them.
  -- sales_order_date is ALWAYS set server-side to today (see orders.controller.js
  -- create()) — there is no user override, matching "Sales Order Date
  -- (Automatic Today)" on the form.
  sales_order_date TEXT,
  intake_delivery_method TEXT,
  intake_terms TEXT,
  -- Aug 30, 2026: Payment Terms — a typeahead field mirroring the same
  -- named field on Zoho's own Sales Order screen (Net 15, 30 days, 45 Day,
  -- BPO WALLET, 60 Day, DSWD/PCSO, or a custom value typed in, exactly like
  -- Zoho's own field allows). Free text here too — not a strict enum,
  -- since Zoho's own version accepts an arbitrary typed value alongside
  -- its suggested list. Not yet wired into the Zoho Sales Order payload
  -- itself (see ZOHO_SALES_ORDER_FIELD_MAPPING.md) — captured here first.
  intake_payment_terms TEXT,
  -- Which legal entity this order is invoiced under. Exactly two allowed
  -- values, enforced in orders.controller.js create() — NOT a Zoho payload
  -- field itself; it's expected to eventually pick which of two separate
  -- Zoho organizations (2mg Incorporated vs Getmeds Philippines Inc.) the
  -- Sales Order gets created in, since this app currently only ever talks
  -- to the single org configured via ZOHO_ORG_ID.
  invoicing_from TEXT CHECK(invoicing_from IS NULL OR invoicing_from IN ('2mg Incorporated', 'Getmeds Philippines Inc.')),
  zoho_so_id TEXT,
  zoho_so_number TEXT,
  -- Aug 31, 2026: last-known Zoho-side Sales Order status ("draft",
  -- "confirmed", "void", "closed", etc. — Zoho's own `status` field, seen
  -- live via ZohoInventory_get_sales_order). Deliberately separate from this
  -- table's own `status` column above, which is this app's OWN dispatch
  -- pipeline stage and has nothing to do with Zoho's SO lifecycle. Kept so
  -- the "edited in Zoho" webhook handler (webhook.controller.js) can tell a
  -- real status transition (e.g. someone clicked "Confirm" in Zoho) apart
  -- from every other kind of edit, and put a clear "Sales Order confirmed in
  -- Zoho" line in the audit trail instead of a generic one.
  zoho_so_status TEXT,
  -- Populated when Finance converts the Sales Order to an Invoice in Zoho
  -- (webhook: invoice.created) — see 'ready_for_invoice_sent' status above.
  zoho_invoice_id TEXT,
  zoho_invoice_number TEXT,
  zoho_sync_status TEXT DEFAULT 'pending' CHECK(zoho_sync_status IN ('pending','synced','failed','skipped')),
  -- Sep 1, 2026 (3): when this order was last PULLED from Zoho by the
  -- reconcile (services/zohoReconcileService.js) — not the same thing as
  -- zoho_sync_status above, which is about the outbound Sales Order push.
  -- The background poller works oldest-first through this column and the
  -- refresh-on-open path checks it as a cooldown, so the two never re-read an
  -- order the other has just read. NULL = never reconciled, sorts first.
  last_reconciled_at TEXT,
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
  -- unit_price is the RATE actually used for this line — the order form now
  -- lets a MedRep override the product's catalog price per line (matching
  -- Zoho Sales Order line items, which always allow this), so this is no
  -- longer guaranteed to equal products.unit_price at the time of order.
  unit_price REAL NOT NULL CHECK(unit_price >= 0),
  -- subtotal = quantity * unit_price, BEFORE discount/tax (unchanged meaning).
  subtotal REAL NOT NULL CHECK(subtotal >= 0),
  -- Aug 30, 2026: per-line Discount/Tax columns from the order form redesign
  -- — see ZOHO_SALES_ORDER_FIELD_MAPPING.md. discount_amount is a flat
  -- currency amount (not a percentage); tax_percent/tax_label describe a
  -- simple flat-rate tax preset picked per line (e.g. "VAT 12%"). All
  -- default to zero/blank so existing rows and any caller that omits them
  -- behave exactly as before (line_total == subtotal).
  discount_amount REAL NOT NULL DEFAULT 0 CHECK(discount_amount >= 0),
  tax_percent REAL NOT NULL DEFAULT 0 CHECK(tax_percent >= 0),
  tax_label TEXT,
  -- line_total = (subtotal - discount_amount) + tax_amount — this is the
  -- "Amount" column shown on the order form and what order.total_amount is
  -- summed from.
  line_total REAL NOT NULL DEFAULT 0 CHECK(line_total >= 0)
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

-- Aug 28, 2026: per-entity sync bookkeeping for the new Quick Sync (only
-- contacts/items changed since the last run) vs Full Resync (everyone,
-- guaranteed complete) feature — see services/syncJobs.js and
-- LiveZohoAdapter._paginatedList's `sinceWatermark` mode. Plain key/value so
-- another tracked entity can be added later without a schema change. Keys in
-- use: customers_last_modified_watermark, customers_last_full_sync_at,
-- customers_last_full_total, and the same three with an inventory_ prefix.
-- A brand-new table, so `CREATE TABLE IF NOT EXISTS` here (picked up by
-- migrate() automatically) is enough — no ensureColumn() needed.
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
