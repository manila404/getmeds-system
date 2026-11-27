import { ATTACHMENT_TYPES } from './attachmentTypes';

/**
 * Nov 27, 2026: what a hold can say needs fixing (backend services/holdItems.js).
 * Finance ticks them when holding; the MedRep sees them as a checklist in the
 * order's Conversation, each with its own fix.
 *
 *   key       the field PATCH /api/orders/:id/details takes
 *   orderKey  where the current value is on the order
 */
export const HOLD_FIELDS = [
  { key: 'delivery_address', label: 'Delivery address', orderKey: 'delivery_address', multiline: true },
  { key: 'receiver_name', label: 'Receiver', orderKey: 'intake_receiver' },
  { key: 'receiver_contact_no', label: 'Contact no.', orderKey: 'intake_contact_no' },
  { key: 'delivery_method', label: 'Delivery method', orderKey: 'intake_delivery_method' },
  { key: 'payment_terms', label: 'Payment terms', orderKey: 'intake_payment_terms' },
  { key: 'doctor_name', label: 'Doctor', orderKey: 'intake_doctor' },
  { key: 'customer_tin', label: 'TIN', orderKey: 'intake_tin' },
  { key: 'gl_number', label: 'GL number', orderKey: 'intake_gl_number' },
  { key: 'expected_shipment_date', label: 'Expected shipment', orderKey: 'intake_expected_shipment_date', type: 'date' },
  { key: 'delivery_notes', label: 'Delivery notes', orderKey: 'delivery_notes', multiline: true },
];

export const HOLD_OTHER = [{ key: 'prices', label: 'Prices / total' }];

export const HOLD_ATTACHMENTS = ATTACHMENT_TYPES.map((t) => ({ key: `attachment:${t.value}`, label: t.label, type: t.value }));

export function holdItemLabel(key) {
  const f = HOLD_FIELDS.find((x) => x.key === key) || HOLD_OTHER.find((x) => x.key === key);
  if (f) return f.label;
  const a = HOLD_ATTACHMENTS.find((x) => x.key === key);
  return a ? `Missing: ${a.label}` : key;
}
