/**
 * The Sales Performance sheet (Aaron sheet 13.6.6, Oct 20, 2026): pure rules, no database and no Zoho.
 *
 *  - rows are Zoho salespersons (territories), grouped Head > channel group > manager;
 *  - the four Rx channels show as RX BUSINESS (B2C as MD TELESALES), one block per manager;
 *  - a manager subtotal only when the group has more than one manager;
 *  - Achieved = invoices minus credit notes, found by Zoho name or alias, ignoring case, spacing and punctuation;
 *  - Today's invoicing only for the running month; Target only for the month it belongs to;
 *  - blank % (never #DIV/0!) with no target; vacant rows still count; totals at every level;
 *  - Zoho salespersons that match no territory are listed apart, and the two together equal Zoho's total.
 */
const { buildSalesPerformance, groupOf } = require('../src/services/salesPerformanceService');

const channels = [
  { id: 1, name: 'RX · B&B', head_name: 'Javed', sort_order: 1 },
  { id: 2, name: 'RX · STC', head_name: 'Javed', sort_order: 2 },
  { id: 3, name: 'RX · B2C', head_name: 'Javed', sort_order: 3 },
  { id: 4, name: 'B2B', head_name: 'Subir', sort_order: 4 },
  { id: 5, name: 'HOSP', head_name: 'Vanessa', sort_order: 5 },
  { id: 6, name: 'MT', head_name: 'Mhalou', sort_order: 6 }
];
const managers = [
  { id: 11, channel_id: 1, name: 'Honey', sort_order: 1 },
  { id: 12, channel_id: 2, name: 'Honey', sort_order: 1 },
  { id: 13, channel_id: 3, name: 'Honey', sort_order: 1 },
  { id: 14, channel_id: 4, name: 'Jessa Domino', sort_order: 1 },
  { id: 15, channel_id: 5, name: 'Jimlord', sort_order: 1 },
  { id: 16, channel_id: 5, name: 'Vanessa', sort_order: 2 },
  { id: 17, channel_id: 6, name: 'Mhalou', sort_order: 1 }
];
const T = (id, manager_id, zoho, extra = {}) => ({
  id, manager_id, zoho_salesperson: zoho, zoho_alias: null, person_label: zoho, hq: 'HQ', is_vacant: false,
  target_month: '2026-10', target_amount: 100000, sort_order: id, ...extra
});
const territories = [
  T(1, 11, 'B&B | EAST AVE', { sort_order: 2, target_amount: 1046328 }),
  T(2, 12, 'STC | NCL', { sort_order: 1, target_amount: 1353269 }),
  T(3, 11, 'B&B | VACANT ONE', { sort_order: 3, is_vacant: true, target_amount: 500000 }),
  T(4, 13, 'B2C | Rachelle Upao', { target_amount: 500000 }),
  T(5, 14, 'B2B | DHON', { zoho_alias: 'B2B | DHON VALLEJOS', target_amount: 500000 }),
  T(6, 15, 'HOS | PASAY', { target_amount: 600000 }),
  T(7, 16, 'HOS | TACLOBAN', { target_amount: 0 }),
  T(8, 17, 'MT | 1', { zoho_alias: 'MT - 1', target_amount: 500000 }),
  T(9, 14, 'B2B | OLD TARGET', { target_month: '2026-09', target_amount: 999 })
];
const inv = (salesperson, total, date = '2026-10-10') => ({ salesperson, total, date });
const zoho = {
  available: true, fetchedAt: '2026-10-20T08:00:00Z', total_sales_with_tax: 0,
  invoices: [
    inv('B&B | EAST AVE', 100000), inv('B&B | EAST AVE', 50000, '2026-10-20'),
    inv('STC | NCL', 68537, '2026-10-20'),
    inv('B2C | Rachelle Upao', 30000),
    inv('B2B | DHON VALLEJOS', 117600),
    inv('HOS | PASAY', 59851),
    inv('MT-1', 25000, '2026-10-20'),
    inv('TEST | Somebody', 7000)
  ],
  credit_notes: [{ salesperson: 'B&B | EAST AVE', total: 10000, date: '2026-10-20' }]
};
const run = (over = {}) => buildSalesPerformance({ month: '2026-10', today: '2026-10-20', zoho, channels, managers, territories, ...over });
const flat = (d) => d.heads.flatMap((h) => h.groups.flatMap((g) => g.managers.flatMap((m) => m.rows)));
const row = (d, name) => flat(d).find((r) => r.zoho_name === name);

