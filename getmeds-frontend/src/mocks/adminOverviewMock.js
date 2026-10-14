/**
 * MOCK DATA for the Admin Overview page (pages/admin/AdminOverviewMockPage.jsx).
 *
 * Oct 14, 2026: built to try the new Admin Overview layout before wiring it to
 * real data. Everything here is made up and fixed in the file. Nothing reads
 * the database, the API or Zoho, and nothing is ever written anywhere.
 *
 * The page is only reachable when VITE_ADMIN_OVERVIEW_MOCK=true (see App.jsx).
 * If the design is not approved, delete this file, the page, and the two
 * marked lines in App.jsx and Sidebar.jsx.
 */

// ── Period ────────────────────────────────────────────────────────────────
export const PERIOD = { start: '2026-09-15', end: '2026-10-01', label: 'Sep 15 – Oct 1, 2026' };
export const TODAY = '2026-10-01';
export const ADMIN_NAME = 'Aaron';

// Monthly booked-sales target the "x% of target" figure is measured against.
export const MONTHLY_TARGET_PHP = 17_885_000;

// Daily sales (all orders raised, pending included). Sums to ₱1,774,635.00.
const DAILY = [
  ['2026-09-15', 2, 61_200], ['2026-09-16', 1, 36_480], ['2026-09-17', 3, 206_950],
  ['2026-09-18', 2, 14_300], ['2026-09-19', 2, 76_820], ['2026-09-20', 3, 288_400],
  ['2026-09-21', 2, 52_640], ['2026-09-22', 2, 8_150],  ['2026-09-23', 2, 77_910],
  ['2026-09-24', 2, 51_720], ['2026-09-25', 3, 104_385], ['2026-09-26', 1, 33_670],
  ['2026-09-27', 2, 46_910], ['2026-09-28', 3, 188_460], ['2026-09-29', 2, 44_120],
  ['2026-09-30', 4, 86_520], ['2026-10-01', 11, 396_000],
];
// Orders still waiting for Management approval are not "booked". Their total is
// fixed so Booked Sales reads ₱1,430,817.50 (= ₱1,774,635.00 − ₱343,817.50).
const PENDING_TOTAL = 343_817.5;

const CUSTOMERS = [
  'Sample Medical Center', 'Northpoint Hospital', 'Bayview Clinic', 'Riverside Pharmacy',
  'Greenhill Diagnostics', 'Lakeside Drugstore', 'Metro Care Hospital', 'Sunrise Polyclinic',
  'Harbor Health Pharmacy', 'Valley Doctors Hospital', 'Eastgate Wellness', 'Hilltop Pharmacy',
];
const PEOPLE = [
  { name: 'MedRep Ana (mock)', team: 'Team North', channel: 'Hospital' },
  { name: 'MedRep Ben (mock)', team: 'Team North', channel: 'Hospital' },
  { name: 'MedRep Carla (mock)', team: 'Team South', channel: 'B2B' },
  { name: 'MedRep Dino (mock)', team: 'Team South', channel: 'B2B' },
  { name: 'MedRep Ella (mock)', team: 'Team Metro', channel: 'Pharmacy' },
  { name: 'MedRep Fritz (mock)', team: 'Team Metro', channel: 'Pharmacy' },
  { name: 'Telesales Gia (mock)', team: 'Team Telesales', channel: 'Telesales' },
];
const STATUSES = ['Delivered', 'Dispatched', 'Finance verified', 'Approved', 'Pending approval'];

