/**
 * An order raised for a colleague belongs to two people.
 *
 * Sep 12, 2026.
 *
 * ── The claim these tests defend ───────────────────────────────────────────
 *
 * A MedRep can raise an order for a colleague. That splits a single question
 * ("is this my order?") into two facts the row now carries separately:
 *
 *   medrep_id     who it BELONGS to — whose numbers it counts toward, and
 *                                     whose Salesperson goes to Zoho
 *   raised_by_id  who FILLED IT IN  — NULL unless those differ
 *
 * Both people get the same access. The alternative was tried and does not
 * survive contact with use: when only the owner counted, the rep who typed
 * the order in could not see it in their own list, could not open it, and —
 * the way it actually surfaced — could not attach the payment receipt they
 * had just selected, because the upload was refused the instant the order
 * saved. GM-20260911-0003: an order created, a red toast, and no file.
 *
 * So these tests pin BOTH halves:
 *   - the raiser is let in, everywhere the owner is
 *   - nobody else is, which is the half that a blanket fix would lose
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

describe('an order raised on behalf of a colleague', () => {
  let ownerToken, raiserToken, strangerToken;
  let ownerId, raiserId, orderId;
  const createdOrderIds = [];
  const createdUserIds = [];

  beforeAll(async () => {
    ownerToken = await loginAs('medrep@getmeds.ph');
    const owner = await db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get('medrep@getmeds.ph');
    ownerId = owner.id;

    // Two more reps: one who raises the order, one with no connection to it.
    // Reusing the seeded hash means loginAs works without this file needing
    // bcryptjs.
    for (const [name, email] of [
      ['Behalf Raiser', 'behalf-raiser@getmeds.ph'],
      ['Behalf Stranger', 'behalf-stranger@getmeds.ph'],
    ]) {
      const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) { createdUserIds.push(existing.id); continue; }
      const res = await db
        .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'medrep')")
        .run(name, email, owner.password_hash);
      createdUserIds.push(res.lastInsertRowid);
    }

    raiserToken = await loginAs('behalf-raiser@getmeds.ph');
    strangerToken = await loginAs('behalf-stranger@getmeds.ph');
    raiserId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('behalf-raiser@getmeds.ph')).id;

    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const ref = `BEHALF-${Date.now()}`;
    orderId = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, raised_by_id, status,
                             customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, ?, 'submitted', 'direct', 1500, '1 Behalf St')`
      )
      .run(ref, customerId, ownerId, raiserId)).lastInsertRowid;
    createdOrderIds.push(orderId);
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    for (const id of createdUserIds) await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  const listIdsFor = async (token) => {
    const res = await request(app).get('/api/orders?limit=200').set(auth(token));
    expect(res.status).toBe(200);
    const rows = res.body.data.orders || res.body.data || [];
    return rows.map((o) => o.id);
  };

  test('it appears in the list for the MedRep it belongs to', async () => {
    expect(await listIdsFor(ownerToken)).toContain(orderId);
  });

  test('it appears in the list for the MedRep who raised it', async () => {
    // The point of the whole change: the rep who typed it in can find it
    // again without asking the colleague to read it back to them.
    expect(await listIdsFor(raiserToken)).toContain(orderId);
  });

  test('it appears for nobody else', async () => {
    expect(await listIdsFor(strangerToken)).not.toContain(orderId);
  });

  test('both can open it, and a stranger cannot', async () => {
    for (const token of [ownerToken, raiserToken]) {
      const res = await request(app).get(`/api/orders/${orderId}`).set(auth(token));
      expect(res.status).toBe(200);
    }
    const denied = await request(app).get(`/api/orders/${orderId}`).set(auth(strangerToken));
    expect(denied.status).toBe(403);
  });

  test('the raiser can act on it, not only read it', async () => {
    // An order you can create but not submit is not a feature. updateDetails
    // stands in for the write path generally — it shares canActOnOrder with
    // submit, retryZohoSync, syncFromZoho and updateItems.
    const res = await request(app)
      .patch(`/api/orders/${orderId}/details`)
      .set(auth(raiserToken))
      .send({ delivery_notes: 'raised on behalf' });

    expect(res.status).not.toBe(403);

    const denied = await request(app)
      .patch(`/api/orders/${orderId}/details`)
      .set(auth(strangerToken))
      .send({ delivery_notes: 'should not stick' });
    expect(denied.status).toBe(403);
  });

  test('raised_by_id stays NULL for an ordinary order', async () => {
    // "Nobody else raised this" and "the owner raised it" are the same fact,
    // and storing the owner's id on every row would invite a future reader to
    // think the column means something it does not.
    const customerId = (await db.prepare('SELECT id FROM customers LIMIT 1').get()).id;
    const ref = `BEHALF-PLAIN-${Date.now()}`;
    const plainId = (await db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status,
                             customer_type, total_amount, delivery_address)
         VALUES (?, ?, ?, 'submitted', 'direct', 1500, '1 Plain St')`
      )
      .run(ref, customerId, ownerId)).lastInsertRowid;
    createdOrderIds.push(plainId);

    const row = await db.prepare('SELECT raised_by_id FROM orders WHERE id = ?').get(plainId);
    expect(row.raised_by_id).toBeNull();
    expect(await listIdsFor(ownerToken)).toContain(plainId);
  });
});
