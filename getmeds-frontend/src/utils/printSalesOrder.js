import toast from 'react-hot-toast';
import client from '../api/client';
import { formatPHT } from './dateUtils';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const ENTITY_PROFILES = {
  '2mg': {
    legal_name: '2MG INCORPORATED',
    address_line_1: '17 VATICAN BLDG. VATICAN CITY DRIVE BF RESORT VILLAGE TALON DOS',
    address_line_2: 'LAS PINAS CITY, FOURTH DISTRICT, NCR PHILIPPINES 1740',
    email: 'finance3@getmeds.ph',
    tel: '0287091617',
    tin: 'VAT-REG TIN 010-065-182-00000'
  },
  gpi: {
    legal_name: 'GETMEDS PHILIPPINES INC',
    address_line_1: '17 VATICAN BLDG. VATICAN CITY DRIVE BF RESORT VILLAGE TALON DOS',
    address_line_2: 'LAS PINAS CITY, FOURTH DISTRICT, NCR PHILIPPINES 1740',
    email: 'finance@2mginc.com',
    tel: '09945648231',
    tin: 'VAT-REG TIN 605-059-166-00000'
  }
};

function profileForEntity(invoicingFrom) {
  const s = String(invoicingFrom || '').toLowerCase();
  return s.includes('2mg') ? ENTITY_PROFILES['2mg'] : ENTITY_PROFILES.gpi;
}

