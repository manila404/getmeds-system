/**
 * The Zoho write lock (Oct 14, 2026): with a full-access token, the app still never deletes
 * anything in Zoho, and only makes the writes on the approved list.
 *
 *  - DELETE is refused, always; GET is always fine;
 *  - every write the adapter makes today is on the list (so no feature breaks);
 *  - void, mark inactive, other status changes and other modules are refused;
 *  - a refused call never reaches the network.
 */
const fs = require('fs');
const path = require('path');
const { assertZohoCallAllowed, ZohoCallBlockedError } = require('../src/integrations/zoho/zohoWriteLock');
const LiveZohoAdapter = require('../src/integrations/zoho/LiveZohoAdapter');

const allowed = (m, p) => { assertZohoCallAllowed(m, p); return true; };
const blocked = (m, p) => expect(() => assertZohoCallAllowed(m, p)).toThrow(ZohoCallBlockedError);

test('DELETE is always refused, reading is always fine', () => {
  for (const p of ['/salesorders/123', '/invoices/9', '/contacts/1', '/items/5', '/salesorders']) blocked('DELETE', p);
  for (const p of ['/invoices', '/creditnotes', '/salesorders/1/comments', '/anything/else']) expect(allowed('GET', p)).toBe(true);
});

test('every write the adapter makes today is approved', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/integrations/zoho/LiveZohoAdapter.js'), 'utf8');
  const calls = [...src.matchAll(/_(?:request|assertCallAllowed)\('(POST|PUT|PATCH|DELETE)',\s*[`']([^`']+)[`']/g)]
    .map(([, m, p]) => [m, p.replace(/\$\{[^}]+\}/g, '123')]);
  expect(calls.length).toBeGreaterThanOrEqual(11);
  for (const [m, p] of calls) expect(allowed(m, p)).toBe(true);
});

test('soft deletes and anything else not on the list are refused', () => {
  blocked('POST', '/invoices/123/status/void');
  blocked('POST', '/salesorders/123/status/void');
  blocked('POST', '/contacts/123/inactive');
  blocked('POST', '/items/123/inactive');
  blocked('POST', '/creditnotes');
  blocked('PUT', '/invoices/123');
  blocked('PATCH', '/salesorders/123');
  blocked('POST', '/salesorders/123/extra');        // approved paths match exactly, not by prefix
  blocked('PUT', '/salesorders/123/../../items/1');
});

test('a refused call never reaches Zoho, and says why', async () => {
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = jest.fn(async (url, init) => { sent.push([init && init.method, url]); return { ok: true, json: async () => ({ code: 0 }) }; });
  const logs = [];
  try {
    const z = new LiveZohoAdapter({
      baseUrl: 'https://zoho.invalid/inventory/v1', organizationId: 'ORG1', allowedOrgIds: ['ORG1'],
      getAccessToken: async () => 'token', log: (m) => logs.push(m),
    });
    await expect(z._request('DELETE', '/salesorders/77')).rejects.toThrow(/nothing is ever deleted/);
    await expect(z._request('POST', '/invoices/77/status/void')).rejects.toThrow(/not on the approved list/);
    expect(sent).toHaveLength(0);
    expect(logs.filter((l) => l.includes('BLOCKED'))).toHaveLength(2);

    await z._request('GET', '/invoices');
    await z._request('PUT', '/salesorders/77', { body: {} });
    expect(sent.map(([m]) => m)).toEqual(['GET', 'PUT']);
  } finally {
    global.fetch = realFetch;
  }
});