// Deterministic "random" so the page looks the same on every load.
function seeded(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

function buildOrders() {
  const rnd = seeded(7);
  const orders = [];
  let n = 1041;
  DAILY.forEach(([date, count, total]) => {
    // Split the day's total into `count` amounts that add up exactly.
    const weights = Array.from({ length: count }, () => 0.4 + rnd());
    const sumW = weights.reduce((a, b) => a + b, 0);
    let left = total;
    weights.forEach((w, i) => {
      const amount = i === count - 1 ? left : Math.round((total * w) / sumW);
      left -= amount;
      const person = PEOPLE[Math.floor(rnd() * PEOPLE.length)];
      let status;
      status = STATUSES[Math.min(3, Math.floor(rnd() * 4))];
      orders.push({
        id: `SO-MOCK-${n++}`,
        date,
        customer: CUSTOMERS[Math.floor(rnd() * CUSTOMERS.length)],
        salesperson: person.name,
        team: person.team,
        channel: person.channel,
        amount,
        status,
      });
    });
  });
  // Still pending approval: today's last 6 orders, plus the last order of
  // Sep 29 and Sep 30.
  const pending = [
    ...orders.filter((o) => o.date === TODAY).slice(-6),
    orders.filter((o) => o.date === '2026-09-29').slice(-1)[0],
    orders.filter((o) => o.date === '2026-09-30').slice(-1)[0],
  ];
  pending.forEach((o) => { o.status = 'Pending approval'; });
  // Move value from today's booked orders to today's first pending order so the
  // pending total is exact. Each day's total stays the same.
  let shift = PENDING_TOTAL - pending.reduce((a, o) => a + o.amount, 0);
  const bookedToday = orders.filter((o) => o.date === TODAY && o.status !== 'Pending approval');
  for (const o of bookedToday) {
    const take = Math.min(shift, o.amount - 8_000);
    if (take <= 0) continue;
    o.amount -= take; pending[0].amount += take; shift -= take;
    if (shift <= 0) break;
  }
  return orders;
}

export const ORDERS = buildOrders();

export const DAILY_SALES = DAILY.map(([date]) => {
  const dayOrders = ORDERS.filter((o) => o.date === date);
  return { date, orders: dayOrders.length, total: dayOrders.reduce((a, o) => a + o.amount, 0) };
});

// Booked = everything that has passed Management approval.
export const isBooked = (o) => o.status !== 'Pending approval';

// ── KPIs (24 in 6 groups; 13 on target) ──────────────────────────────────
// status: 'on' | 'risk' | 'behind'
export const KPI_GROUPS = [
  {
    key: 'sales', label: 'Sales', owner: 'Sales Heads',
    kpis: [
      { name: 'Booked sales vs monthly target', actual: '8%', target: '≥ 50% by mid-month', status: 'behind' },
      { name: 'New customers this month', actual: '9', target: '≥ 8', status: 'on' },
      { name: 'Reps with zero sales (No Zero Sales Rule)', actual: '2', target: '0', status: 'behind' },
      { name: 'Average order value', actual: '₱37,758', target: '≥ ₱30,000', status: 'on' },
      { name: 'Orders with complete payment proof', actual: '81%', target: '≥ 90%', status: 'risk' },
    ],
  },
  {
    key: 'management', label: 'Management', owner: 'Management',
    kpis: [
      { name: 'Approval turnaround', actual: '2.6 h', target: '≤ 4 h', status: 'on' },
      { name: 'Drafts cleared within 48 h', actual: '96%', target: '≥ 90%', status: 'on' },
      { name: 'Exceptions resolved same week', actual: '100%', target: '≥ 95%', status: 'on' },
    ],
  },
  {
    key: 'finance', label: 'Finance', owner: 'Finance',
    kpis: [
      { name: 'Payment verification within 24 h', actual: '93%', target: '≥ 90%', status: 'on' },
      { name: 'DSO', actual: '41 days', target: '≤ 45 days', status: 'on' },
      { name: 'Refunds closed within 7 days', actual: '3 of 3', target: '100%', status: 'on' },
      { name: 'AR over 90 days', actual: '6.4%', target: '≤ 5%', status: 'risk' },
    ],
  },
  {
    key: 'operations', label: 'Operations', owner: 'Dispatch & Pharmacy',
    kpis: [
      { name: 'Same-day dispatch', actual: '88%', target: '≥ 85%', status: 'on' },
      { name: 'Delivery confirmed within 48 h', actual: '94%', target: '≥ 90%', status: 'on' },
      { name: 'Prescription requests resolved', actual: '100%', target: '≥ 95%', status: 'on' },
      { name: 'Stock holds cleared within 3 days', actual: '91%', target: '≥ 85%', status: 'on' },
      { name: 'Wrong-item returns', actual: '3', target: '0', status: 'behind' },
    ],
  },
  {
    key: 'team_leads', label: 'Team Leads', owner: 'Team Leads',
    kpis: [
      { name: 'Teams at ≥ 80% of target', actual: '0 of 4', target: '4 of 4', status: 'behind' },
      { name: 'Weekly coaching logs filed', actual: '4 of 4', target: '4 of 4', status: 'on' },
      { name: 'Held orders re-submitted within 24 h', actual: '72%', target: '≥ 90%', status: 'risk' },
    ],
  },
  {
    key: 'admin', label: 'Admin', owner: 'System Admin',
    kpis: [
      { name: 'Zoho sync errors cleared daily', actual: '5 open', target: '0 open', status: 'behind' },
      { name: 'New accounts set up within 1 day', actual: '67%', target: '100%', status: 'risk' },
      { name: 'Zoho salesperson mapping complete', actual: '86%', target: '100%', status: 'behind' },
      { name: 'Quarterly access review done', actual: 'Due Oct 15', target: 'Done', status: 'risk' },
    ],
  },
];

export const ROLE_OPTIONS = [
  { value: 'medrep', label: 'MedRep' },
  { value: 'team_lead', label: 'Team Lead' },
  { value: 'finance', label: 'Finance' },
  { value: 'dispatch', label: 'Dispatch' },
  { value: 'management', label: 'Management' },
  { value: 'admin', label: 'Admin' },
];
export const TEAM_OPTIONS = ['Team North', 'Team South', 'Team Metro', 'Team Telesales'];
