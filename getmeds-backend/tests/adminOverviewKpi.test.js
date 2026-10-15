/**
 * Admin Overview Sales KPIs (Oct 14, 2026): Zoho Total Sales with Tax vs the monthly targets.
 *
 *   Lead > Rep1, Rep2       Shared salesperson "STC | NCL": Rep2 is primary for it
 *  - an invoice goes to its Sales Order's owner first, else to the account that owns its
 *    Zoho salesperson (through the alias too); credit notes come off by salesperson;
 *  - a salesperson shared with no primary stays "not linked" instead of being guessed;
 *  - pace for Oct 14 is 14/31, and On target / At risk / Behind follow it;
 *  - a team is the lead plus everyone below; the totals still add up to Zoho's.
 */
const { buildSalesKpis } = require('../src/controllers/adminOverview.controller');

const users = [
  { id: 1, name: 'Lead', role: 'team_lead', is_active: 1, team_lead_id: null },
  { id: 2, name: 'Rep1', role: 'medrep', is_active: 1, team_lead_id: 1 },
  { id: 3, name: 'Rep2', role: 'medrep', is_active: 1, team_lead_id: 1 },
  { id: 4, name: 'Loner', role: 'medrep', is_active: 1, team_lead_id: null },
];
const accts = [
  { user_id: 2, salesperson: 'HOS | PALAWAN', is_primary: true },
  { user_id: 3, salesperson: 'STC | NCL', is_primary: true },
  { user_id: 1, salesperson: 'STC | NCL', is_primary: false },
  { user_id: 4, salesperson: 'URO | CEBU', is_primary: true },
  { user_id: 1, salesperson: 'URO | DAVAO', is_primary: false },
  { user_id: 3, salesperson: 'URO | DAVAO', is_primary: false },
];
const terrs = [{ zoho_salesperson: 'HOS | PALAWAN', zoho_alias: 'HOS I PALAWAN' }];
const targets = [
  { user_id: 1, target_php: 100000 }, { user_id: 2, target_php: 200000 },
  { user_id: 3, target_php: 100000 }, { user_id: 4, target_php: 50000 },
];
const inv = (salesperson, total, so = '') => ({ salesperson, total, so_number: so });
const zoho = {
  available: true, total_sales_with_tax: 225000,
  invoices: [
    inv('HOS I PALAWAN', 100000),            // Rep1, through the alias: 50% vs pace 45.2% → on
    inv('stc | ncl ', 30000),                // Rep2 (primary), case and spaces ignored
    inv('STC | CEBU', 12000, 'SO-1'),        // salesperson shared by two primaries, but SO-1 is Rep2's order
    inv('URO | DAVAO', 80000),               // shared, nobody primary, no Sales Order → not linked
    inv('Lazada', 5000),                     // no account → not linked
  ],
  credit_notes: [{ salesperson: 'STC | NCL', total: 2000 }], // Rep2: 30,000 + 12,000 − 2,000 = 40% → risk
};
const accts2 = [...accts, { user_id: 4, salesperson: 'STC | CEBU', is_primary: true }, { user_id: 1, salesperson: 'STC | CEBU', is_primary: true }];
const base = { zoho, from: '2026-10-01', to: '2026-10-14', month: '2026-10', users, accts: accts2, terrs, targets, soOwners: [{ so: 'so-1', user_id: 3 }] };

test('credits each Zoho salesperson to its owner and keeps the rest visible', () => {
  const k = buildSalesKpis(base);
  expect(k.available).toBe(true);
  expect(k.pace).toBe(45.2);
  const p = Object.fromEntries(k.people.map((x) => [x.name, x]));
  expect(p.Rep1).toMatchObject({ sales_php: 100000, pct_of_target: 50, status: 'on', team_lead: 'Lead' });
  expect(p.Rep2).toMatchObject({ sales_php: 40000, pct_of_target: 40, status: 'risk' });
  expect(p.Lead).toMatchObject({ sales_php: 0, status: 'behind' });
  expect(p.Loner).toMatchObject({ sales_php: 0, status: 'behind' });
  expect(k.unlinked.total).toBe(85000);
  expect(k.counts).toMatchObject({ invoices: 5, invoices_via_sales_order: 1 });
  expect(k.people.reduce((a, x) => a + x.sales_php, 0) + k.unlinked.total).toBe(zoho.total_sales_with_tax);
});

