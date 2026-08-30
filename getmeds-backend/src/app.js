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

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    // Allow any localhost / 127.0.0.1 port or requests without origin (like Postman / mobile)
    if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, true);
    }
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

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } }));

app.use(errorHandler);

module.exports = app;
