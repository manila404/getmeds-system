/**
 * The Sales Performance Excel file (Aaron sheet 13.6.6, Oct 20, 2026). The CSV it replaces opened in Excel
 * with cramped columns, raw decimals and no styling. Built, then read back with exceljs:
 *
 *  - columns are wide enough to read; the header is frozen and styled;
 *  - money cells have thousands separators (no decimals), the % column holds real percentages;
 *  - vacant rows are red, total rows are grey / peach / blue, % cells are coloured by the page's bands;
 *  - blank means blank (no target, no Today outside the running month), never 0 or #DIV/0!;
 *  - a second sheet lists what is not on the structure and reconciles with Zoho's total.
 */
const ExcelJS = require('exceljs');
const { buildSalesPerformance } = require('../src/services/salesPerformanceService');
const { buildSalesPerformanceWorkbook } = require('../src/services/salesPerformanceXlsx');

const channels = [
  { id: 1, name: 'RX · B&B', head_name: 'Javed', sort_order: 1 },
  { id: 2, name: 'HOSP', head_name: 'Vanessa', sort_order: 2 }
];
const managers = [
  { id: 11, channel_id: 1, name: 'Honey', sort_order: 1 },
  { id: 12, channel_id: 2, name: 'Jimlord', sort_order: 1 },
  { id: 13, channel_id: 2, name: 'Vanessa', sort_order: 2 }
];
const T = (id, manager_id, zoho, extra = {}) => ({
  id, manager_id, zoho_salesperson: zoho, zoho_alias: null, person_label: zoho, hq: 'QC - 1', is_vacant: false,
  target_month: '2026-10', target_amount: 1000000, sort_order: id, ...extra
});
const territories = [
  T(1, 11, 'B&B | EAST AVE', { target_amount: 623030 }),
  T(2, 11, 'B&B | VACANT ONE', { is_vacant: true, person_label: 'B&B | VACANT' }),
  T(3, 12, 'HOS | PASAY', { target_amount: 600000 }),
  T(4, 13, 'HOS | TACLOBAN', { target_amount: 0 })
];
const zoho = {
  available: true, fetchedAt: '2026-10-20T08:00:00Z', total_sales_with_tax: 0,
  invoices: [
    { salesperson: 'B&B | EAST AVE', total: 662865.1, date: '2026-10-20' },
    { salesperson: 'B&B | VACANT ONE', total: 100000, date: '2026-10-10' },
    { salesperson: 'HOS | PASAY', total: 59851, date: '2026-10-10' },
    { salesperson: 'Lazada', total: 640, date: '2026-10-10' }
  ],
  credit_notes: []
};
const sample = (over = {}) => buildSalesPerformance({ month: '2026-10', today: '2026-10-20', zoho, channels, managers, territories, ...over });

async function load(data) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildSalesPerformanceWorkbook(data));
  return wb;
}
const findRow = (ws, text) => { let hit = null; ws.eachRow((row) => { if (row.values.some((v) => v === text)) hit = row; }); return hit; };

