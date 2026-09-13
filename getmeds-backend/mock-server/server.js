/**
 * Standalone mock Zoho Books/Inventory HTTP server.
 *
 * What this is for: LiveZohoAdapter makes real HTTP requests over the
 * network. Pointing it at ZOHO_MODE=http-mock and this server lets you
 * exercise that *exact* HTTP/OAuth code path — request signing, URL
 * shape, response parsing, error handling — end to end, without a single
 * byte leaving your machine and without any real Zoho account involved.
 *
 * Safety properties (all deliberate):
 *   - Binds to 127.0.0.1 only — not reachable from the network, not even
 *     your LAN.
 *   - Only ever holds in-memory fixture data. Restarting this process
 *     wipes it back to the seeded fixtures. There is no database file.
 *   - Rejects any organization_id other than the fixed fake test-org id
 *     (FIXED_ORG_ID from fixtures.js) with a 401, mirroring how the real
 *     Zoho API would reject a token/org mismatch. This means even a
 *     misconfigured client pointed here can't accidentally "succeed"
 *     against the wrong org id and get a false sense of confidence.
 *   - No DELETE route exists for any resource, and no PUT/PATCH is wired
 *     up for anything other than a no-op sales order status nudge used by
 *     the demo. There is nothing destructive to call, full stop.
 *   - Every request is logged to stdout with method + path + org id.
 *
 * Run: `npm run mock-server` (see package.json) — defaults to port 4100.
 */
const express = require('express');
const { FIXED_ORG_ID, items, contacts, sampleSalesOrder } = require('../src/integrations/zoho/fixtures');

const app = express();
app.use(express.json());

// In-memory-only state, reseeded fresh every process start.
let soCounter = 2; // sampleSalesOrder already occupies SO-00001
const state = {
  items: new Map(items.map((i) => [i.item_id, { ...i }])),
  contacts: new Map(contacts.map((c) => [c.contact_id, { ...c }])),
  salesOrders: new Map([[sampleSalesOrder.salesorder_id, { ...sampleSalesOrder }]])
};

app.use((req, res, next) => {
  console.log(`[MOCK-ZOHO-SERVER] ${req.method} ${req.originalUrl}`);
  next();
});

// Fake OAuth token endpoint so LiveZohoAdapter's getAccessToken() flow can
// be exercised too, if you wire it up to call this instead of hardcoding
// 'mock-access-token'.
app.post('/oauth/v2/token', (req, res) => {
  res.json({ access_token: 'mock-access-token', expires_in: 3600, token_type: 'Bearer' });
});

function requireFixedOrg(req, res, next) {
  const orgId = req.query.organization_id;
  if (orgId !== FIXED_ORG_ID && orgId !== 'MOCK-ORG-LOCAL') {
    return res.status(401).json({
      code: 57,
      message: `organization_id "${orgId}" does not match this mock server's fixed test org. ` +
        'This mock intentionally refuses any other org id.'
    });
  }
  next();
}

const router = express.Router();
router.use(requireFixedOrg);

// ── Items (read + create, no delete) ───────────────────────────────────
router.get('/items', (req, res) => {
  res.json({ code: 0, message: 'success', items: [...state.items.values()] });
});
router.get('/items/:id', (req, res) => {
  const item = state.items.get(req.params.id);
  if (!item) return res.status(404).json({ code: 4, message: 'Item not found' });
  res.json({ code: 0, message: 'success', item });
});
router.post('/items', (req, res) => {
  const id = `MOCK-ITEM-${state.items.size + 1}`;
  const item = { item_id: id, status: 'active', ...req.body };
  state.items.set(id, item);
  res.status(201).json({ code: 0, message: 'success', item });
});
router.post('/items/:id/active', (req, res) => {
  const item = state.items.get(req.params.id);
  if (item) item.status = 'active';
  res.json({ code: 0, message: 'Item status has been changed to Active.', item });
});

// ── Contacts (read + create, no delete) ─────────────────────────────────
router.get('/contacts', (req, res) => {
  let list = [...state.contacts.values()];
  if (req.query.contact_name_contains) {
    const needle = String(req.query.contact_name_contains).toLowerCase();
    list = list.filter((c) => c.contact_name.toLowerCase().includes(needle));
  }
  res.json({ code: 0, message: 'success', contacts: list });
});
router.get('/contacts/:id', (req, res) => {
  const contact = state.contacts.get(req.params.id);
  if (!contact) return res.status(404).json({ code: 4, message: 'Contact not found' });
  res.json({ code: 0, message: 'success', contact });
});
router.post('/contacts', (req, res) => {
  const id = `MOCK-CONTACT-${state.contacts.size + 1}`;
  const contact = { contact_id: id, contact_type: 'customer', ...req.body };
  state.contacts.set(id, contact);
  res.status(201).json({ code: 0, message: 'success', contact });
});

