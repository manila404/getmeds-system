'use strict';

/**
 * The Zoho write lock (Oct 14, 2026, Aaron).
 *
 * The refresh token is being reissued with ZohoInventory.fullaccess.all, so Zoho itself
 * would now accept anything from this app, deletes included. This lock is what keeps the
 * app to what it was built for, whatever a bug, a script or a future feature asks for:
 *
 *   - DELETE is ALWAYS refused. No exception, no list to add it to.
 *   - GET (reading) is always allowed.
 *   - Any other call (POST, PUT, PATCH...) is allowed ONLY if it is on APPROVED_WRITES
 *     below. Everything else is refused: void, cancel, mark inactive, any other status
 *     change, any other module.
 *
 * Soft delete in Zoho (e.g. marking a customer inactive, voiding an invoice) is possible
 * later, but only by adding that one action to APPROVED_WRITES on purpose, in a reviewed
 * commit. Soft delete inside GetMeds (orders.status = 'deleted') never calls Zoho and is
 * not affected.
 *
 * Every Zoho call in LiveZohoAdapter.js passes through assertZohoCallAllowed() before
 * anything is sent. A refused call throws ZohoCallBlockedError and is logged.
 */

const ID = '[^/]+';
const write = (method, path, why) => ({
  method,
  label: `${method} ${path}`,
  re: new RegExp(`^${path.replace(/:id/g, ID)}/?$`),
  why,
});

/** Every write this app may make. Add one only on purpose — see the note above. */
const APPROVED_WRITES = [
  write('POST', '/salesorders', 'raise an approved order in Zoho'),
  write('PUT', '/salesorders/:id', 'edit an order that is already in Zoho'),
  write('POST', '/salesorders/:id/status/confirmed', "Finance's Verify confirms the Sales Order"),
  write('POST', '/salesorders/:id/attachment', 'attach payment proof to the Sales Order'),
  write('POST', '/contacts', 'create a customer from the order form'),
  write('PUT', '/contacts/:id', "update a customer's TIN / TDS"),
  // Dispatch in GetMeds (only runs when GETMEDS_WORKFLOW_V2=true)
  write('POST', '/invoices', 'Dispatch creates the invoice'),
  write('POST', '/invoices/:id/status/sent', 'Dispatch marks the invoice sent'),
  write('POST', '/packages', 'Dispatch creates the package'),
  write('POST', '/shipmentorders', 'Dispatch creates the shipment'),
  write('POST', '/shipmentorders/:id/status/delivered', 'Dispatch marks the shipment delivered'),
];

class ZohoCallBlockedError extends Error {
  constructor(method, path, reason) {
    super(`Blocked by the Zoho write lock: ${method} ${path} — ${reason}`);
    this.name = 'ZohoCallBlockedError';
    this.code = 'ZOHO_CALL_BLOCKED';
    this.method = method;
    this.path = path;
  }
}

/** Throws ZohoCallBlockedError unless the call may go to Zoho. `path` is without the query string. */
function assertZohoCallAllowed(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '').split('?')[0];
  if (m === 'DELETE') throw new ZohoCallBlockedError(m, p, 'nothing is ever deleted in Zoho from this app.');
  if (m === 'GET') return;
  if (APPROVED_WRITES.some((w) => w.method === m && w.re.test(p))) return;
  throw new ZohoCallBlockedError(m, p, 'this change is not on the approved list (src/integrations/zoho/zohoWriteLock.js).');
}

module.exports = { assertZohoCallAllowed, ZohoCallBlockedError, APPROVED_WRITES };
