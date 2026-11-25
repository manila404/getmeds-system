const {
  filterAndSortBatchesForWarehouse,
  supplyFallbackBatches,
  suggestFefoPicks
} = require('../src/services/dispatchBatchService');

// Nov 25, 2026: the real Zoho record for "Packaging : Cake Roll with Cover-Styro" —
// one batch "NA", no expiry, stocked in the main GPI warehouse only.
const PACKAGING_BATCHES = [{
  batch_id: '2254168001988509398',
  batch_in_id: '2254168001988509443',
  batch_number: 'NA',
  balance_quantity: 407,
  warehouse_id: '',
  status: 'active',
  associated_warehouses: [{ warehouse_id: 'GPI_MAIN', balance_quantity: 407 }]
}];

describe('packaging batch from another warehouse (GM-20261124-0047, SO-70474)', () => {
  it('the Davao warehouse itself has no packaging batch', () => {
    expect(filterAndSortBatchesForWarehouse(PACKAGING_BATCHES, 'DAVAO')).toHaveLength(0);
  });

  it('falls back to the warehouse that holds it, and auto-picks it', () => {
    const fallback = supplyFallbackBatches(PACKAGING_BATCHES);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ batch_number: 'NA', warehouse_id: 'GPI_MAIN', available_quantity: 407, other_warehouse: true });
    const fefo = suggestFefoPicks(fallback, 1);
    expect(fefo.unallocated_quantity).toBe(0);
    expect(fefo.picks[0]).toMatchObject({ batch_number: 'NA', warehouse_id: 'GPI_MAIN', quantity: 1 });
  });

  it('skips warehouses with no stock and inactive batches', () => {
    const batches = [
      { ...PACKAGING_BATCHES[0], associated_warehouses: [{ warehouse_id: 'A', balance_quantity: 0 }, { warehouse_id: 'B', balance_quantity: 5 }] },
      { ...PACKAGING_BATCHES[0], batch_number: 'OLD', status: 'inactive' }
    ];
    const fallback = supplyFallbackBatches(batches);
    expect(fallback.map((b) => [b.batch_number, b.warehouse_id])).toEqual([['NA', 'B']]);
  });
});