describe('Sales Performance: layout', () => {
  const d = run();

  test('heads and blocks follow the channel order; the Rx channels become RX BUSINESS and B2C becomes MD TELESALES', () => {
    expect(d.heads.map((h) => h.head)).toEqual(['Javed', 'Subir', 'Vanessa', 'Mhalou']);
    expect(d.heads[0].groups.map((g) => g.label)).toEqual(['RX BUSINESS', 'MD TELESALES']);
    expect(d.heads[0].groups[0].total_label).toBe('PRESCRIPTION TOTAL');
    expect(d.heads[0].groups[1].total_label).toBe('PAP TOTAL');
    expect(groupOf('B2B')).toEqual({ label: 'B2B', total: 'B2B Total' });
  });

  test('RX BUSINESS is one manager block (Honey) even though three channels feed it, ordered by sort_order', () => {
    const rx = d.heads[0].groups[0];
    expect(rx.managers).toHaveLength(1);
    expect(rx.managers[0].subtotal).toBeNull();
    expect(rx.managers[0].rows.map((r) => r.zoho_name)).toEqual(['STC | NCL', 'B&B | EAST AVE', 'B&B | VACANT ONE']);
  });

  test('a manager subtotal appears only where a group has several managers (HOSP)', () => {
    const hosp = d.heads[2].groups[0];
    expect(hosp.managers.map((m) => m.manager)).toEqual(['Jimlord', 'Vanessa']);
    expect(hosp.managers.every((m) => m.subtotal)).toBe(true);
    expect(hosp.managers[0].subtotal.achieved_php).toBe(59851);
  });
});

describe('Sales Performance: the numbers', () => {
  const d = run();

  test('Achieved is invoices minus credit notes; Today is the same sum for today only', () => {
    const r = row(d, 'B&B | EAST AVE');
    expect(r.achieved_php).toBe(140000); // 100000 + 50000 - 10000
    expect(r.today_php).toBe(40000);     // 50000 - 10000
    expect(r.target_php).toBe(1046328);
    expect(r.balance_php).toBe(906328);
    expect(r.pct_of_target).toBe(13.4);
  });

  test('a territory is found by its alias, and by a spelling that differs only in punctuation', () => {
    expect(row(d, 'B2B | DHON').achieved_php).toBe(117600); // alias B2B | DHON VALLEJOS
    expect(row(d, 'MT | 1').achieved_php).toBe(25000);      // Zoho says MT-1, the alias says MT - 1
  });

  test('no target means a blank %, never a division by zero; a zero target is also blank', () => {
    const tac = row(d, 'HOS | TACLOBAN');
    expect(tac.pct_of_target).toBeNull();
    expect(tac.status).toBeNull();
    expect(row(d, 'B2B | OLD TARGET').target_php).toBeNull(); // its target belongs to September
    expect(row(d, 'B2B | OLD TARGET').balance_php).toBeNull();
  });

  test('vacant territories are flagged and still count in the totals', () => {
    expect(row(d, 'B&B | VACANT ONE').vacant).toBe(true);
    const rx = d.heads[0].groups[0].total;
    expect(rx.target_php).toBe(1353269 + 1046328 + 500000);
    expect(rx.rows).toBe(3);
  });

  test('totals add up at every level, and the balance is target minus achieved', () => {
    const sumOf = (rows, k) => Math.round(rows.reduce((a, r) => a + (r[k] || 0), 0) * 100) / 100;
    const rows = flat(d);
    expect(d.grand_total.achieved_php).toBe(sumOf(rows, 'achieved_php'));
    expect(d.grand_total.target_php).toBe(sumOf(rows, 'target_php'));
    expect(d.grand_total.balance_php).toBe(Math.round((d.grand_total.target_php - d.grand_total.achieved_php) * 100) / 100);
    expect(d.heads.reduce((a, h) => a + h.total.achieved_php, 0)).toBe(d.grand_total.achieved_php);
    expect(d.targets_missing).toBe(2); // Tacloban (0) and the September-only territory
  });

  test('Zoho salespersons that match no territory are listed apart, and together they equal the Zoho total', () => {
    expect(d.not_on_structure.rows).toEqual([{ salesperson: 'TEST | Somebody', achieved_php: 7000, today_php: 0 }]);
    const zohoTotal = zoho.invoices.reduce((a, i) => a + i.total, 0) - 10000;
    expect(d.reconciliation.together_php).toBe(zohoTotal);
  });
});

