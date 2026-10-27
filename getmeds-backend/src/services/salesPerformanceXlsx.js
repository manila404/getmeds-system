'use strict';

/**
 * The Sales Performance page as a formatted Excel file (Aaron sheet 13.6.6, Oct 20, 2026).
 *
 * A CSV cannot carry column widths, number formats or colours, so it opened in Excel as cramped, unformatted
 * text. This builds a real .xlsx from the same data the page shows: sized columns, thousands separators,
 * real percentages, a frozen header, red vacant rows, coloured % cells (the page's on / at risk / behind
 * bands), grey / peach / blue total rows like the sheet, and a second sheet for what is not on the structure.
 *
 * Takes the object buildSalesPerformance returns; reads nothing and writes nothing else.
 */

const ExcelJS = require('exceljs');

const COLS = [
  { header: 'Head', width: 12 }, { header: 'Channel', width: 16 }, { header: 'Manager', width: 16 },
  { header: 'Sales Person', width: 30 }, { header: 'Zoho Name', width: 30 }, { header: 'HQ', width: 22 },
  { header: 'Target', width: 14 }, { header: 'Achieved', width: 14 }, { header: 'Balance to Target', width: 17 },
  { header: "Today's Invoicing", width: 17 }, { header: '% Age', width: 10 }
];
const MONEY = '#,##0;[Red]-#,##0';
const FIRST_DATA_ROW = 5;

