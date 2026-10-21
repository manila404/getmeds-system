/**
 * KPI Scorecard: NZSD and HRR calculations (Oct 21, 2026). Plain rows, no database.
 *  - NZSD counts the invoice's creation day in Manila, Mon–Fri only, and lists zero-sales days;
 *  - HRR counts customers invoiced last month that were invoiced again this month, per salesperson;
 *  - the playbook's point bands.
 */
const { computeNzsd, computeHrr, _test } = require('../src/services/kpiScorecardService');

test('working days are Monday to Friday, up to today in the running month', () => {
  // Oct 2026: the 1st is a Thursday
  expect(_test.workingDays('2026-10', '2026-10-06')).toEqual(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']);
  expect(_test.workingDays('2026-10')).toHaveLength(22);
});

test('the creation day is read in Manila time', () => {
  expect(_test.manilaDay('2026-10-05T23:30:00+0800')).toBe('2026-10-05');
  expect(_test.manilaDay('2026-10-05T17:30:00+0000')).toBe('2026-10-06'); // 1:30 AM the next day in Manila
});

test('NZSD: days with an invoice over working days, zero days listed, weekend sales not scored', () => {
  const rows = [
    { salesperson: 'HOS | A', created_time: '2026-10-01T09:00:00+0800' },
    { salesperson: 'HOS | A', created_time: '2026-10-01T15:00:00+0800' }, // same day counts once
    { salesperson: 'HOS | A', created_time: '2026-10-02T10:00:00+0800' },
    { salesperson: 'HOS | A', created_time: '2026-10-03T10:00:00+0800' }, // Saturday
    { salesperson: 'HOS | B', created_time: '2026-10-06T10:00:00+0800' },
  ];
  const r = computeNzsd(rows, '2026-10', { today: '2026-10-06' });
  expect(r.working_days).toHaveLength(4);
  const a = r.people.find((p) => p.salesperson === 'HOS | A');
  expect(a).toMatchObject({ days_with_sales: 2, nzsd_pct: 50, points: 0, zero_days: ['2026-10-05', '2026-10-06'], weekend_sales_days: ['2026-10-03'] });
  const b = r.people.find((p) => p.salesperson === 'HOS | B');
  expect(b).toMatchObject({ days_with_sales: 1, nzsd_pct: 25 });
});

test('NZSD bands: 95 → 15, 90 → 12, 80 → 9, 70 → 6, below → 0', () => {
  expect([100, 95, 94.9, 90, 85, 80, 75, 70, 69.9].map(_test.nzsdPts)).toEqual([15, 15, 12, 12, 9, 9, 6, 6, 0]);
});

test('HRR: customers kept per salesperson, the lapsed list biggest first, and the total', () => {
  const last = [
    { salesperson: 'HOS | A', customer_id: 'c1', customer_name: 'One', total: 100 },
    { salesperson: 'HOS | A', customer_id: 'c1', customer_name: 'One', total: 50 },
    { salesperson: 'HOS | A', customer_id: 'c2', customer_name: 'Two', total: 900 },
    { salesperson: 'HOS | A', customer_id: 'c3', customer_name: 'Three', total: 10 },
    { salesperson: 'HOS | B', customer_id: 'c4', customer_name: 'Four', total: 40 },
  ];
  const current = [
    { salesperson: 'HOS | A', customer_id: 'c1', customer_name: 'One', total: 70 },
    { salesperson: 'HOS | A', customer_id: 'c9', customer_name: 'New', total: 70 }, // new customer: not part of HRR
    { salesperson: 'HOS | B', customer_id: 'c4', customer_name: 'Four', total: 40 },
  ];
  const r = computeHrr(last, current, '2026-10');
  expect(r.previous_month).toBe('2026-09');
  expect(r.people.find((p) => p.salesperson === 'HOS | A')).toMatchObject({ last_month_customers: 3, kept: 1, lapsed: 2, hrr_pct: 33.3, points: 0 });
  expect(r.people.find((p) => p.salesperson === 'HOS | B')).toMatchObject({ kept: 1, hrr_pct: 100, points: 15 });
  expect(r.total).toEqual({ last_month_customers: 4, kept: 2, hrr_pct: 50 });
  expect(r.lapsed.map((l) => [l.customer, l.last_month_sales])).toEqual([['Two', 900], ['Three', 10]]);
});

test('HRR bands: 95 → 15, 85 → 12, 75 → 8, below → 0', () => {
  expect([100, 95, 94.9, 85, 84.9, 75, 74.9].map(_test.hrrPts)).toEqual([15, 15, 12, 12, 8, 8, 0]);
});