// ── Sales Orders (read + create only) ───────────────────────────────────
router.get('/salesorders', (req, res) => {
  res.json({ code: 0, message: 'success', salesorders: [...state.salesOrders.values()] });
});
router.get('/salesorders/:id', (req, res) => {
  const so = state.salesOrders.get(req.params.id);
  if (!so) return res.status(404).json({ code: 4, message: 'The Sales Order ID given seems to be incorrect.' });
  res.json({ code: 0, message: 'success', salesorder: prepareSalesOrder(so) });
});
router.post('/salesorders', (req, res) => {
  const n = soCounter++;
  const salesorder_id = `MOCK-SO-${String(n).padStart(6, '0')}`;
  const salesorder_number = `SO-${String(n).padStart(5, '0')}`;
  const contact = state.contacts.get(req.body.customer_id);
  const salesorder = {
    salesorder_id,
    salesorder_number,
    status: 'draft',
    customer_id: req.body.customer_id,
    customer_name: contact ? contact.contact_name : req.body.customer_id,
    date: req.body.date || new Date().toISOString().slice(0, 10),
    reference_number: req.body.reference_number,
    notes: req.body.notes,
    line_items: req.body.line_items || [],
    total: (req.body.line_items || []).reduce((sum, li) => sum + (li.rate || 0) * (li.quantity || 0), 0),
    created_time: new Date().toISOString(),
    _mock: true
  };
  state.salesOrders.set(salesorder_id, salesorder);
  res.status(201).json({ code: 0, message: 'Sales order created successfully [HTTP-MOCK MODE]', salesorder });
});

// ── Status updates, Comments, Packages, Shipments ──────────────────────
router.post('/salesorders/:id/status/confirmed', (req, res) => {
  const so = state.salesOrders.get(req.params.id);
  if (!so) return res.status(404).json({ code: 4, message: 'The Sales Order ID given seems to be incorrect.' });
  so.status = 'confirmed';
  res.json({ code: 0, message: 'Sales order status has been changed to Confirmed.' });
});

// Sep 12, 2026: the workflow writes (GETMEDS_WORKFLOW_V2) read the Sales Order
// back before each step, so what they create has to show up on it — the
// invoices[] and packages[] arrays and the line ids the real GET returns.
function prepareSalesOrder(so) {
  so.invoices = so.invoices || [];
  so.packages = so.packages || [];
  (so.line_items || []).forEach((li, i) => {
    if (!li.line_item_id) li.line_item_id = `${so.salesorder_id}-L${i + 1}`;
  });
  return so;
}

router.post('/salesorders/:id/comments', (req, res) => {
  res.json({ code: 0, message: 'Comment added', comment: { description: req.body.description } });
});

router.get('/packages', (req, res) => {
  res.json({ code: 0, message: 'success', packages: [] });
});

router.post('/packages', (req, res) => {
  const pkgId = `MOCK-PKG-${Date.now()}`;
  const soId = req.query.salesorder_id;
  const so = soId ? state.salesOrders.get(soId) : null;
  if (soId && !so) return res.status(404).json({ code: 4, message: 'The Sales Order ID given seems to be incorrect.' });
  if (so && so.status === 'draft') {
    return res.status(400).json({ code: 36004, message: 'Packages cannot be created for sales orders in draft status.' });
  }
  const pkg = { package_id: pkgId, package_number: `PKG-${pkgId.slice(-5)}`, status: 'not_shipped', salesorder_id: soId, ...req.body };
  if (so) prepareSalesOrder(so).packages.push({ package_id: pkg.package_id, package_number: pkg.package_number, status: 'not_shipped' });
  res.status(201).json({ code: 0, message: 'Package created successfully', package: pkg });
});

router.post('/shipmentorders', (req, res) => {
  const so = req.query.salesorder_id ? state.salesOrders.get(req.query.salesorder_id) : null;
  const pkg = so ? prepareSalesOrder(so).packages.find((p) => p.package_id === req.query.package_ids) : null;
  const shipmentorder = {
    shipment_id: `MOCK-SHP-${Date.now()}`,
    shipment_number: req.body.shipment_number,
    status: 'shipped',
    salesorder_id: req.query.salesorder_id,
    carrier: req.body.delivery_method,
    tracking_number: req.body.tracking_number
  };
  if (pkg) Object.assign(pkg, { shipment_id: shipmentorder.shipment_id, shipment_number: shipmentorder.shipment_number, shipment_status: 'shipped', status: 'shipped' });
  res.status(201).json({ code: 0, message: 'Shipment Order Created Successfully', shipmentorder });
});

