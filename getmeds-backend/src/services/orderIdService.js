const db = require('../db/database');
const { isDryRunMode, getTestCustomerZohoId } = require('./zohoTestFlags');

/**
 * Generates a unique Getmeds Order ID. Three tiers, most-restrictive-wins
 * (see zohoTestFlags.js for the full explanation of each flag):
 *  1. ZOHO_DRY_RUN=true            -> DryGM-YYYYMMDD-XXXX (nothing ever
 *     reaches Zoho for this order — checked first, highest priority)
 *  2. ZOHO_TEST_CUSTOMER_ID set    -> TestGM-YYYYMMDD-XXXX (a real Zoho
 *     write, but only for the one designated TEST customer)
 *  3. Neither set                  -> GM-YYYYMMDD-XXXX (normal)
 * This id becomes the Sales Order's reference_number and flows into its
 * notes (see LiveZohoAdapter / MockZohoAdapter createSalesOrder, which
 * prepend "TEST — DO NOT FULFILL" to the notes for a TestGM- id). Turning
 * a flag off drops new orders to the next tier down automatically — no
 * separate switch to remember to flip back.
 *
 * Sep 2, 2026 (2): the number now comes from an atomic counter row rather
 * than from `SELECT MAX(...) FROM orders`.
 *
 * The old version read the highest existing id and added one. Both callers
 * in orders.controller.js then do this, and the comments there explain why:
 *
 *     const getmedsOrderId = generateOrderId();   // read
 *     await zoho.createSalesOrder(zohoPayload);   // a live HTTP round-trip
 *     db.transaction(() => { INSERT INTO orders ... })();   // write
 *
 * The Zoho call has to happen outside the transaction because better-sqlite3
 * transactions cannot contain an `await`. That is sound, but it leaves one
 * to three seconds between reading the last number and writing the new row —
 * and two MedReps submitting inside that window both read the same maximum
 * and both get the same id. Both then create a REAL Sales Order in Zoho with
 * the same reference_number; the first INSERT wins and the second fails on
 * `getmeds_order_id TEXT UNIQUE`, leaving a real Zoho Sales Order that no
 * local order refers to, and a MedRep looking at an error.
 *
 * Reserving the number in its own committed transaction closes that window:
 * whoever gets there first owns it, and the counter has already moved on
 * before the Zoho call starts. Numbers are consumed, not reused — if the
 * order later fails to insert, its number is simply skipped. Gaps in a
 * sequence are normal and harmless; duplicates are not.
 *
 * This does NOT make the whole create path atomic. A local insert that fails
 * after Zoho accepted the order still leaves an orphaned Sales Order, which
 * is what zohoRetryService and the reconcile pass exist to surface. It
 * removes the one cause that two ordinary users could trigger just by
 * working at the same time.
 */

/** Reserve and return the next number for `prefixKey`, atomically. */
const nextSequence = db.transaction(async prefixKey => {
  let row = await db.prepare('SELECT seq FROM order_id_sequences WHERE prefix = ?').get(prefixKey);

  if (!row) {
    // First order under this prefix on this database. Seed from whatever is
    // already in `orders` rather than from zero — a database that predates
    // this table, or a day already in progress when the app restarts, must
    // not restart numbering at 0001 and collide with rows that exist.
    const last = await db
      .prepare(
        `SELECT getmeds_order_id FROM orders WHERE getmeds_order_id LIKE ?
          ORDER BY getmeds_order_id DESC LIMIT 1`
      )
      .get(`${prefixKey}-%`);
    const start = last ? parseInt(last.getmeds_order_id.split('-')[2], 10) || 0 : 0;
    await db.prepare('INSERT INTO order_id_sequences (prefix, seq) VALUES (?, ?)').run(prefixKey, start);
    row = { seq: start };
  }

  const next = row.seq + 1;
  await db.prepare('UPDATE order_id_sequences SET seq = ?, updated_at = ? WHERE prefix = ?').run(
    next,
    new Date().toISOString(),
    prefixKey
  );
  return next;
});

async function generateOrderId() {
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const tierPrefix = isDryRunMode() ? 'DryGM' : (getTestCustomerZohoId() ? 'TestGM' : 'GM');
  const prefixKey = `${tierPrefix}-${yyyymmdd}`;

  const seq = await nextSequence(prefixKey);
  return `${prefixKey}-${seq.toString().padStart(4, '0')}`;
}

module.exports = { generateOrderId };
