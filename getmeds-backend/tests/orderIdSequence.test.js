/**
 * Guards the fix for the order-number collision found on Sep 2, 2026.
 *
 * services/orderIdService.js derived the next number with
 * `SELECT MAX(...) FROM orders`. Both callers in orders.controller.js sit an
 * `await zoho.createSalesOrder(...)` between generating the id and inserting
 * the row — necessarily, because a better-sqlite3 transaction cannot contain
 * an await. So two MedReps submitting within a second or two of each other
 * read the same maximum, receive the same id, and both create a REAL Zoho
 * Sales Order carrying the same reference_number. The first INSERT wins; the
 * second fails on getmeds_order_id's UNIQUE constraint, leaving an orphaned
 * Sales Order in the company's Zoho org and an error on the MedRep's screen.
 *
 * The tests below all generate ids WITHOUT inserting orders between them,
 * because that is precisely the window the bug lived in. Under the old
 * implementation every one of them returns the same string.
 */
const db = require('../src/db/database');
const { generateOrderId } = require('../src/services/orderIdService');

const seqOf = (id) => parseInt(id.split('-')[2], 10);
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

describe('order id generation is collision-safe', () => {
  const createdOrderIds = [];

  beforeEach(() => {
    delete process.env.ZOHO_DRY_RUN;
    delete process.env.ZOHO_TEST_CUSTOMER_ID;
    delete process.env.ZOHO_TEST_CUSTOMER_IDS;
  });

  afterAll(() => {
    for (const id of createdOrderIds) {
      db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    }
    delete process.env.ZOHO_DRY_RUN;
    delete process.env.ZOHO_TEST_CUSTOMER_ID;
    delete process.env.ZOHO_TEST_CUSTOMER_IDS;
  });

  test('successive ids are distinct and increment, with no order inserted between them', () => {
    const a = generateOrderId();
    const b = generateOrderId();
    const c = generateOrderId();

    expect(new Set([a, b, c]).size).toBe(3);
    expect(seqOf(b)).toBe(seqOf(a) + 1);
    expect(seqOf(c)).toBe(seqOf(b) + 1);
    expect(a.startsWith(`GM-${today()}-`)).toBe(true);
  });

  test('the number is four digits, zero padded', () => {
    expect(generateOrderId()).toMatch(new RegExp(`^GM-${today()}-\\d{4}$`));
  });

  test('a reserved number is never reissued, even when its order is never created', () => {
    // The Zoho call rejected the order, or the request died. The number is
    // spent regardless — a gap in the sequence is fine, a duplicate is not.
    const abandoned = generateOrderId();
    const next = generateOrderId();
    expect(next).not.toBe(abandoned);
    expect(seqOf(next)).toBe(seqOf(abandoned) + 1);
  });

  test('each tier prefix counts independently', () => {
    const real = generateOrderId();
    process.env.ZOHO_DRY_RUN = 'true';
    const dry = generateOrderId();

    expect(real.startsWith('GM-')).toBe(true);
    expect(dry.startsWith(`DryGM-${today()}-`)).toBe(true);
    // Separate counters, so a dry run cannot burn real order numbers.
    delete process.env.ZOHO_DRY_RUN;
    expect(seqOf(generateOrderId())).toBe(seqOf(real) + 1);
  });

  test('picks up from orders already on the database rather than restarting at 0001', () => {
    // The case that matters on deploy day: an existing database has orders
    // for today but no counter row yet. Starting from zero would collide
    // with rows that already exist.
    process.env.ZOHO_TEST_CUSTOMER_ID = 'FIXTURE-CONTACT-1';
    const prefix = `TestGM-${today()}`;

    const customer = db.prepare('SELECT id FROM customers LIMIT 1').get();
    const medrep = db.prepare("SELECT id FROM users WHERE role = 'medrep' LIMIT 1").get();

    db.prepare('DELETE FROM order_id_sequences WHERE prefix = ?').run(prefix);
    const existing = db
      .prepare(
        `INSERT INTO orders (getmeds_order_id, customer_id, medrep_id, status, customer_type,
                             total_amount, delivery_address)
         VALUES (?, ?, ?, 'draft', 'direct', 100, '1 Seed St')`
      )
      .run(`${prefix}-0042`, customer.id, medrep.id).lastInsertRowid;
    createdOrderIds.push(existing);

    expect(generateOrderId()).toBe(`${prefix}-0043`);
  });
});