function money(val) {
  return Number(val || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildSalesOrderPrintableHtml({ order = {}, items = [] }) {
  const profile = profileForEntity(order.invoicing_from);
  const soNumber = order.zoho_so_number || order.getmeds_order_id || '—';
  const refNumber = order.getmeds_order_id || '—';
  const orderDate = formatPHT(order.sales_order_date || order.created_at, 'date');
  const shipDate = order.expected_shipment_date ? formatPHT(order.expected_shipment_date, 'date') : '—';
  const totalAmount = Number(order.total_amount ?? 0);
  const subtotalSum = items.reduce((sum, it) => sum + Number(it.subtotal ?? (Number(it.quantity || 0) * Number(it.unit_price || 0))), 0);
  const lineTotalSum = items.reduce((sum, it) => sum + Number(it.line_total ?? it.subtotal ?? (Number(it.quantity || 0) * Number(it.unit_price || 0))), 0);
  const discountTotal = Number(order.discount_amount || 0);
  const computedTax = Math.max(0, Number(order.tax_amount ?? (totalAmount - subtotalSum + discountTotal)));

  const rowsHtml = (items || []).map((it, idx) => {
    const qty = Number(it.quantity || 0);
    const rate = Number(it.unit_price ?? it.rate ?? 0);
    const amount = Number(it.line_total ?? it.subtotal ?? qty * rate);
    const batches = Array.isArray(it.batches) ? it.batches : [];
    const batchNote = batches.length
      ? `<div class="item-sub">Batch: ${batches.map((b) => `${esc(b.batch_number)} (${esc(b.quantity)}${b.expiry_date ? `, Exp ${esc(b.expiry_date)}` : ''})`).join('; ')}</div>`
      : '';
    const taxLabel = it.tax_percent !== null && it.tax_percent !== undefined && it.tax_percent !== ''
      ? `${Number(it.tax_percent)}%`
      : '—';
    return `
      <tr>
        <td class="c">${idx + 1}</td>
        <td>
          <div class="item-name">${esc(it.product_name || it.name || 'Item')}</div>
          ${it.sku ? `<div class="item-sub">SKU: ${esc(it.sku)}</div>` : ''}
          ${it.invoicing_from && it.invoicing_from !== order.invoicing_from ? `<div class="item-sub">Entity: ${esc(it.invoicing_from)}</div>` : ''}
          ${batchNote}
        </td>
        <td class="r"><b>${esc(qty)}</b> ${esc(it.unit || 'pc')}</td>
        <td class="r">${money(rate)}</td>
        <td class="c">${esc(taxLabel)}</td>
        <td class="r"><b>${money(amount)}</b></td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Sales Order ${esc(soNumber)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111827; font-size: 9.5pt; margin: 0; line-height: 1.38; }
    .sheet { padding: 2mm; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e293b; padding-bottom: 4mm; margin-bottom: 4mm; }
    .org-name { font-size: 13pt; font-weight: 700; color: #0f172a; }
    .org-sub { font-size: 8.2pt; color: #475569; margin-top: 1px; }
    .so-title { text-align: right; }
    .so-title h1 { font-size: 18pt; margin: 0; letter-spacing: 0.5px; color: #0f172a; }
    .so-title .so-num { font-size: 11pt; font-weight: 700; font-family: monospace; color: #1d4ed8; margin-top: 2px; }
    .grid-2 { display: grid; grid-template-columns: 1.35fr 1fr; gap: 6mm; margin-bottom: 4.5mm; }
    .panel { border: 1px solid #cbd5e1; border-radius: 3px; padding: 3mm 3.5mm; }
    .panel-title { font-size: 7.8pt; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.6px; margin-bottom: 1.5mm; }
    .cust-name { font-size: 10.5pt; font-weight: 700; margin-bottom: 1.5mm; }
    .meta-table { width: 100%; border-collapse: collapse; }
    .meta-table td { padding: 1mm 1.5mm; font-size: 9pt; vertical-align: top; }
    .meta-table td.k { color: #64748b; width: 42%; font-weight: 600; }
    .meta-table td.v { text-align: right; font-weight: 600; color: #0f172a; }
    table.items { width: 100%; border-collapse: collapse; margin-top: 2mm; }
    table.items th { background: #1e293b; color: #fff; font-size: 8.2pt; text-transform: uppercase; padding: 2mm 2.2mm; border: 1px solid #1e293b; text-align: left; }
    table.items th.r, table.items td.r { text-align: right; }
    table.items th.c, table.items td.c { text-align: center; }
    table.items td { border: 1px solid #cbd5e1; padding: 2mm 2.2mm; vertical-align: top; font-size: 9pt; }
    .item-name { font-weight: 600; color: #0f172a; }
    .item-sub { font-size: 7.8pt; color: #475569; margin-top: 1px; }
    .bottom { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; margin-top: 4mm; }
    .notes-box { flex: 1; font-size: 8.5pt; color: #334155; }
    .totals { width: 68mm; border-collapse: collapse; }
    .totals td { padding: 1.5mm 2mm; font-size: 9pt; border-bottom: 1px solid #e2e8f0; }
    .totals td.r { text-align: right; font-weight: 600; }
    .totals tr.grand td { border-top: 2px solid #1e293b; border-bottom: 2px solid #1e293b; font-size: 10.5pt; font-weight: 700; background: #f8fafc; padding: 2mm; }
    .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 10mm; font-size: 8.5pt; }
    .sig-line { border-top: 1px solid #475569; padding-top: 1.5mm; text-align: center; font-weight: 600; color: #334155; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div>
        <div class="org-name">${esc(profile.legal_name)}</div>
        <div class="org-sub">${esc(profile.address_line_1)}</div>
        <div class="org-sub">${esc(profile.address_line_2)}</div>
        <div class="org-sub">Email: ${esc(profile.email)} &nbsp;·&nbsp; Tel: ${esc(profile.tel)}</div>
        <div class="org-sub">${esc(profile.tin)}</div>
      </div>
      <div class="so-title">
        <h1>SALES ORDER</h1>
        <div class="so-num"># ${esc(soNumber)}</div>
        <div class="org-sub">Order Ref: ${esc(refNumber)}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-title">Customer &amp; Delivery Details</div>
        <div class="cust-name">${esc(order.customer_name || '—')}</div>
        <div><b>Ship To:</b> ${esc(order.delivery_address || order.customer_address || '—')}</div>
        ${order.tin ? `<div><b>TIN:</b> ${esc(order.tin)}</div>` : ''}
        ${order.lto_license_number ? `<div><b>LTO No.:</b> ${esc(order.lto_license_number)}</div>` : ''}
        ${order.intake_receiver || order.contact_person ? `<div><b>Attention / Receiver:</b> ${esc(order.intake_receiver || order.contact_person)}</div>` : ''}
        ${order.intake_contact_no || order.contact_number ? `<div><b>Contact No.:</b> ${esc(order.intake_contact_no || order.contact_number)}</div>` : ''}
      </div>
      <div class="panel">
        <table class="meta-table">
          <tr><td class="k">Order Date</td><td class="v">${esc(orderDate)}</td></tr>
          <tr><td class="k">Expected Shipment</td><td class="v">${esc(shipDate)}</td></tr>
          <tr><td class="k">Payment Terms</td><td class="v">${esc(order.intake_payment_terms || order.customer_type || '—')}</td></tr>
          <tr><td class="k">Salesperson</td><td class="v">${esc(order.salesperson_name || order.medrep_name || '—')}</td></tr>
          <tr><td class="k">Delivery Method</td><td class="v">${esc(order.intake_delivery_method || '—')}</td></tr>
          ${order.intake_gl_number ? `<tr><td class="k">GL Number</td><td class="v">${esc(order.intake_gl_number)}</td></tr>` : ''}
        </table>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th class="c" style="width:28px;">#</th>
          <th>Item &amp; Description</th>
          <th class="r" style="width:78px;">Qty</th>
          <th class="r" style="width:82px;">Rate (PHP)</th>
          <th class="c" style="width:52px;">Tax</th>
          <th class="r" style="width:94px;">Amount (PHP)</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || '<tr><td colspan="6" class="c">No line items</td></tr>'}
      </tbody>
    </table>

    <div class="bottom">
      <div class="notes-box">
        ${order.delivery_notes ? `<div><b>Delivery Notes:</b> ${esc(order.delivery_notes)}</div>` : ''}
        ${order.notes ? `<div style="margin-top:2px;"><b>Order Notes:</b> ${esc(order.notes)}</div>` : ''}
      </div>
      <table class="totals">
        <tr><td>Sub Total</td><td class="r">PHP ${money(subtotalSum || lineTotalSum || totalAmount)}</td></tr>
        ${discountTotal > 0 ? `<tr><td>Discount</td><td class="r">- PHP ${money(discountTotal)}</td></tr>` : ''}
        ${computedTax > 0.01 ? `<tr><td>Tax / VAT</td><td class="r">PHP ${money(computedTax)}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td class="r">PHP ${money(totalAmount || lineTotalSum)}</td></tr>
      </table>
    </div>

    <div class="sigs">
      <div><div style="height:10mm;"></div><div class="sig-line">Prepared / Printed By</div></div>
      <div><div style="height:10mm;"></div><div class="sig-line">Checked / Approved By</div></div>
    </div>
  </div>
</body>
</html>`;
}

export function openPrintableSalesOrder({ order, items }) {
  const win = window.open('', '_blank', 'width=940,height=740');
  if (!win) {
    toast.error('Allow pop-ups for this site to print the Sales Order.');
    return;
  }
  win.document.open();
  win.document.write(buildSalesOrderPrintableHtml({ order, items }));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

export async function fetchAndPrintSalesOrder(orderId) {
  const win = window.open('', '_blank', 'width=940,height=740');
  if (!win) {
    toast.error('Allow pop-ups for this site to print the Sales Order.');
    return;
  }
  win.document.write('<p style="font-family:Arial;padding:24px">Preparing Sales Order printout…</p>');
  try {
    const { data: res } = await client.get(`/api/orders/${orderId}`);
    const d = res.data || {};
    win.document.open();
    win.document.write(buildSalesOrderPrintableHtml({ order: d.order, items: d.items || [] }));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  } catch (err) {
    win.close();
    toast.error(err?.response?.data?.error?.message || 'Could not load Sales Order for printing.');
  }
}