const FILL = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const PCT_STYLE = {
  on: { fill: 'FFC6EFCE', font: 'FF006100' },
  risk: { fill: 'FFFFEB9C', font: 'FF9C5700' },
  behind: { fill: 'FFFFC7CE', font: 'FF9C0006' }
};
const TOTAL_STYLE = {
  sub: { fill: 'FFF2F2F2', font: 'FF000000' },
  group: { fill: 'FFD9D9D9', font: 'FF000000' },
  head: { fill: 'FFFCE4D6', font: 'FF843C0C' },
  grand: { fill: 'FF9DC3E6', font: 'FF1F3864' }
};
const THIN = { style: 'thin', color: { argb: 'FFD0D0D0' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const blank = (v) => (v === null || v === undefined ? null : v);
const frac = (pct) => (pct === null || pct === undefined ? null : Math.round(pct * 10) / 1000);

/** Puts one table row on the sheet; `t` is a totals object or a territory row. */
function addValues(ws, a, t) {
  const row = ws.addRow([...a, blank(t.target_php), blank(t.achieved_php), blank(t.balance_php), blank(t.today_php), frac(t.pct_of_target)]);
  row.eachCell({ includeEmpty: true }, (cell, n) => {
    cell.border = BORDER;
    cell.alignment = { vertical: 'middle', horizontal: n >= 7 ? 'right' : 'left' };
    if (n >= 7 && n <= 10) cell.numFmt = MONEY;
    if (n === 11) cell.numFmt = '0.0%';
  });
  return row;
}

function paintPct(row, status) {
  const s = PCT_STYLE[status];
  if (!s) return;
  const c = row.getCell(11);
  c.fill = FILL(s.fill);
  c.font = { ...(c.font || {}), bold: true, color: { argb: s.font } };
  c.alignment = { vertical: 'middle', horizontal: 'center' };
}

async function buildSalesPerformanceWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GetMeds';
  wb.created = new Date();

  const ws = wb.addWorksheet('Sales Performance', {
    views: [{ state: 'frozen', ySplit: FIRST_DATA_ROW - 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${FIRST_DATA_ROW - 1}:${FIRST_DATA_ROW - 1}` }
  });
  ws.columns = COLS.map((c) => ({ width: c.width }));

  // Title block
  ws.mergeCells(1, 1, 1, COLS.length);
  ws.getCell('A1').value = data.range
    ? `Sales Performance — ${data.range.from === data.range.to ? data.range.from : `${data.range.from} to ${data.range.to}`}${data.multi_month ? ' (no target: the dates cover two months)' : ` · ${monthLabel(data.month)} target`}`
    : `Sales Performance — ${monthLabel(data.month)}${data.running ? ` (so far, day ${data.today.slice(8, 10)})` : ''}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, COLS.length);
  const asOf = data.zoho && data.zoho.fetched_at ? new Date(data.zoho.fetched_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : null;
  ws.getCell('A2').value = 'Achieved = Zoho Total Sales with Tax (invoices minus credit notes). Balance = Target − Achieved. Red rows are vacant territories and still count.'
    + (asOf ? ` Zoho read ${asOf}.` : '');
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF595959' } };
  ws.getCell('A2').alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(2).height = 30;

  // Header row
  const hr = ws.getRow(FIRST_DATA_ROW - 1);
  COLS.forEach((c, i) => { hr.getCell(i + 1).value = c.header; });
  hr.height = 22;
  hr.eachCell((cell, n) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = FILL('FF2F5597');
    cell.border = BORDER;
    cell.alignment = { vertical: 'middle', horizontal: n >= 7 ? 'right' : 'left', wrapText: true };
  });

  const total = (kind, label, t, labelCol = 4) => {
    const lead = ['', '', '', '', '', ''];
    lead[labelCol - 1] = label;
    const row = addValues(ws, lead, t);
    const st = TOTAL_STYLE[kind];
    row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = FILL(st.fill); cell.font = { bold: true, color: { argb: st.font } }; });
    paintPct(row, t.status);
    return row;
  };

  for (const h of data.heads) {
    let headFirst = true;
    const isOnline = (h.head || '').toLowerCase() === 'online';
    for (const g of h.groups) {
      let groupFirst = true;
      for (const m of g.managers) {
        let mgrFirst = true;
        const isMgrOnline = (m.manager || '').toLowerCase() === 'online';
        for (const r of m.rows) {
          const row = addValues(ws, [headFirst ? (isOnline ? '' : h.head) : '', groupFirst ? g.label : '', mgrFirst ? (isMgrOnline ? '' : m.manager) : '', r.person, r.zoho_name, r.hq], r);
          row.getCell(1).font = { bold: true };
          row.getCell(2).font = { bold: true };
          if (r.vacant) [4, 5].forEach((n) => { row.getCell(n).font = { color: { argb: 'FFC00000' } }; });
          paintPct(row, r.status);
          headFirst = false; groupFirst = false; mgrFirst = false;
        }
        if (m.subtotal) total('sub', `TOTAL — ${m.manager}`, m.subtotal);
      }
      total('group', g.total_label, g.total);
    }
    if (h.head && !isOnline) total('head', `${h.head.toUpperCase()} Total`, h.total);
  }
  total('grand', 'Grand Total', data.grand_total);

  // Second sheet: what is not on the structure, and the reconciliation with Zoho
  const ns = wb.addWorksheet('Not on the structure', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ns.columns = [{ width: 42 }, { width: 18 }, { width: 18 }];
  ns.mergeCells('A1:C1');
  ns.getCell('A1').value = `Not on the structure — ${data.range ? `${data.range.from} to ${data.range.to}` : monthLabel(data.month)}`;
  ns.getCell('A1').font = { bold: true, size: 14 };
  ns.mergeCells('A2:C2');
  ns.getCell('A2').value = 'Sales Zoho recorded under a salesperson that is not a territory on the sheet. They are not in the Sales Performance totals; together they make the Zoho figure whole.';
  ns.getCell('A2').font = { italic: true, color: { argb: 'FF595959' } };
  ns.getCell('A2').alignment = { wrapText: true, vertical: 'top' };
  ns.getRow(2).height = 32;
  const nh = ns.getRow(4);
  ['Zoho salesperson', 'Achieved', "Today's Invoicing"].forEach((t, i) => { nh.getCell(i + 1).value = t; });
  nh.eachCell((cell, n) => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = FILL('FF2F5597'); cell.border = BORDER; cell.alignment = { horizontal: n > 1 ? 'right' : 'left' }; });
  const nrow = (vals, bold) => {
    const r = ns.addRow(vals);
    r.eachCell({ includeEmpty: true }, (cell, n) => { cell.border = BORDER; if (n > 1) { cell.numFmt = MONEY; cell.alignment = { horizontal: 'right' }; } if (bold) cell.font = { bold: true }; });
    return r;
  };
  data.not_on_structure.rows.forEach((r) => nrow([r.salesperson, r.achieved_php, data.running ? r.today_php : null]));
  const tot = nrow(['Total not on the structure', data.not_on_structure.total_php, null], true);
  tot.eachCell({ includeEmpty: true }, (cell) => { cell.fill = FILL('FFD9D9D9'); });
  if (data.reconciliation) {
    ns.addRow([]);
    nrow(['Sales Performance grand total', data.reconciliation.structure_php, null]);
    nrow(['Not on the structure', data.reconciliation.not_on_structure_php, null]);
    const t2 = nrow(['Together = Zoho Total Sales with Tax', data.reconciliation.together_php, null], true);
    t2.eachCell({ includeEmpty: true }, (cell) => { cell.fill = FILL('FF9DC3E6'); });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildSalesPerformanceWorkbook };
