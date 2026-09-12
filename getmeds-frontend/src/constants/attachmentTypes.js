/**
 * The kinds of file an order can carry.
 *
 * Sep 12, 2026. One list, because there were three and they had drifted:
 * OrderForm offered all six, PaymentProofPanel knew only three, so a
 * Guarantee Letter uploaded on the order form came back labelled "Other
 * attachment" everywhere it was read. A document Finance is meant to check
 * against a hospital's paperwork should not be described to them as "other".
 *
 * Mirrors FILE_TYPES in the backend's paymentProof.controller.js and the CHECK
 * constraint in schema.pg.sql. A value here that those reject fails at upload;
 * a value they accept that is missing here renders with the fallback label.
 */
export const ATTACHMENT_TYPES = [
  { value: 'payment_proof',  label: 'Proof of Payment' },
  { value: 'gl',             label: 'Guarantee Letter (GL)' },
  { value: 'prescription',   label: 'Prescription' },
  { value: 'id',             label: 'Valid ID' },
  { value: 'purchase_order', label: 'Purchase Order' },
  { value: 'other',          label: 'Other' },
];

/** Falls back rather than throwing: an unknown type is still a real file. */
export const attachmentLabel = (fileType) =>
  (ATTACHMENT_TYPES.find((t) => t.value === fileType) || {}).label || 'Other attachment';

/**
 * The four a hospital (PAP/DSWD) order cannot be submitted without. Kept here
 * beside the list so the two cannot disagree about what a GL is called.
 */
export const HOSPITAL_REQUIRED_TYPES = ['gl', 'prescription', 'payment_proof', 'id'];
