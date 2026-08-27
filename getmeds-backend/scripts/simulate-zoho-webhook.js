#!/usr/bin/env node
/**
 * simulate-zoho-webhook.js
 *
 * Fires realistic Zoho webhook payloads at your local receiver
 * (POST /api/webhooks/zoho) so you can prove the whole pipeline works
 * BEFORE spending time on ngrok + Zoho's webhook settings UI.
 *
 * Usage:
 *   node scripts/simulate-zoho-webhook.js <GETMEDS_ORDER_ID> [scenario]
 *
 *   GETMEDS_ORDER_ID   e.g. GM-20260826-0001 (any order already in your
 *                      local DB — create one via the app first, in any
 *                      status except completed/cancelled)
 *   scenario           confirmed | payment | package | shipment | cancelled | all
 *                      (default: all — runs confirmed -> payment -> package ->
 *                      shipment in order, which mirrors a real order's lifecycle)
 *
 * Examples:
 *   node scripts/simulate-zoho-webhook.js GM-20260826-0001
 *   node scripts/simulate-zoho-webhook.js GM-20260826-0001 payment
 *   node scripts/simulate-zoho-webhook.js GM-20260826-0001 package
 *
 * What it proves: the receiver's auth check, payload parsing (including
 * Zoho's JSONString wrapping), order lookup, state transition, audit log,
 * and notification dispatch — using the exact shapes
 * src/controllers/webhook.controller.js expects, without needing a real
 * Zoho account or a public URL.
 */

require('dotenv').config();

const ORDER_ID = process.argv[2];
const SCENARIO = (process.argv[3] || 'all').toLowerCase();
const BASE_URL = process.env.WEBHOOK_TEST_URL || 'http://localhost:4000/api/webhooks/zoho';
const SECRET = process.env.ZOHO_WEBHOOK_SECRET || '';

if (!ORDER_ID) {
  console.error('Usage: node scripts/simulate-zoho-webhook.js <GETMEDS_ORDER_ID> [confirmed|payment|package|shipment|cancelled|all]');
  console.error('Example: node scripts/simulate-zoho-webhook.js GM-20260826-0001 all');
  process.exit(1);
}

const payloads = {
  confirmed: {
    event_type: 'salesorder.confirmed',
    getmeds_order_id: ORDER_ID,
    salesorder: {
      salesorder_id: `ZOHO-SO-SIM-${Date.now()}`,
      salesorder_number: 'SO-SIM-0001',
      status: 'confirmed'
    }
  },
  payment: {
    event_type: 'payment.created',
    getmeds_order_id: ORDER_ID,
    payment: {
      payment_id: `PMT-SIM-${Date.now()}`,
      amount: 1500,
      status: 'success',
      date: new Date().toISOString().split('T')[0]
    }
  },
  package: {
    event_type: 'package.created',
    getmeds_order_id: ORDER_ID,
    package: {
      package_id: `PKG-SIM-${Date.now()}`,
      package_number: `PKG-SIM-0001`,
      status: 'draft'
    }
  },
  shipment: {
    event_type: 'shipment.created',
    getmeds_order_id: ORDER_ID,
    shipment: {
      shipment_id: `SHP-SIM-${Date.now()}`,
      tracking_number: `TRK-SIM-${Date.now()}`,
      carrier: 'LBC Express'
    }
  },
  cancelled: {
    event_type: 'salesorder.cancelled',
    getmeds_order_id: ORDER_ID,
    salesorder: { status: 'cancelled' }
  }
};

async function fire(name, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (SECRET) headers['X-Zoho-Webhook-Token'] = SECRET;

  console.log(`\n→ ${name}  POST ${BASE_URL}`);
  console.log('  payload:', JSON.stringify(payload));

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));

  const ok = res.ok && body.processed !== false;
  console.log(`  ← ${res.status} ${ok ? '✓' : '⚠'}`, JSON.stringify(body));
  return body;
}

(async () => {
  console.log(`Simulating Zoho webhook(s) for ${ORDER_ID} against ${BASE_URL}`);
  console.log(SECRET ? '  auth: sending X-Zoho-Webhook-Token' : '  auth: none configured (ZOHO_WEBHOOK_SECRET is blank — dev mode)');

  try {
    if (SCENARIO === 'all') {
      await fire('salesorder.confirmed', payloads.confirmed);
      await fire('payment.created', payloads.payment);
      await fire('package.created', payloads.package);
      await fire('shipment.created', payloads.shipment);
    } else if (payloads[SCENARIO]) {
      await fire(payloads[SCENARIO].event_type, payloads[SCENARIO]);
    } else {
      console.error(`Unknown scenario "${SCENARIO}". Use confirmed | payment | package | shipment | cancelled | all.`);
      process.exit(1);
    }
    console.log('\nDone. Check the order in the app (or the audit log) to confirm the status moved.');
  } catch (err) {
    console.error('\nRequest failed — is the backend running on', BASE_URL.replace('/api/webhooks/zoho', ''), '?');
    console.error(err.message);
    process.exit(1);
  }
})();
