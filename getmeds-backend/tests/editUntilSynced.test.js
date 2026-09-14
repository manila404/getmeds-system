/**
 * A MedRep can correct their order until Zoho has it.
 *
 * Sep 12, 2026.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * updateItems and updateDetails disagreed about when an order stops being
 * editable, and in the worse direction of the two.
 *
 *   updateItems    refused once a Zoho Sales Order existed
 *   updateDetails  refused that too, AND anything outside
 *                  draft / pending_management_approval
 *
 * So an order on hold that had never reached Zoho would accept a change to its
 * LINE ITEMS — the money — and refuse a change to its DETAILS. A MedRep held
 * with "walang shipment date" could edit the price but not add the shipment
 * date they were being asked for (GM-20260912-0004).
 *
 * ── The rule now ──────────────────────────────────────────────────────────
 *
 * The Zoho Sales Order is the boundary, for both. Before it exists the order
 * is this app's alone and correcting it is exactly what should happen; after,
 * an edit here would silently diverge from the record everyone else works
 * from. Terminal statuses are still refused: a completed, cancelled or deleted
 * order is finished whatever Zoho knows about it.
 */

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');

const SEED_PASSWORD = 'demo123';

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: SEED_PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('editing an order before it reaches Zoho', () => {
  let ownerToken;
  let ownerId, customerId;
  const createdOrderIds = [];

  beforeAll(async () => {
    ownerToken = await loginAs('medrep@getmeds.ph');
    ownerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('medrep@getmeds.ph')).id;
    customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  });

  async function orderAt(status, { zohoSoId = null } = {}) {
    const ref = `EDIT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address, zoho_so_id, zoho_so_number)
         VALUES (?, ?, ?, ?, 'credit', 1500, '1 Edit St', ?, ?)`
      )
      .run(ref, customerId, ownerId, status, zohoSoId, zohoSoId ? 'SO-EDIT' : null);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);
    return id;
  }

  const editDetails = (id, body) =>
    request(app).patch(`/api/orders/${id}/details`).set(auth(ownerToken)).send(body);

  const notesOf = async (id) =>
    (await db.prepare('SELECT delivery_notes FROM orders WHERE id = ?').get(id)).delivery_notes;

  test('a held order that never reached Zoho can be corrected', async () => {
    // The case that surfaced this: held for a missing shipment date, and the
    // rep could not add one.
    const id = await orderAt('on_hold');

    const res = await editDetails(id, { delivery_notes: 'shipment date added' });
    expect(res.status).toBe(200);
    expect(await notesOf(id)).toBe('shipment date added');
  });

  test('details and items agree about when editing stops', async () => {
    // The actual defect was the disagreement, not either rule alone.
    const id = await orderAt('on_hold');

    const details = await editDetails(id, { delivery_notes: 'both should allow this' });
    const items = await request(app)
      .patch(`/api/orders/${id}/items`)
      .set(auth(ownerToken))
      .send({ items: [{ product_id: (await db.prepare('SELECT id FROM products LIMIT 1').get()).id, quantity: 1, unit_price: 100 }] });

    expect(details.status).toBe(200);
    expect(items.status).toBe(200);
  });

  test('a draft and a pending-approval order still edit, as before', async () => {
    for (const status of ['draft', 'pending_management_approval']) {
      const id = await orderAt(status);
      const res = await editDetails(id, { delivery_notes: `edited at ${status}` });
      expect(res.status).toBe(200);
    }
  });

  test('once a Zoho Sales Order exists, editing is refused', async () => {
    // The real boundary. Editing here would diverge from the record everyone
    // else works from.
    const id = await orderAt('ready_for_finance_verified', { zohoSoId: 'ZOHO-SO-123' });

    const res = await editDetails(id, { delivery_notes: 'too late' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SYNCED');
    expect(await notesOf(id)).not.toBe('too late');
  });

  test('a finished order is refused even with no Zoho Sales Order', async () => {
    for (const status of ['completed', 'cancelled', 'deleted']) {
      const id = await orderAt(status);
      const res = await editDetails(id, { delivery_notes: 'reopening the past' });
      expect(res.status).toBe(409);
      expect(await notesOf(id)).not.toBe('reopening the past');
    }
  });

  test('somebody else MedRep order is still none of their business', async () => {
    // Widening WHEN an order can be edited must not widen WHO can edit it.
    const other = await db.prepare("SELECT id FROM users WHERE role = 'medrep' AND id <> ? LIMIT 1").get(ownerId);
    const ref = `EDIT-OTHER-${Date.now()}`;
    await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address)
         VALUES (?, ?, ?, 'on_hold', 'credit', 1500, '1 Other St')`
      )
      .run(ref, customerId, other.id);
    const { id } = await db.prepare('SELECT id FROM orders WHERE getmeds_order_id = ?').get(ref);
    createdOrderIds.push(id);

    const res = await editDetails(id, { delivery_notes: 'not mine' });
    expect(res.status).toBe(403);
  });
});
