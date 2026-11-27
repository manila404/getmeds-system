'use strict';

/**
 * Nov 27, 2026: what a hold says needs fixing — Finance ticks them when
 * holding ("Delivery address", "Missing: Purchase Order", …). Stored on the
 * hold event (metadata.hold_items) and shown to the MedRep as a checklist in
 * the order's Conversation, each with its own fix.
 *
 * A field item's key is the request field PATCH /api/orders/:id/details
 * takes, so the MedRep may edit exactly that field on an order already in
 * Zoho while the hold is open (orders.controller.js updateDetails).
 *   prices              explained / fixed by Management, not editable by the MedRep
 *   attachment:<type>   a missing document of that type
 */
const FIELD_KEYS = [
  'delivery_address', 'receiver_name', 'receiver_contact_no', 'delivery_method',
  'payment_terms', 'doctor_name', 'customer_tin', 'gl_number', 'expected_shipment_date', 'delivery_notes',
];
const ATTACHMENT_TYPES = ['payment_proof', 'gl', 'prescription', 'id', 'purchase_order', 'other'];

function cleanHoldItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const it of raw.slice(0, 15)) {
    const key = String((it && it.key) || it || '').trim();
    const ok = FIELD_KEYS.includes(key) || key === 'prices'
      || (key.startsWith('attachment:') && ATTACHMENT_TYPES.includes(key.slice(11)));
    if (!ok || seen.has(key)) continue;
    seen.add(key);
    const note = String((it && it.note) || '').trim().slice(0, 200);
    out.push(note ? { key, note } : { key });
  }
  return out;
}

/**
 * The request fields a MedRep may still edit on an order already in Zoho:
 * those flagged on its latest, still-open hold. Empty when not on hold.
 */
async function flaggedEditableFields(db, order) {
  if (!order || !['on_hold', 'exception'].includes(order.status)) return new Set();
  const ev = await db.prepare(`
    SELECT metadata FROM order_events
     WHERE order_id = ? AND event_type IN ('FINANCE_REJECTED', 'EXCEPTION_SET')
     ORDER BY id DESC LIMIT 1
  `).get(order.id);
  let meta = ev && ev.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  const items = (meta && Array.isArray(meta.hold_items)) ? meta.hold_items : [];
  return new Set(items.map((i) => i.key).filter((k) => FIELD_KEYS.includes(k)));
}

module.exports = { FIELD_KEYS, ATTACHMENT_TYPES, cleanHoldItems, flaggedEditableFields };