test('company total, counts and teams', () => {
  const k = buildSalesKpis(base);
  expect(k.total).toMatchObject({ target_php: 450000, sales_php: 225000, pct_of_target: 50, status: 'on' });
  expect(k.counts).toMatchObject({ people_with_target: 4, on_pace: 1, at_risk: 1, behind: 2, zero_sales: 2, teams_with_target: 1 });
  expect(k.teams).toHaveLength(1);
  expect(k.teams[0]).toMatchObject({ name: 'Lead', people: 3, target_php: 400000, sales_php: 140000, pct_of_target: 35, status: 'behind' });
});

test('a past month is judged against the whole month', () => {
  const k = buildSalesKpis({ ...base, from: '2026-09-01', to: '2026-09-30', month: '2026-09' });
  expect(k.pace).toBe(100);
  expect(k.people.find((x) => x.name === 'Rep1').status).toBe('behind'); // 50% of a finished month
});

test('says why when it cannot be worked out', () => {
  expect(buildSalesKpis({ ...base, from: '2026-10-08' }).reason).toMatch(/This month or Last month/);
  expect(buildSalesKpis({ ...base, month: null }).available).toBe(false);
  expect(buildSalesKpis({ ...base, users: undefined }).reason).toMatch(/No monthly targets/);
  expect(buildSalesKpis({ ...base, zoho: { available: false, error: 'not authorized' } }).reason).toMatch(/Waiting for Zoho: not authorized/);
});

test('Target Performance by sales channel (Oct 15, 2026)', () => {
  // HOS: Rep1 (HOS | PALAWAN); STC: Rep2 (STC | NCL primary) and Loner via STC | CEBU; URO | DAVAO's
  // unowned sales go to URO by the invoice's salesperson; Lazada has no territory -> No channel yet.
  const chTerrs = [
    { zoho_salesperson: 'HOS | PALAWAN', zoho_alias: 'HOS I PALAWAN', manager_id: 1 },
    { zoho_salesperson: 'STC | NCL', zoho_alias: null, manager_id: 2 },
    { zoho_salesperson: 'STC | CEBU', zoho_alias: null, manager_id: 2 },
    { zoho_salesperson: 'URO | DAVAO', zoho_alias: null, manager_id: 3 },
  ];
  const k = buildSalesKpis({
    ...base, terrs: chTerrs,
    managers: [{ id: 1, channel_id: 10 }, { id: 2, channel_id: 20 }, { id: 3, channel_id: 30 }],
    channels: [{ id: 10, name: 'HOSP', sort_order: 1 }, { id: 20, name: 'RX · STC', sort_order: 2 }, { id: 30, name: 'RX · URO', sort_order: 3 }],
  });
  const c = Object.fromEntries(k.channels.map((x) => [x.channel, x]));
  expect(k.channels.map((x) => x.channel)).toEqual(['HOSP', 'RX · STC', 'RX · URO', 'No channel yet']);
  expect(c.HOSP).toMatchObject({ people: 1, target_php: 200000, sales_php: 100000, pct_of_target: 50, status: 'on' });
  expect(c['RX · STC']).toMatchObject({ people: 3, target_php: 250000, sales_php: 40000 }); // Rep2, Loner and the Lead (STC | CEBU primary)
  expect(c['RX · URO']).toMatchObject({ people: 0, target_php: 0, sales_php: 80000, not_linked_php: 80000, status: null });
  expect(c['No channel yet'].sales_php).toBe(5000);
  expect(k.channels.reduce((a, x) => a + x.sales_php, 0)).toBe(zoho.total_sales_with_tax);
  expect(k.people.find((p) => p.name === 'Rep1').channel).toBe('HOSP');
});
