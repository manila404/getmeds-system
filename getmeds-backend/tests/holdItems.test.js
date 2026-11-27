/**
 * Nov 27, 2026 — a hold that names what to fix (services/holdItems.js).
 */
const { cleanHoldItems, flaggedEditableFields } = require('../src/services/holdItems');

const dbWith = (metadata) => ({ prepare: () => ({ get: async () => (metadata === undefined ? null : { metadata: JSON.stringify(metadata) }) }) });

describe('cleanHoldItems', () => {
  it('keeps known fields, prices and missing-document types; drops anything else and duplicates', () => {
    expect(cleanHoldItems([
      { key: 'delivery_address', note: ' wrong barangay ' },
      'attachment:purchase_order',
      { key: 'prices' },
      { key: 'delivery_address' },
      { key: 'zoho_so_id' },
      'attachment:bogus',
    ])).toEqual([
      { key: 'delivery_address', note: 'wrong barangay' },
      { key: 'attachment:purchase_order' },
      { key: 'prices' },
    ]);
  });

  it('anything that is not a list is no items', () => {
    expect(cleanHoldItems(undefined)).toEqual([]);
    expect(cleanHoldItems('delivery_address')).toEqual([]);
  });
});

describe('flaggedEditableFields — what the MedRep may edit on an order already in Zoho', () => {
  const held = { id: 1, status: 'on_hold' };

  it('only the flagged FIELDS of the latest hold, while it is on hold', async () => {
    const f = await flaggedEditableFields(dbWith({ hold_items: [{ key: 'delivery_address' }, { key: 'attachment:gl' }, { key: 'prices' }] }), held);
    expect([...f]).toEqual(['delivery_address']);
  });

  it('nothing once the order is no longer on hold', async () => {
    const f = await flaggedEditableFields(dbWith({ hold_items: [{ key: 'delivery_address' }] }), { id: 1, status: 'ready_for_finance_verified' });
    expect(f.size).toBe(0);
  });

  it('nothing for a hold without items', async () => {
    expect((await flaggedEditableFields(dbWith({ reason: 'x' }), held)).size).toBe(0);
    expect((await flaggedEditableFields(dbWith(undefined), held)).size).toBe(0);
  });
});
