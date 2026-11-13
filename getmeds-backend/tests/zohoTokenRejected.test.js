/**
 * Nov 13, 2026: Zoho cancels the oldest access tokens of a refresh token once too many are
 * active, and an instance still holding a cancelled one failed every call with "You are not
 * authorized to perform this operation" (41 creates/confirms since Oct 1; GM-20261113-0044's
 * create failed, then the same create worked 41 seconds later).
 *   1. a call Zoho rejects for the token is repeated once with a fresh token;
 *   2. the whole app shares one access token (sync_state), instead of one per instance;
 *   3. Retry Zoho Sync confirms a Sales Order that exists but whose confirm failed.
 * No real Zoho is called: fetch is replaced in this file.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const ENV = {
  ZOHO_MODE: 'live', ZOHO_ORG_ID: 'TEST-ORG', ZOHO_ALLOWED_ORG_IDS: 'TEST-ORG',
  ZOHO_API_BASE_URL: 'https://zoho.test/inventory/v1', ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.test',
  ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'secret', ZOHO_REFRESH_TOKEN: 'refresh'
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = global.fetch;
let minted, apiCalls;

function fakeZoho({ rejectToken = null } = {}) {
  minted = 0; apiCalls = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://accounts.zoho.test')) {
      minted += 1;
      return json(200, { access_token: `tok-${minted}`, expires_in: 3600 });
    }
    const token = String((init.headers || {}).Authorization || '').replace('Zoho-oauthtoken ', '');
    apiCalls.push({ url: u, method: init.method || 'GET', token });
    if (token === rejectToken) return json(401, { code: 57, message: 'You are not authorized to perform this operation' });
    return json(200, { code: 0, message: 'The sales order has been confirmed.' });
  });
}

beforeEach(async () => { await db.prepare("DELETE FROM sync_state WHERE key = 'zoho_access_token'").run(); });
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await db.prepare("DELETE FROM sync_state WHERE key = 'zoho_access_token'").run(); });

describe('a rejected access token', () => {
  test('the call is repeated once with a fresh token, and succeeds', async () => {
    fakeZoho({ rejectToken: 'tok-1' });
    const adapter = zoho._buildAdapterForTest(ENV);
    const res = await adapter.confirmSalesOrder('SO-1');
    expect(res.code).toBe(0);
    expect(apiCalls.map((c) => c.token)).toEqual(['tok-1', 'tok-2']);
    expect(minted).toBe(2);
  });

  test('a genuine refusal is not repeated more than once', async () => {
    minted = 0; apiCalls = [];
    global.fetch = jest.fn(async (url, init = {}) => {
      if (String(url).startsWith('https://accounts.zoho.test')) { minted += 1; return json(200, { access_token: `tok-${minted}`, expires_in: 3600 }); }
      apiCalls.push(url);
      return json(401, { code: 57, message: 'You are not authorized to perform this operation' });
    });
    const adapter = zoho._buildAdapterForTest(ENV);
    await expect(adapter.confirmSalesOrder('SO-2')).rejects.toThrow(/not authorized/);
    expect(apiCalls).toHaveLength(2);
  });
});

describe('one shared token', () => {
  test('two instances use the same token instead of minting one each', async () => {
    fakeZoho();
    const a = zoho._buildAdapterForTest(ENV);
    const b = zoho._buildAdapterForTest(ENV); // a second server instance: its own memory, same database
    await a.confirmSalesOrder('SO-3');
    await b.confirmSalesOrder('SO-4');
    expect(minted).toBe(1);
    expect(apiCalls.map((c) => c.token)).toEqual(['tok-1', 'tok-1']);
  });

  test('a rejected shared token is dropped for everyone', async () => {
    fakeZoho({ rejectToken: 'tok-1' });
    const a = zoho._buildAdapterForTest(ENV);
    await a.confirmSalesOrder('SO-5'); // tok-1 rejected -> tok-2 minted and shared
    const b = zoho._buildAdapterForTest(ENV);
    await b.confirmSalesOrder('SO-6');
    expect(apiCalls.map((c) => c.token)).toEqual(['tok-1', 'tok-2', 'tok-2']);
    const row = await db.prepare("SELECT value FROM sync_state WHERE key = 'zoho_access_token'").get();
    expect(JSON.parse(row.value).token).toBe('tok-2');
  });
});

describe('Retry Zoho Sync on a Sales Order whose confirm failed', () => {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  const ids = [];
  let token, getSpy, confirmSpy;
  const mk = async (status, key) => {
    const c = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const m = (await db.prepare("SELECT id FROM users WHERE email = 'medrep@getmeds.ph'").get()).id;
    const ref = `GM-CONF-${stamp}-${key}`;
    await db.prepare(
      `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type, total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_so_status, zoho_sync_status)
       VALUES (?, ?, ?, ?, 'credit', 100, 'x', ?, ?, 'draft', 'failed')`
    ).run(ref, c, m, status, `ZSO-${stamp}-${key}`, `SO-T-${key}`);
    const id = (await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref)).id;
    ids.push(id);
    return id;
  };
  // The Zoho write guard limits writes to the test customers in .env; Zoho is faked here, so off.
  const savedTestIds = process.env.ZOHO_TEST_CUSTOMER_IDS;
  afterAll(() => { if (savedTestIds === undefined) delete process.env.ZOHO_TEST_CUSTOMER_IDS; else process.env.ZOHO_TEST_CUSTOMER_IDS = savedTestIds; });
  beforeAll(async () => {
    process.env.ZOHO_TEST_CUSTOMER_IDS = '';
    token = (await request(app).post('/api/auth/login').send({ email: 'manager@getmeds.ph', password: 'demo123' })).body.data.token;
  });
  beforeEach(() => {
    getSpy = jest.spyOn(zoho, 'getSalesOrder').mockResolvedValue({ salesorder: { status: 'draft' } });
    confirmSpy = jest.spyOn(zoho, 'confirmSalesOrder').mockResolvedValue({ code: 0 });
  });
  afterEach(() => { getSpy.mockRestore(); confirmSpy.mockRestore(); });
  afterAll(async () => {
    for (const id of ids) { await db.prepare('DELETE FROM order_events WHERE order_id = ?').run(id); await db.prepare('DELETE FROM zoho_sync_queue WHERE order_id = ?').run(id); await db.prepare('DELETE FROM orders WHERE id = ?').run(id); }
  });
  const retry = (id) => request(app).post(`/api/orders/${id}/retry-zoho-sync`).set({ Authorization: `Bearer ${token}` }).send({});

  test('confirms it in Zoho and marks it synced, logged on the order', async () => {
    const id = await mk('ready_for_dispatch', 'a');
    const res = await retry(id);
    expect(res.status).toBe(200);
    expect(confirmSpy).toHaveBeenCalledWith(`ZSO-${stamp}-a`);
    const o = await db.prepare('SELECT zoho_so_status, zoho_sync_status FROM orders WHERE id = ?').get(id);
    expect(o).toEqual({ zoho_so_status: 'confirmed', zoho_sync_status: 'synced' });
    const ev = await db.prepare("SELECT notes FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_CONFIRMED'").get(id);
    expect(ev.notes).toMatch(/confirmed in Zoho by Retry Zoho Sync/);
  });

  test('already confirmed in Zoho: only marked synced, no confirm call', async () => {
    getSpy.mockResolvedValue({ salesorder: { status: 'confirmed' } });
    const id = await mk('tracking_shared', 'b');
    expect((await retry(id)).status).toBe(200);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT zoho_sync_status FROM orders WHERE id = ?').get(id)).zoho_sync_status).toBe('synced');
  });

  test('not before Finance has verified the order', async () => {
    const id = await mk('ready_for_finance_verified', 'c');
    const res = await retry(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_VERIFIED');
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