describe('Sales Performance: months and Zoho trouble', () => {
  test('a closed month has no Today column and a full pace; targets for another month do not carry over', () => {
    const d = run({ month: '2026-09', today: '2026-10-20' });
    expect(d.running).toBe(false);
    expect(d.pace).toBe(100);
    expect(flat(d).every((r) => r.today_php === null)).toBe(true);
    expect(row(d, 'B2B | OLD TARGET').target_php).toBe(999);
    expect(row(d, 'B&B | EAST AVE').target_php).toBeNull();
  });

  test('when Zoho cannot be read the structure and targets still show, with no money figures', () => {
    const d = run({ zoho: { available: false, error: 'Zoho is not set up here' } });
    expect(d.zoho_available).toBe(false);
    expect(d.zoho.error).toMatch(/not set up/);
    const r = row(d, 'B&B | EAST AVE');
    expect(r.achieved_php).toBeNull();
    expect(r.target_php).toBe(1046328);
    expect(d.reconciliation).toBeNull();
  });

  test('status compares the share of target with the share of the month that has passed', () => {
    const d = run(); // day 20 of 31 = 64.5% pace
    expect(row(d, 'STC | NCL').status).toBe('behind'); // 5% of target
    expect(row(d, 'B2C | Rachelle Upao').status).toBe('behind');
  });
});

