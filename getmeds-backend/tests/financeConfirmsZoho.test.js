/**
 * Finance's verification is what confirms the Sales Order in Zoho.
 *
 * Sep 12, 2026.
 *
 * ── What changed, and why ─────────────────────────────────────────────────
 *
 * Every Sales Order this app creates starts as a DRAFT, and a draft is
 * invisible to the rest of Zoho's pipeline — it cannot be invoiced or packed.
 * A person confirmed each one by hand in Zoho Books, and this app waited to be
 * told. Two consequences:
 *
 *   - Finance's verification released nothing. The step that actually moved
 *     the order happened in another system, with no link between the two.
 *   - An order nobody remembered to confirm simply sat at 'so_created',
 *     invisible to Finance, waiting on a step nothing prompted anyone to take.
 *     GM-20260912-0003 sat there with its Sales Order still in Draft.
 *
 * So a credit order now lands on Finance directly, and verifying it confirms
 * the Sales Order in Zoho.
 *
 * ── The property that matters most ────────────────────────────────────────
 *
 * A Zoho failure must NOT undo the verification. The decision is a person's
 * and it is already made; Zoho being unreachable is this app's problem to
 * retry, not a reason to discard it or to block Finance from working. That is
 * the second-to-last test here, and it is the one a careless refactor breaks.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const zoho = require('../src/integrations/zoho');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('verifying an order confirms its Sales Order in Zoho', () => {
  let financeToken;
  let customerId, medrepId;
  const createdOrderIds = [];

  beforeAll(async () => {
    financeToken = await loginAs('finance@getmeds.ph');
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    medrepId = (await db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  async function orderAwaitingFinance({ zohoSoId = 'MOCK-SO-CONFIRM' } = {}) {
    const ref = `CONFIRM-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_so_number, zoho_so_status)
         VALUES (?, ?, ?, 'ready_for_finance_verified', 'credit', 1500, '1 Confirm St', ?, 'SO-TEST', 'draft')`
      )
      .run(ref, customerId, medrepId, zohoSoId);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);
    return id;
  }

  const orderRow = async (id) =>
    db.prepare('SELECT status, zoho_so_status, zoho_sync_status FROM orders WHERE id = ?').get(id);

  const verify = (id, approved = true, reason) =>
    request(app).post(`/api/finance/orders/${id}/verify`).set(auth(financeToken)).send({ approved, reason });

  test('the adapter exposes confirmSalesOrder through the facade', () => {
    // The facade allowlist in integrations/zoho/index.js has been the thing
    // forgotten four times: a method can exist on the base contract, the Live
    // adapter AND the Mock and still be undefined through the one module every
    // controller imports.
    expect(typeof zoho.confirmSalesOrder).toBe('function');
  });

  test('approving moves the order on and confirms the Sales Order', async () => {
    const id = await orderAwaitingFinance();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder').mockResolvedValue({ code: 0, message: 'ok' });

    const res = await verify(id);
    expect(res.status).toBe(200);
    expect(res.body.data.approved).toBe(true);
    expect(res.body.data.zohoConfirmed).toEqual({ ok: true, alreadyConfirmed: false });
    expect(spy).toHaveBeenCalledWith('MOCK-SO-CONFIRM');

    const row = await orderRow(id);
    expect(row.status).toBe('ready_for_draft_invoice');
    expect(row.zoho_so_status).toBe('confirmed');

    const ev = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SO_CONFIRMED'")
      .get(id);
    expect(ev).toBeTruthy();

    spy.mockRestore();
  });

  test('an already-confirmed Sales Order is a success, not a failure', async () => {
    // Somebody may have confirmed it in Zoho Books a minute earlier. The
    // intent — "this should be confirmed" — is satisfied either way, and
    // flagging a sync error on an order already in the wanted state would send
    // someone chasing nothing.
    const id = await orderAwaitingFinance();
    const spy = jest
      .spyOn(zoho, 'confirmSalesOrder')
      .mockResolvedValue({ code: 0, message: 'already', alreadyConfirmed: true });

    const res = await verify(id);
    expect(res.body.data.zohoConfirmed).toEqual({ ok: true, alreadyConfirmed: true });
    expect((await orderRow(id)).zoho_sync_status).not.toBe('failed');

    spy.mockRestore();
  });

  test('holding the order does NOT confirm anything in Zoho', async () => {
    // A hold releases nothing. Confirming here would push into Zoho an order
    // Finance has just refused.
    const id = await orderAwaitingFinance();
    const spy = jest.spyOn(zoho, 'confirmSalesOrder').mockResolvedValue({ code: 0 });

    const res = await verify(id, false, 'needs a proof of payment');
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect((await orderRow(id)).zoho_so_status).toBe('draft');

    spy.mockRestore();
  });

  test('a Zoho failure does not undo the verification', async () => {
    // The property that matters most. The decision is a person's and already
    // made; Zoho being unreachable is this app's problem to retry, never a
    // reason to discard it or to stop Finance working.
    const id = await orderAwaitingFinance();
    const spy = jest
      .spyOn(zoho, 'confirmSalesOrder')
      .mockRejectedValue(new Error('Zoho did not respond within 30s'));

    const res = await verify(id);
    expect(res.status).toBe(200);
    expect(res.body.data.approved).toBe(true);
    expect(res.body.data.zohoConfirmed.ok).toBe(false);

    const row = await orderRow(id);
    // Moved on regardless...
    expect(row.status).toBe('ready_for_draft_invoice');
    // ...and the failure is on the record rather than lost.
    expect(row.zoho_sync_status).toBe('failed');

    const ev = await db
      .prepare("SELECT * FROM order_events WHERE order_id = ? AND event_type = 'ZOHO_SYNC_FAILED'")
      .get(id);
    expect(ev.notes).toMatch(/could not be confirmed in Zoho/i);

    spy.mockRestore();
  });

  test('an order with no Zoho Sales Order is verified without calling Zoho', async () => {
    // Its sync failed earlier, so there is no document to confirm yet.
    const id = await orderAwaitingFinance({ zohoSoId: null });
    const spy = jest.spyOn(zoho, 'confirmSalesOrder').mockResolvedValue({ code: 0 });

    const res = await verify(id);
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(res.body.data.zohoConfirmed).toBeNull();

    spy.mockRestore();
  });
});