describe('Sales Performance Excel file', () => {
  let wb, ws;
  beforeAll(async () => { wb = await load(sample()); ws = wb.getWorksheet('Sales Performance'); });

  test('has a readable layout: wide columns, a styled header on row 4, frozen, landscape', () => {
    expect(ws.getRow(4).values.slice(1)).toEqual(['Head', 'Channel', 'Manager', 'Sales Person', 'Zoho Name', 'HQ', 'Target', 'Achieved', 'Balance to Target', "Today's Invoicing", '% Age']);
    expect(ws.getColumn(4).width).toBeGreaterThanOrEqual(28);
    expect(ws.getColumn(5).width).toBeGreaterThanOrEqual(28);
    expect(ws.getColumn(9).width).toBeGreaterThanOrEqual(16);
    expect(ws.getRow(4).getCell(1).font.bold).toBe(true);
    expect(ws.getRow(4).getCell(1).fill.fgColor.argb).toBe('FF2F5597');
    expect(ws.views[0].state).toBe('frozen');
    expect(ws.views[0].ySplit).toBe(4);
    expect(ws.pageSetup.orientation).toBe('landscape');
  });

  test('money has thousands separators and no decimals; % is a real percentage', () => {
    const r = findRow(ws, 'B&B | EAST AVE');
    expect(r.getCell(7).value).toBe(623030);
    expect(r.getCell(7).numFmt).toMatch(/#,##0/);
    expect(r.getCell(8).value).toBeCloseTo(662865.1, 2);
    expect(r.getCell(8).numFmt).toMatch(/#,##0/);
    expect(r.getCell(8).numFmt).not.toMatch(/\.0/);
    expect(r.getCell(11).value).toBeCloseTo(1.064, 3);
    expect(r.getCell(11).numFmt).toBe('0.0%');
  });

  test('head, channel and manager show once per block; vacant rows are red; % cells follow the bands', () => {
    const first = findRow(ws, 'B&B | EAST AVE');
    expect([first.getCell(1).value, first.getCell(2).value, first.getCell(3).value]).toEqual(['Javed', 'RX BUSINESS', 'Honey']);
    const vacant = findRow(ws, 'B&B | VACANT ONE');
    expect(vacant.getCell(1).value).toBe(''); // not repeated
    expect(vacant.getCell(4).font.color.argb).toBe('FFC00000');
    expect(first.getCell(11).fill.fgColor.argb).toBe('FFC6EFCE'); // 106% on a 64.5% pace: on
    expect(vacant.getCell(11).fill.fgColor.argb).not.toBe('FFC6EFCE'); // 10% of target: behind
  });

  test('blank stays blank: no target gives no % and no balance; a zero target is also blank', () => {
    const tac = findRow(ws, 'HOS | TACLOBAN');
    expect(tac.getCell(11).value).toBeNull();
  });

  test('total rows are grey, peach and blue, and the grand total is last', () => {
    const group = findRow(ws, 'PRESCRIPTION TOTAL');
    expect(group.getCell(4).font.bold).toBe(true);
    expect(group.getCell(4).fill.fgColor.argb).toBe('FFD9D9D9');
    expect(findRow(ws, 'JAVED Total').getCell(4).fill.fgColor.argb).toBe('FFFCE4D6');
    const grand = findRow(ws, 'Grand Total');
    expect(grand.getCell(4).fill.fgColor.argb).toBe('FF9DC3E6');
    expect(grand.number).toBe(ws.rowCount);
    expect(findRow(ws, 'TOTAL — Jimlord')).toBeTruthy(); // HOSP has two managers, so manager subtotals show
    expect(findRow(ws, 'TOTAL — Honey')).toBeFalsy();     // RX BUSINESS has one
  });

  test('the second sheet lists what is not on the structure and reconciles with Zoho', () => {
    const ns = wb.getWorksheet('Not on the structure');
    expect(findRow(ns, 'Lazada').getCell(2).value).toBe(640);
    expect(findRow(ns, 'Together = Zoho Total Sales with Tax').getCell(2).value).toBeCloseTo(662865.1 + 100000 + 59851 + 640, 2);
  });
});

describe('Sales Performance Excel file: other cases', () => {
  test('a closed month has no Today figures', async () => {
    const w = await load(sample({ month: '2026-09' }));
    const r = findRow(w.getWorksheet('Sales Performance'), 'B&B | EAST AVE');
    expect(r.getCell(10).value).toBeNull();
  });

  test('when Zoho cannot be read the file still builds, with targets and blank money', async () => {
    const w = await load(sample({ zoho: { available: false, error: 'down' } }));
    const r = findRow(w.getWorksheet('Sales Performance'), 'B&B | EAST AVE');
    expect(r.getCell(7).value).toBe(623030);
    expect(r.getCell(8).value).toBeNull();
  });
});
