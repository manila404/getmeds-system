/**
 * Nov 27, 2026: the name an uploaded attachment gets, so it is easy to trace
 * back — in the hub and on the Zoho Sales Order alike:
 *
 *   Proof of Payment   proof_of_payment_GM-20261127-0001.jpeg
 *   Guarantee Letter   guarantee_letter_GM-20261127-0001.pdf
 *   Other              <what the MedRep calls it>_GM-…   e.g. BIR_2303_GM-20261127-0001.png
 *
 * Only the name changes; the file and its extension stay as they are.
 * The reference is always the GM order number (Aaron, Nov 27): the same name
 * in the hub and in Zoho, whether or not the Sales Order exists yet.
 * Two files of the same kind in one upload: …-1.jpeg, …-2.jpeg.
 */
export const TYPE_NAME = {
  payment_proof: 'proof_of_payment',
  gl: 'guarantee_letter',
  prescription: 'prescription',
  id: 'valid_id',
  purchase_order: 'purchase_order',
};

/** A typed name made safe for a file name: "BIR 2303 (2024)" -> "BIR_2303_2024". */
export const cleanFileBase = (s) => String(s || '').trim()
  .replace(/\.[A-Za-z0-9]{1,5}$/, '')
  .replace(/[^A-Za-z0-9-]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 60);

export function orderRef(order) {
  return String((order && (order.getmeds_order_id || order.id)) || '').replace(/[^A-Za-z0-9-]/g, '');
}

/**
 * @param file      the picked File
 * @param fileType  payment_proof | gl | prescription | id | purchase_order | other
 * @param ref       orderRef(order)
 * @param opts.customName  what the person typed (used for 'other')
 * @param opts.n           1-based number when several of the same kind go up together
 * @param opts.prefix      e.g. 'NEW-' for a file sent again to fix a hold
 */
export function attachmentName(file, fileType, ref, { customName = '', n = 0, prefix = '' } = {}) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : '';
  const base = fileType === 'other'
    ? (cleanFileBase(customName) || cleanFileBase(file.name) || 'attachment')
    : (TYPE_NAME[fileType] || cleanFileBase(fileType) || 'attachment');
  return `${prefix}${base}${ref ? `_${ref}` : ''}${n ? `-${n}` : ''}${ext}`;
}

/** The same File under a new name. */
export const withName = (file, name) => new File([file], name, { type: file.type, lastModified: file.lastModified });

/** Numbers files only when the same final name would repeat in one upload. */
export function numberDuplicates(list) {
  const counts = {};
  for (const x of list) counts[x.key] = (counts[x.key] || 0) + 1;
  const seen = {};
  return list.map((x) => {
    if (counts[x.key] < 2) return 0;
    seen[x.key] = (seen[x.key] || 0) + 1;
    return seen[x.key];
  });
}
