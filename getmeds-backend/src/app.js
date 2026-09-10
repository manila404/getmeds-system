require('dotenv').config();
const express = require('express');
const cors = require('cors');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const ordersRoutes = require('./routes/orders.routes');
const financeRoutes = require('./routes/finance.routes');
const dispatchRoutes = require('./routes/dispatch.routes');
const managementRoutes = require('./routes/management.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const adminRoutes = require('./routes/admin.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const testRoutes = require('./routes/test.routes');
const webhookRoutes = require('./routes/webhook.routes');
const customersRoutes = require('./routes/customers.routes');
const syncJobsRoutes = require('./routes/syncJobs.routes');
const cronRoutes = require('./routes/cron.routes');
// Sep 10, 2026: who owns the Sales Orders imported from Zoho — the review
// queue behind services/salespersonMappingService.js.
const salespersonMappingRoutes = require('./routes/salespersonMapping.routes');

const app = express();

// Sep 2, 2026: both branches of this used to `callback(null, true)` — the
// localhost check computed an answer and then allowed everything regardless,
// so any website a logged-in user visited could call this API with their
// cookies. Harmless while the only origin was a laptop; not harmless on a
// public URL.
//
// CORS_ALLOWED_ORIGINS is a comma-separated allowlist. Unset, it falls back to
// local dev origins only, so a deployment that forgets to set it fails closed
// (the frontend breaks loudly) rather than open (everything works, including
// for attackers).
const DEV_ORIGINS = [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (!configuredOrigins.length && process.env.NODE_ENV === 'production') {
  console.warn(
    '\n⚠️  CORS_ALLOWED_ORIGINS is not set and NODE_ENV=production.\n' +
      '   Only localhost origins are allowed, so the deployed frontend will be blocked.\n' +
      '   Set it to the frontend URL, e.g. CORS_ALLOWED_ORIGINS=https://orders.getmeds.ph\n'
  );
}

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header at all: same-origin, curl, Postman, and server-to-server
    // callers such as Zoho's webhook. CORS is a browser mechanism and has
    // nothing to say about these — the webhook is authenticated by
    // ZOHO_WEBHOOK_SECRET, not by its origin.
    if (!origin) return callback(null, true);

    const normalized = origin.replace(/\/+$/, '');
    if (configuredOrigins.includes(normalized)) return callback(null, true);
    if (DEV_ORIGINS.some((re) => re.test(normalized))) return callback(null, true);

    // Refused as "not allowed", not as an error: throwing here surfaces to the
    // browser as an opaque network failure and to the log as a stack trace for
    // something that is a routine, expected rejection.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
// Zoho's older Workflow Rule webhook action posts x-www-form-urlencoded
// (key "payload", value a JSON string) instead of raw JSON — parse that too
// so the receiver at /api/webhooks/zoho gets a populated req.body either way.
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => res.json({ success: true, message: 'Getmeds API is running', timestamp: new Date().toISOString() }));

const { requireAuth } = require('./middleware/auth');
const ordersController = require('./controllers/orders.controller');
app.get('/api/products', requireAuth, ordersController.getProducts);
// Full customers admin view (with Zoho-origin tagging + sync-from-zoho) now
// lives at /api/customers via customersRoutes below, replacing the old
// direct route here.

app.use('/api/auth', authRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/test', testRoutes);
app.use('/api/customers', customersRoutes);
// Aug 28, 2026: shared polling endpoint for the customers/inventory
// background Quick Sync / Full Resync jobs (see services/syncJobs.js).
app.use('/api/sync-jobs', syncJobsRoutes);
// Sep 3, 2026: the serverless replacement for the two setInterval loops in
// server.js. Vercel never calls app.listen(), so those timers do not exist
// there. Authenticated by CRON_SECRET inside the controller, not requireAuth.
app.use('/api/cron', cronRoutes);
app.use('/api/salesperson-mappings', salespersonMappingRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } }));

app.use(errorHandler);

module.exports = app;