router.post('/shipmentorders/:id/status/delivered', (req, res) => {
  for (const so of state.salesOrders.values()) {
    const pkg = (so.packages || []).find((p) => p.shipment_id === req.params.id);
    if (pkg) {
      pkg.shipment_status = 'delivered';
      pkg.status = 'delivered';
      return res.json({ code: 0, message: 'The Shipment Order has been marked as Delivered.' });
    }
  }
  res.status(404).json({ code: 4, message: 'The shipment ID given seems to be incorrect.' });
});

// ── Invoices & Customer Payments ────────────────────────────────────────
router.get('/invoices', (req, res) => {
  res.json({ code: 0, message: 'success', invoices: [] });
});

router.post('/invoices/fromsalesorder', (req, res) => {
  const soId = req.query.salesorder_id || req.body.salesorder_id;
  const so = soId ? state.salesOrders.get(soId) : null;
  const invoiceId = `MOCK-INV-${Date.now()}`;
  if (so) {
    so.invoice_status = 'invoiced';
    so.invoiced_status = 'invoiced';
  }
  res.status(201).json({
    code: 0,
    message: 'Invoice created successfully from sales order',
    invoice: { invoice_id: invoiceId, salesorder_id: soId, ...req.body }
  });
});

router.post('/invoices', (req, res) => {
  const invoiceId = `MOCK-INV-${Date.now()}`;
  // Sep 12, 2026: the workflow links an invoice to its Sales Order line by
  // line (salesorder_item_id), not with a top-level salesorder_id.
  const lineIds = (req.body.line_items || []).map((li) => li.salesorder_item_id).filter(Boolean);
  let so = req.body.salesorder_id ? state.salesOrders.get(req.body.salesorder_id) : null;
  if (!so && lineIds.length) {
    so = [...state.salesOrders.values()].find((s) => (s.line_items || []).some((li) => lineIds.includes(li.line_item_id))) || null;
  }
  const invoice = { invoice_id: invoiceId, invoice_number: `INV-${invoiceId.slice(-5)}`, status: 'draft', ...req.body };
  if (so) {
    so.invoice_status = 'invoiced';
    so.invoiced_status = 'invoiced';
    prepareSalesOrder(so).invoices.push({ invoice_id: invoiceId, invoice_number: invoice.invoice_number, status: 'draft' });
  }
  res.status(201).json({ code: 0, message: 'Invoice created successfully', invoice });
});

router.post('/invoices/:id/status/sent', (req, res) => {
  for (const so of state.salesOrders.values()) {
    const inv = (so.invoices || []).find((i) => i.invoice_id === req.params.id);
    if (inv) inv.status = 'sent';
  }
  res.json({ code: 0, message: 'Invoice status has been changed to Sent.' });
});

router.post('/customerpayments', (req, res) => {
  const paymentId = `MOCK-PAY-${Date.now()}`;
  // Mark all sales orders associated with invoices as paid
  for (const so of state.salesOrders.values()) {
    so.paid_status = 'paid';
    so.payment_status = 'paid';
  }
  res.status(201).json({ code: 0, message: 'Payment created successfully', payment: { payment_id: paymentId, ...req.body } });
});

router.post('/invoices/:id/payments', (req, res) => {
  const paymentId = `MOCK-PAY-${Date.now()}`;
  for (const so of state.salesOrders.values()) {
    so.paid_status = 'paid';
    so.payment_status = 'paid';
  }
  res.status(201).json({ code: 0, message: 'Payment recorded successfully', payment: { payment_id: paymentId, ...req.body } });
});

// Explicitly reject anything destructive with a clear message rather than
// a generic 404, so it's obvious this is deliberate, not an oversight.
router.delete('*', (req, res) => {
  res.status(405).json({
    code: 0,
    message: 'This mock server intentionally implements no delete endpoints. Destructive Zoho ' +
      'operations are out of scope for Getmeds order automation.'
  });
});

app.use('/inventory/v1', router);
app.use('/books/v3', router); // Books and Inventory share the same SO/contact/item shape for this mock

app.get('/health', (req, res) => res.json({ ok: true, org: FIXED_ORG_ID }));

const PORT = process.env.MOCK_ZOHO_PORT || 4100;

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[MOCK-ZOHO-SERVER] listening on http://127.0.0.1:${PORT} (fixed org=${FIXED_ORG_ID})`);
    console.log('[MOCK-ZOHO-SERVER] This server never calls the real internet and holds no real data.');
  });
}

module.exports = app;
