/**
 * Oct 30, 2026: an order's Division follows the Zoho Salesperson picked on it.
 * Nicka holds "CLIDP | NICKA" (primary) and "MT | 1"; her MT | 1 orders went to Zoho
 * as Division CLIDP. See services/salespersonDivision.js.
 */
const { divisionForSalesperson, salespersonPrefix } = require('../src/services/salespersonDivision');

const DIVISIONS = ['B&B', 'B2B', 'B2C', 'BID', 'CLIDP', 'HOS', 'MSA', 'STC', 'TeleSales Anesthesia', 'URO', 'TeleSales', 'MD Telesales', 'PS', 'MT'];
const div = (salesperson, primarySalesperson, accountDivision) =>
  divisionForSalesperson({ salesperson, primarySalesperson, accountDivision, divisions: DIVISIONS });

describe('divisionForSalesperson', () => {
  test('Nicka: MT | 1 is an MT order; her primary stays CLIDP', () => {
    expect(div('MT | 1', 'CLIDP | NICKA', 'CLIDP')).toBe('MT');
    expect(div('CLIDP | NICKA', 'CLIDP | NICKA', 'CLIDP')).toBe('CLIDP');
  });

  test('no name picked keeps the account Division', () => {
    expect(div('', 'CLIDP | NICKA', 'CLIDP')).toBe('CLIDP');
    expect(div(null, null, 'HOS')).toBe('HOS');
  });

  test('the primary keeps the account Division even when its prefix differs (Sheena: HOS account, TeleSales name)', () => {
    expect(div('TeleSales | Seena', 'TeleSales | Seena', 'HOS')).toBe('HOS');
  });

  test('a name in the account family keeps the account value (TeleSales | AILA on TeleSales Anesthesia)', () => {
    expect(div('TeleSales | AILA', 'TeleSales | Aila Jane Zaragosa', 'TeleSales Anesthesia')).toBe('TeleSales Anesthesia');
  });

  test('an unknown prefix or no separator keeps the account Division', () => {
    expect(div('HOSP | X', 'CLIDP | NICKA', 'CLIDP')).toBe('CLIDP');
    expect(div('Juan dela Cruz', 'CLIDP | NICKA', 'CLIDP')).toBe('CLIDP');
  });

  test('case and spacing do not matter', () => {
    expect(div('mt|1', 'CLIDP | NICKA', 'CLIDP')).toBe('MT');
    expect(div('BID | Reynan Cuenca', 'x', null)).toBe('BID');
  });

  test('salespersonPrefix reads both separators', () => {
    expect(salespersonPrefix('MT | 1')).toBe('MT');
    expect(salespersonPrefix('MD Telesales l Juan')).toBe('MD Telesales');
    expect(salespersonPrefix('B&B | EAST AVE')).toBe('B&B');
    expect(salespersonPrefix('nothing')).toBe('');
  });
});
