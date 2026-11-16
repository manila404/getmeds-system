// Nov 16, 2026 (Aaron): a sub-division added on User Management is a channel "<Division> · <Sub>";
// it maps to its Division's order divisions, so its approver still counts in Manager Access.
jest.mock('../src/db/database', () => ({ prepare: jest.fn() }));
const { divisionsOfChannel } = require('../src/services/managerAccessSyncService');

describe('divisionsOfChannel', () => {
  test('existing channels keep their mapping', () => {
    expect(divisionsOfChannel('B2B')).toEqual(['B2B']);
    expect(divisionsOfChannel('RX · STC')).toEqual(['STC']);
    expect(divisionsOfChannel('HOSP')).toEqual(['HOS']);
    expect(divisionsOfChannel('MT')).toEqual(['MT']);
  });
  test('a new sub-division maps like its Division', () => {
    expect(divisionsOfChannel('B2B · NBD')).toEqual(['B2B']);
    expect(divisionsOfChannel('B2B · CRR')).toEqual(['B2B']);
    expect(divisionsOfChannel('HOS · Field Representatives')).toEqual(['HOS']);
    expect(divisionsOfChannel('CLIDP · North')).toEqual(['CLIDP']);
  });
  test('unknown channels map to nothing', () => {
    expect(divisionsOfChannel('Online')).toEqual([]);
    expect(divisionsOfChannel('PAP · DSWD')).toEqual([]);
  });
});