describe('targets from people and vacant territories (Oct 24, 2026)', () => {
  const channels = [{ id: 1, name: 'HOSP', head_name: 'VANESSA', sort_order: 1 }];
  const managers = [{ id: 10, channel_id: 1, name: 'KEN', sort_order: 1 }];
  const territories = [
    { id: 100, manager_id: 10, zoho_salesperson: 'HOS | LAGUNA', person_label: 'HOS | CLARISSE', is_vacant: false, target_month: '2026-09', target_amount: 984707, sort_order: 1 },
    { id: 101, manager_id: 10, zoho_salesperson: 'HOS | BICOL', person_label: 'HOS | LALIEN', is_vacant: false, target_month: '2026-09', target_amount: 500000, sort_order: 2 },
    { id: 102, manager_id: 10, zoho_salesperson: 'HOS | CAVITE', person_label: 'HOS | LALIEN', is_vacant: false, target_month: '2026-09', target_amount: 300000, sort_order: 3 },
    { id: 103, manager_id: 10, zoho_salesperson: 'HOS | TACLOBAN', person_label: 'HOS | TACLOBAN VACANT', is_vacant: true, target_month: '2026-09', target_amount: 0, sort_order: 4 },
  ];
  const zoho = { available: true, invoices: [{ salesperson: 'HOS | LAGUNA', total: 100000, date: '2026-10-05' }], credit_notes: [] };
  const targets = {
    people: [{ user_id: 1, name: 'Clarisse', target_php: 900000 }, { user_id: 2, name: 'Lalien', target_php: 600000 }, { user_id: 3, name: 'Nobody Mapped', target_php: 50000 }],
    accounts: [{ user_id: 2, salesperson: 'HOS | LAGUNA', is_primary: false }, { user_id: 1, salesperson: 'HOS | LAGUNA', is_primary: true }, { user_id: 2, salesperson: 'HOS | CAVITE', is_primary: false }, { user_id: 2, salesperson: 'HOS | BICOL', is_primary: true }],
    territory: [{ territory_id: 103, label: 'HOS | TACLOBAN', target_php: 400000 }, { territory_id: null, label: 'URO | KALAW', target_php: 300000 }],
  };
  const rows = (r) => r.heads[0].groups[0].managers[0].rows;

  test('a held territory shows its holder\'s target once, on the primary; vacant shows its own', () => {
    const r = buildSalesPerformance({ month: '2026-10', today: '2026-10-24', zoho, channels, managers, territories, targets });
    const [laguna, bicol, cavite, tacloban] = rows(r);
    expect(laguna).toMatchObject({ target_php: 900000, achieved_php: 100000, target_covered_by: null }); // also Lalien's secondary
    expect(bicol).toMatchObject({ target_php: 600000, target_covered_by: null });
    expect(cavite).toMatchObject({ target_php: null, target_covered_by: 'Lalien (HOS | BICOL)' });
    expect(tacloban).toMatchObject({ target_php: 400000, vacant: true });
    expect(r.grand_total.target_php).toBe(1900000);
    expect(r.target_source).toBe('people');
    expect(r.targets_not_on_structure.rows).toEqual([{ person: 'URO | KALAW (vacant)', target_php: 300000 }, { person: 'Nobody Mapped', target_php: 50000 }]);
    // grand total + not on structure = every person target + every vacant target (the Overview's company target)
    expect(r.grand_total.target_php + r.targets_not_on_structure.total_php).toBe(900000 + 600000 + 50000 + 400000 + 300000);
    expect(r.targets_missing).toBe(0);
  });

  test('a month with no per-person targets keeps the sheet targets on the territories', () => {
    const r = buildSalesPerformance({ month: '2026-09', today: '2026-10-24', zoho, channels, managers, territories, targets: { people: [], accounts: targets.accounts, territory: [] } });
    expect(rows(r).map((x) => x.target_php)).toEqual([984707, 500000, 300000, 0]);
    expect(r.target_source).toBe('territory');
  });
});

describe('date range (Oct 24, 2026)', () => {
  const channels = [{ id: 1, name: 'HOSP', head_name: 'VANESSA', sort_order: 1 }];
  const managers = [{ id: 10, channel_id: 1, name: 'KEN', sort_order: 1 }];
  const territories = [{ id: 100, manager_id: 10, zoho_salesperson: 'HOS | LAGUNA', person_label: 'HOS | CLARISSE', is_vacant: false, sort_order: 1 }];
  const targets = { people: [{ user_id: 1, name: 'Clarisse', target_php: 1000000 }], accounts: [{ user_id: 1, salesperson: 'HOS | LAGUNA', is_primary: true }], territory: [] };
  // the controller reads Zoho for the range only; these are the range's invoices
  const zoho = { available: true, invoices: [{ salesperson: 'HOS | LAGUNA', total: 20000, date: '2026-10-20' }, { salesperson: 'HOS | LAGUNA', total: 5000, date: '2026-10-21' }], credit_notes: [] };

  test('one day: achieved is that day, the day column is that day, the month target stays', () => {
    const r = buildSalesPerformance({ month: '2026-10', today: '2026-10-24', zoho: { ...zoho, invoices: zoho.invoices.slice(1) }, channels, managers, territories, targets, range: { from: '2026-10-21', to: '2026-10-21' } });
    expect(r.grand_total).toMatchObject({ target_php: 1000000, achieved_php: 5000, today_php: 5000 });
    expect(r).toMatchObject({ today: '2026-10-21', multi_month: false });
  });

  test('a range across two months shows no target', () => {
    const r = buildSalesPerformance({ month: '2026-10', today: '2026-10-24', zoho, channels, managers, territories, targets, range: { from: '2026-09-28', to: '2026-10-21' } });
    expect(r.grand_total).toMatchObject({ target_php: 0, achieved_php: 25000, pct_of_target: null });
    expect(r.multi_month).toBe(true);
  });
});
