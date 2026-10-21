/**
 * KPI Scorecard: NZSD and HRR calculations (Oct 21, 2026). Plain rows, no database.
 *  - NZSD counts the invoice's creation day in Manila, Mon–Fri only, and lists zero-sales days;
 *  - HRR counts customers invoiced last month that were invoiced again this month, per salesperson;
 *  - the playbook's point bands.
 */
const { computeNzsd, computeHrr, computeDso, computeIst, _test } = require('../src/services/kpiScorecardService');

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

test('DSO: open AR over credit sales per day so far, aging buckets, Monday-call list', () => {
  const open = [
    { salesperson: 'HOS | A', date: '2026-10-10', balance: 30000 }, // 11 days old
    { salesperson: 'HOS | A', date: '2026-07-01', balance: 10000 }, // 112 days old -> 90+
    { salesperson: 'HOS | B', date: '2026-09-01', balance: 90000 }, // 50 days old
  ];
  const credit = [
    { salesperson: 'HOS | A', total: 21000 }, // 1,000 a day over 21 days
    { salesperson: 'HOS | B', total: 21000 },
  ];
  const r = computeDso(open, credit, '2026-10-21');
  const a = r.people.find((p) => p.salesperson === 'HOS | A');
  expect(a).toMatchObject({ open_ar: 40000, credit_sales: 21000, dso_days: 40, points: 20, bonus: true, aging: [30000, 0, 0, 10000], oldest_days: 112 });
  const b = r.people.find((p) => p.salesperson === 'HOS | B');
  expect(b).toMatchObject({ dso_days: 90, points: 0, aging: [0, 90000, 0, 0] });
  expect(r.total).toMatchObject({ open_ar: 130000, credit_sales: 42000, dso_days: 65 });
  expect(r.monday_call.map((m) => m.salesperson)).toEqual(['HOS | B']);
});

test('DSO with open AR but no credit sales this month cannot be divided, and is on the Monday list', () => {
  const r = computeDso([{ salesperson: 'HOS | C', date: '2026-08-01', balance: 5000 }], [], '2026-10-21');
  expect(r.people[0]).toMatchObject({ dso_days: null, points: 0 });
  expect(r.monday_call).toHaveLength(1);
});

test('DSO bands: up to 70 → 20, 71–89 → 10, 90 and above → 0', () => {
  expect([0, 59, 60, 70, 71, 89, 90, 200].map(_test.dsoPts)).toEqual([20, 20, 20, 20, 10, 10, 0, 0]);
});

test('IST: invoiced over target per person, projected to month end while the month runs, points and the cap', () => {
  const people = [
    { user_id: 1, name: 'A', target_php: 100000, sales_php: 50000 },   // day 15 of 30: 50% now, 100% projected -> 50
    { user_id: 2, name: 'B', target_php: 100000, sales_php: 20000 },   // 20% -> 40% projected -> 0, caps the month
    { user_id: 3, name: 'C', target_php: 0, sales_php: 5000 },         // no target: shown, not scored
  ];
  const r = computeIst(people, '2026-11', '2026-11-15');
  expect(r).toMatchObject({ running: true, days_so_far: 15, days_in_month: 30, pace_pct: 50 });
  expect(r.people.find((p) => p.name === 'A')).toMatchObject({ ist_now_pct: 50, ist_projected_pct: 100, points: 50, caps_month: false, balance_php: 50000 });
  expect(r.people.find((p) => p.name === 'B')).toMatchObject({ ist_projected_pct: 40, points: 0, caps_month: true });
  expect(r.people.find((p) => p.name === 'C')).toMatchObject({ ist_now_pct: null, points: null });
  expect(r.total).toMatchObject({ target_php: 200000, invoiced_php: 70000, ist_now_pct: 35, ist_projected_pct: 70, people_with_target: 2, at_zero: 1, at_full: 1 });
  // a closed month is scored on the actual figure
  expect(computeIst(people, '2026-09', '2026-10-21').people.find((p) => p.name === 'A')).toMatchObject({ ist_projected_pct: 50, points: 0 });
});

test('IST bands: above 90 → 50, 81–90 → 40, 71–80 → 30, 61–70 → 20, 60 and below → 0', () => {
  expect([150, 91, 90, 81, 80, 71, 70, 61, 60, 0].map(_test.istPts)).toEqual([50, 50, 40, 40, 30, 30, 20, 20, 0, 0]);
});
