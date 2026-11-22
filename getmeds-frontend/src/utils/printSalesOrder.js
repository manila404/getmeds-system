import client from '../api/client';
import getmedsLogo from '../assets/GETMEDS PHILIPPINES LOGO.png';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

export function normalizeEntityKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === '2mg' || s.includes('2mg')) return '2MG';
  if (s === 'gpi' || s.includes('getmeds')) return 'GPI';
  return null;
}

const ENTITY_TEMPLATES = {
  '2MG': {
    entity_key: '2MG',
    invoicing_from: '2mg Incorporated',
    company_name: '2MG Inc.',
    bold_company: false,
    show_logo: false,
    show_confirmed_ribbon: false,
    title_text: 'SALES ORDER',
    party_label: 'Ship To',
    party_blue: false,
    show_terms_meta: true,
    address_lines: [
      'Unit 301 17 Vatican Building, Vatican Drive,',
      'BF Resort Village, Talon Dos, Las Pinas City, 1747',
      'VAT Reg. TIN: 010-065-182-00000',
      'Phone - 9190769105'
    ]
  },
  GPI: {
    entity_key: 'GPI',
    invoicing_from: 'Getmeds Philippines Inc.',
    company_name: 'Getmeds Philippines Inc.',
    bold_company: true,
    show_logo: true,
    show_confirmed_ribbon: true,
    title_text: 'Sales Order',
    party_label: 'Bill To',
    party_blue: true,
    show_terms_meta: false,
    address_lines: [
      'No. 17 Vatican Bldg. Vatican Drive BF Resort Village, Talon Dos',
      'Las Pinas National Capital Region (Manila) 1747',
      'Philippines'
    ]
  }
};

function fmtZohoDate(raw) {
  if (!raw) return '—';
  const s = String(raw).trim();
  const ymd = s.slice(0, 10);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T00:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const yr = d.getUTCFullYear();
  return `${day} ${mon} ${yr}`;
}

function getLogoHref() {
  try {
    if (typeof window !== 'undefined' && window.location?.href) {
      return new URL(getmedsLogo, window.location.href).href;
    }
  } catch {
    // fallback below
  }
  return getmedsLogo;
}

function computeLineAndTotals(items = [], isInclusive = true) {
  let subTotal = 0;
  let zeroTaxCount = 0;
  let vatTaxCount = 0;
  let vatAmount = 0;

  const rows = (items || []).map((it, idx) => {
    const qty = Number(it.quantity ?? 0);
    const rate = Number(it.unit_price ?? it.rate ?? 0);
    const taxPct = Number(it.tax_percent ?? it.tax_percentage ?? 0);
    // Zoho PDF displays inclusive rate * qty for Amount & Sub Total (Tax Inclusive).
    const rawTotal = it.line_total != null
      ? Number(it.line_total)
      : it.subtotal != null
        ? Number(it.subtotal)
        : round2(qty * rate);
    const displayAmount = isInclusive
      ? round2(rawTotal || round2(qty * rate))
      : round2(qty * rate);

    subTotal = round2(subTotal + displayAmount);
    if (taxPct > 0) {
      vatTaxCount += 1;
      const taxPart = isInclusive
        ? (displayAmount * taxPct) / (100 + taxPct)
        : (displayAmount * taxPct) / 100;
      vatAmount += taxPart;
    } else {
      zeroTaxCount += 1;
    }

    return {
      index: idx + 1,
      name: it.product_name || it.name || 'Item',
      description: it.description || '',
      strength: it.strength || '',
      medicine_form: it.medicine_form || '',
      quantity: qty,
      unit: it.unit || 'pcs',
      rate: round2(rate),
      amount: displayAmount,
      taxPct
    };
  });

  vatAmount = round2(vatAmount);
  const grandTotal = isInclusive ? subTotal : round2(subTotal + vatAmount);

  return {
    rows,
    subTotal,
    zeroTaxCount,
    vatTaxCount,
    vatAmount,
    grandTotal
  };
}

/**
 * Merge Hub order items for one entity with live Zoho line_items (when available)
 * so Strength, Medicine Form, exact Zoho tax%, and exact Zoho line order match Zoho PDF.
 */
function mergeZohoEntityItems(hubItems = [], zohoSo = null) {
  const zohoLines = Array.isArray(zohoSo?.line_items) ? zohoSo.line_items : [];
  if (!zohoLines.length) return hubItems;
  if (!hubItems.length) {
    return zohoLines.map((zl) => ({
      product_name: zl.name,
      description: zl.description || '',
      strength: zl.strength || '',
      medicine_form: zl.medicine_form || '',
      quantity: Number(zl.quantity || 0),
      unit: zl.unit || 'pcs',
      unit_price: Number(zl.rate || 0),
      tax_percent: Number(zl.tax_percentage || 0),
      line_total: round2(Number(zl.quantity || 0) * Number(zl.rate || 0))
    }));
  }

  const remainingHub = [...hubItems];
  return zohoLines.map((zl) => {
    const zName = String(zl.name || '').trim().toLowerCase();
    const zQty = Number(zl.quantity || 0);
    const zRate = Number(zl.rate || 0);
    let idx = remainingHub.findIndex((h) =>
      String(h.product_name || h.name || '').trim().toLowerCase() === zName
      && Number(h.quantity || 0) === zQty
      && Math.abs(Number(h.unit_price ?? h.rate ?? 0) - zRate) < 0.01
    );
    if (idx === -1) {
      idx = remainingHub.findIndex((h) => String(h.product_name || h.name || '').trim().toLowerCase() === zName);
    }
    const matched = idx >= 0 ? remainingHub.splice(idx, 1)[0] : null;
    const rate = Number(zl.rate ?? matched?.unit_price ?? 0);
    const qty = Number(zl.quantity ?? matched?.quantity ?? 0);
    return {
      ...(matched || {}),
      product_name: zl.name || matched?.product_name || matched?.name || 'Item',
      description: zl.description || matched?.description || '',
      strength: zl.strength || matched?.strength || '',
      medicine_form: zl.medicine_form || matched?.medicine_form || '',
      quantity: qty,
      unit: zl.unit || matched?.unit || 'pcs',
      unit_price: rate,
      tax_percent: zl.tax_percentage != null ? Number(zl.tax_percentage) : Number(matched?.tax_percent ?? 0),
      line_total: round2(qty * rate)
    };
  });
}

/**
 * Resolve one or two per-entity SO documents for printing.
 * Split orders generate one independent Sales Order sheet per company
 * (e.g. SO-70312 for 2MG with Beltro items; SO-70313 for GPI with Getfil + Packaging).
 */
export function resolveSalesOrderDocuments({
  order = {},
  items = [],
  splits = [],
  zoho_sales_orders_by_entity: zohoByEntity = {},
  entityKey = null
} = {}) {
  const primaryKey = normalizeEntityKey(order.invoicing_from) || 'GPI';
  const docSpecs = [
    {
      entityKey: primaryKey,
      isSplitRow: false,
      soNumber: order.zoho_so_number || order.getmeds_order_id || '—',
      soStatus: order.zoho_so_status || order.zoho_order_status || order.status || '',
      zohoSo: zohoByEntity?.[primaryKey] || null
    }
  ];

  for (const s of splits || []) {
    const sKey = normalizeEntityKey(s.invoicing_from);
    if (!sKey || sKey === primaryKey) continue;
    docSpecs.push({
      entityKey: sKey,
      isSplitRow: true,
      soNumber: s.zoho_so_number || order.getmeds_order_id || '—',
      soStatus: s.zoho_so_status || s.zoho_order_status || '',
      zohoSo: zohoByEntity?.[sKey] || null
    });
  }

  // Fallback inference if `splits` wasn't passed by caller but line items differ by entity
  if (!splits?.length) {
    const extraKeys = new Set();
    for (const it of items || []) {
      const k = normalizeEntityKey(it.invoicing_from);
      if (k && k !== primaryKey) extraKeys.add(k);
    }
    for (const k of extraKeys) {
      docSpecs.push({
        entityKey: k,
        isSplitRow: true,
        soNumber: zohoByEntity?.[k]?.salesorder_number || order.getmeds_order_id || '—',
        soStatus: zohoByEntity?.[k]?.status || '',
        zohoSo: zohoByEntity?.[k] || null
      });
    }
  }

  const wantedKey = entityKey && entityKey !== 'ALL' ? normalizeEntityKey(entityKey) : null;
  const filteredSpecs = wantedKey ? docSpecs.filter((d) => d.entityKey === wantedKey) : docSpecs;
  const finalSpecs = filteredSpecs.length ? filteredSpecs : [docSpecs[0]];

  return finalSpecs.map((spec) => {
    const entityHubItems = (items || []).filter(
      (it) => (normalizeEntityKey(it.invoicing_from) || primaryKey) === spec.entityKey
    );
    const mergedItems = mergeZohoEntityItems(entityHubItems, spec.zohoSo);
    return {
      ...spec,
      soNumber: spec.zohoSo?.salesorder_number || spec.soNumber,
      soStatus: spec.zohoSo?.status || spec.soStatus,
      items: mergedItems
    };
  });
}

function buildSingleSheetHtml({ order, docSpec, logoHref, pageBreakAfter }) {
  const tpl = ENTITY_TEMPLATES[docSpec.entityKey] || ENTITY_TEMPLATES.GPI;
  const z = docSpec.zohoSo;
  const isInclusive = z?.is_inclusive_tax !== undefined
    ? Boolean(z.is_inclusive_tax)
    : order.is_inclusive_tax !== 0;

  const {
    rows,
    subTotal,
    zeroTaxCount,
    vatTaxCount,
    vatAmount,
    grandTotal
  } = computeLineAndTotals(docSpec.items, isInclusive);

  const soStatusLower = String(docSpec.soStatus || '').toLowerCase();
  const isConfirmed = ['confirmed', 'open', 'closed', 'invoiced', 'dispatched', 'tracking_shared', 'completed'].includes(soStatusLower)
    || Boolean(order.zoho_so_status === 'confirmed' || order.finance_verified_at);

  const orderDate = fmtZohoDate(z?.date || order.sales_order_date || order.created_at);
  const termsLabel = z?.payment_terms_label || order.intake_payment_terms || '';
  const refNo = z?.reference_number || order.getmeds_order_id || '—';
  const deliveryMethod = z?.delivery_method || order.intake_delivery_method || order.courier || '';
  const doctorName = z?.doctor_name || order.dispatch_doctor_name || order.intake_doctor || '';
  const customerName = z?.customer_name || order.customer_name || 'Customer';

  const notesLines = [];
  const zNotes = String(z?.notes || '').trim();
  const baseOrderNoNote = `Order No.: ${order.getmeds_order_id || refNo}`;
  if (zNotes) {
    notesLines.push(zNotes);
  } else {
    notesLines.push(baseOrderNoNote);
  }
  const hubDeliveryNotes = String(order.delivery_notes || '').trim();
  if (hubDeliveryNotes && (!zNotes || !zNotes.includes(hubDeliveryNotes))) {
    notesLines.push(hubDeliveryNotes);
  }
  const termsText = String(z?.terms || order.intake_terms || '').trim();

  const metaRows = [
    { label: 'Order Date', value: orderDate },
    ...(tpl.show_terms_meta && termsLabel ? [{ label: 'Terms', value: termsLabel }] : []),
    { label: 'Ref#', value: refNo },
    ...(deliveryMethod ? [{ label: 'Delivery Method', value: deliveryMethod }] : []),
    ...(doctorName ? [{ label: 'Doctor Name', value: doctorName }] : [])
  ];

  return `
    <div class="sheet" style="${pageBreakAfter ? 'page-break-after: always;' : ''}">
      ${tpl.show_confirmed_ribbon && isConfirmed ? '<div class="ribbon">Confirmed</div>' : ''}
      <div class="top-head">
        <div class="org-block">
          ${tpl.show_logo && logoHref ? `<img src="${esc(logoHref)}" alt="Getmeds Philippines Inc." class="org-logo" />` : ''}
          <div class="${tpl.bold_company ? 'org-name org-name-bold' : 'org-name'}">${esc(tpl.company_name)}</div>
          ${tpl.address_lines.map((line) => `<div class="org-line">${esc(line)}</div>`).join('')}
        </div>
        <div class="title-block">
          <div class="${docSpec.entityKey === '2MG' ? 'doc-title doc-title-upper' : 'doc-title'}">${esc(tpl.title_text)}</div>
          <div class="so-num">Sales Order# ${esc(docSpec.soNumber)}</div>
        </div>
      </div>

      <div class="meta-split">
        <div class="party-block">
          <div class="party-label">${esc(tpl.party_label)}</div>
          <div class="${tpl.party_blue ? 'party-name party-name-blue' : 'party-name'}">${esc(customerName)}</div>
        </div>
        <table class="meta-table">
          <tbody>
            ${metaRows.map((m) => `
              <tr>
                <td class="meta-k">${esc(m.label)} :</td>
                <td class="meta-v">${esc(m.value)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <table class="items-table">
        <thead>
          <tr>
            <th style="width: 30px; text-align: left;">#</th>
            <th style="text-align: left;">Item &amp; Description</th>
            <th style="width: 96px; text-align: right;">Strength</th>
            <th style="width: 105px; text-align: left; padding-left: 14px;">Medicine Form</th>
            <th style="width: 68px; text-align: right;">Qty</th>
            <th style="width: 78px; text-align: right;">Rate</th>
            <th style="width: 84px; text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((r) => `
            <tr>
              <td class="col-num">${r.index}</td>
              <td class="col-item">
                <div class="item-title">${esc(r.name)}</div>
                ${r.description ? `<div class="item-desc">${esc(r.description)}</div>` : ''}
              </td>
              <td class="col-strength">${esc(r.strength)}</td>
              <td class="col-form">${esc(r.medicine_form)}</td>
              <td class="col-qty">
                <div>${qtyFmt(r.quantity)}</div>
                <div class="qty-unit">${esc(r.unit)}</div>
              </td>
              <td class="col-money">${money(r.rate)}</td>
              <td class="col-money">${money(r.amount)}</td>
            </tr>
          `).join('') : '<tr><td colspan="7" class="empty-cell">No items under this entity.</td></tr>'}
        </tbody>
      </table>

      <div class="totals-wrap">
        <table class="totals-table">
          <tbody>
            <tr>
              <td class="tot-k">
                <div>Sub Total</div>
                ${isInclusive ? '<div class="tot-sub">(Tax Inclusive)</div>' : ''}
              </td>
              <td class="tot-v">${money(subTotal)}</td>
            </tr>
            ${zeroTaxCount > 0 ? `
              <tr>
                <td class="tot-k">No Tax (0%)</td>
                <td class="tot-v">0.00</td>
              </tr>
            ` : ''}
            ${vatTaxCount > 0 ? `
              <tr>
                <td class="tot-k">Vat (12%)</td>
                <td class="tot-v">${money(vatAmount)}</td>
              </tr>
            ` : ''}
            <tr class="tot-grand">
              <td class="tot-k">Total</td>
              <td class="tot-v">PHP${money(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="bottom-notes">
        <div class="sec-heading">Notes</div>
        ${notesLines.map((line) => `<div class="sec-body">${esc(line)}</div>`).join('')}

        ${termsText ? `
          <div class="sec-heading sec-terms-head">Terms &amp; Conditions</div>
          <div class="sec-body">${esc(termsText)}</div>
        ` : ''}
      </div>

      <div class="sheet-footer">
        <div class="footer-rule"></div>
        <div class="footer-page">1</div>
      </div>
    </div>
  `;
}

function buildDeliveryAddressSlipHtml({ order = {}, docs = [] }) {
  const soSummary = docs.map((d) => `${d.entityKey}: ${d.soNumber}`).join(' · ');
  const singleSo = docs.length === 1 ? docs[0].soNumber : '';
  const contact = order.intake_contact_no || order.contact_number || '';
  const receiver = order.intake_receiver || order.contact_person || '';
  const deliveryMethod = order.intake_delivery_method || order.courier || '';
  const doctorName = order.dispatch_doctor_name || order.intake_doctor || '';
  const date = fmtZohoDate(order.sales_order_date || order.created_at);

  return `
    <div class="sheet slip-sheet">
      <div class="slip-header">
        <div>
          <div class="slip-kicker">DISPATCH TAGGING &amp; WAYBILL COPY</div>
          <div class="slip-title">DELIVERY ADDRESS SLIP</div>
        </div>
        <div class="slip-order-meta">
          <div><b>Order:</b> ${esc(order.getmeds_order_id || '—')}</div>
          ${docs.length > 1
            ? `<div><b>Split SOs:</b> ${esc(soSummary)}</div>`
            : (singleSo ? `<div><b>SO:</b> ${esc(singleSo)}</div>` : '')}
          <div><b>Date:</b> ${esc(date)}</div>
        </div>
      </div>

      <div class="slip-box">
        <div class="slip-label">DELIVER TO</div>
        <div class="slip-customer">${esc(order.customer_name || 'Customer')}</div>
        <div class="slip-address">${esc(order.delivery_address || 'NO DELIVERY ADDRESS ON THIS ORDER')}</div>

        <div class="slip-grid">
          ${receiver ? `<div class="slip-field"><span class="slip-fk">Receiver / Attention:</span> <span class="slip-fv">${esc(receiver)}</span></div>` : ''}
          ${contact ? `<div class="slip-field"><span class="slip-fk">Contact No.:</span> <span class="slip-fv">${esc(contact)}</span></div>` : ''}
          ${deliveryMethod ? `<div class="slip-field"><span class="slip-fk">Delivery Method:</span> <span class="slip-fv">${esc(deliveryMethod)}</span></div>` : ''}
          ${order.intake_payment_terms ? `<div class="slip-field"><span class="slip-fk">Payment Terms:</span> <span class="slip-fv">${esc(order.intake_payment_terms)}</span></div>` : ''}
          ${doctorName ? `<div class="slip-field"><span class="slip-fk">Doctor Name:</span> <span class="slip-fv">${esc(doctorName)}</span></div>` : ''}
          ${order.delivery_notes ? `<div class="slip-field slip-field-wide"><span class="slip-fk">Delivery Notes:</span> <span class="slip-fv">${esc(order.delivery_notes)}</span></div>` : ''}
        </div>
      </div>

      ${docs.length > 1 ? `
        <div class="slip-split-note">
          <b>Split-Order Packing Reminder:</b> Pack items for both Sales Orders (${esc(soSummary)}) under one parcel tagging unless instructed otherwise.
        </div>
      ` : ''}
    </div>
  `;
}

export function buildSalesOrderPrintableHtml({
  order = {},
  items = [],
  splits = [],
  zoho_sales_orders_by_entity = {},
  entityKey = null,
  includeAddressSlip = true
} = {}) {
  const docs = resolveSalesOrderDocuments({
    order,
    items,
    splits,
    zoho_sales_orders_by_entity,
    entityKey
  });
  const logoHref = getLogoHref();
  const titleSo = docs.map((d) => d.soNumber).filter(Boolean).join(' / ') || order.getmeds_order_id || 'Sales Order';

  const sheetsHtml = docs
    .map((docSpec, idx) => buildSingleSheetHtml({
      order,
      docSpec,
      logoHref,
      pageBreakAfter: includeAddressSlip || idx < docs.length - 1
    }))
    .join('');
  const slipHtml = includeAddressSlip ? buildDeliveryAddressSlipHtml({ order, docs }) : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sales Order ${esc(titleSo)}</title>
  <style>
    @page { size: A4; margin: 12mm 14mm; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #111827;
      margin: 0;
      padding: 0;
      font-size: 9.5pt;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet {
      position: relative;
      min-height: 266mm;
      padding: 6mm 4mm 14mm 4mm;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .ribbon {
      position: absolute;
      top: 15px;
      left: -34px;
      width: 125px;
      background: #1ea7e0;
      color: #fff;
      font-size: 8.5pt;
      font-weight: 600;
      text-align: center;
      padding: 4px 0;
      transform: rotate(-45deg);
      letter-spacing: 0.2px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    }
    .top-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      margin-bottom: 22px;
    }
    .org-block { max-width: 58%; line-height: 1.42; padding-top: 2px; }
    .org-logo { display: block; height: 42px; width: auto; margin-bottom: 6px; object-fit: contain; }
    .org-name { font-size: 9.5pt; color: #374151; font-weight: 500; }
    .org-name-bold { font-size: 9.5pt; color: #111827; font-weight: 700; }
    .org-line { font-size: 8.5pt; color: #4b5563; }

    .title-block { text-align: right; }
    .doc-title { font-size: 27pt; font-weight: 400; color: #000; line-height: 1.05; letter-spacing: -0.2px; }
    .doc-title-upper { font-size: 25pt; font-weight: 300; letter-spacing: 0.4px; }
    .so-num { font-size: 9.5pt; font-weight: 700; color: #111827; margin-top: 4px; }

    .meta-split {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 20px;
      margin-bottom: 14px;
    }
    .party-block { padding-bottom: 2px; }
    .party-label { font-size: 9pt; color: #4b5563; margin-bottom: 2px; }
    .party-name { font-size: 9.5pt; font-weight: 700; color: #111827; }
    .party-name-blue { color: #1d4ed8; font-weight: 600; }

    .meta-table { border-collapse: collapse; margin-left: auto; }
    .meta-table td { padding: 3px 0; font-size: 8.8pt; vertical-align: top; }
    .meta-k { color: #4b5563; text-align: right; padding-right: 14px; white-space: nowrap; }
    .meta-v { color: #111827; text-align: right; min-width: 118px; }

    .items-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    .items-table thead th {
      background: #3c3d3e;
      color: #fff;
      font-size: 8.5pt;
      font-weight: 500;
      padding: 6px 8px;
      border: none;
    }
    .items-table tbody td {
      padding: 9px 8px;
      border-bottom: 1px solid #d1d5db;
      font-size: 8.8pt;
      vertical-align: top;
      color: #111827;
    }
    .col-num { color: #374151; }
    .item-title { font-weight: 500; color: #111827; }
    .item-desc { font-size: 8pt; color: #6b7280; margin-top: 2px; white-space: pre-line; }
    .col-strength { text-align: right; color: #111827; }
    .col-form { text-align: left; padding-left: 14px !important; color: #111827; }
    .col-qty { text-align: right; white-space: nowrap; }
    .qty-unit { font-size: 7.8pt; color: #6b7280; margin-top: 1px; }
    .col-money { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .empty-cell { text-align: center; color: #6b7280; padding: 14px; }

    .totals-wrap { margin-top: 8px; display: flex; justify-content: flex-end; }
    .totals-table { border-collapse: collapse; min-width: 265px; }
    .totals-table td { padding: 6px 10px; font-size: 8.8pt; vertical-align: top; }
    .tot-k { text-align: right; color: #374151; padding-right: 18px; }
    .tot-sub { font-size: 7.6pt; color: #6b7280; margin-top: 1px; }
    .tot-v { text-align: right; color: #111827; font-variant-numeric: tabular-nums; min-width: 95px; }
    .tot-grand td {
      background: #f3f4f6;
      font-weight: 700;
      font-size: 9.2pt;
      padding-top: 7px;
      padding-bottom: 7px;
      color: #111827;
    }

    .bottom-notes { margin-top: 24px; }
    .sec-heading { font-size: 10.5pt; color: #4b5563; font-weight: 400; margin-bottom: 4px; }
    .sec-terms-head { margin-top: 16px; }
    .sec-body { font-size: 8.5pt; color: #1f2937; white-space: pre-line; line-height: 1.45; }

    .sheet-footer { margin-top: auto; padding-top: 18px; }
    .footer-rule { border-top: 1px solid #9ca3af; }
    .footer-page { text-align: right; font-size: 7.8pt; color: #9ca3af; margin-top: 4px; }

    /* Trailing Delivery Address / Tagging Slip page */
    .slip-sheet { justify-content: flex-start; padding-top: 8mm; }
    .slip-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      border-bottom: 2px solid #111827;
      padding-bottom: 10px;
      margin-bottom: 16px;
    }
    .slip-kicker { font-size: 8.5pt; font-weight: 700; letter-spacing: 1px; color: #4b5563; }
    .slip-title { font-size: 18pt; font-weight: 700; color: #111827; margin-top: 2px; }
    .slip-order-meta { text-align: right; font-size: 9.5pt; line-height: 1.5; color: #1f2937; }
    .slip-box {
      border: 2px solid #111827;
      border-radius: 6px;
      padding: 18px 20px;
      background: #fff;
    }
    .slip-label {
      font-size: 9pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.1px;
      color: #4b5563;
      margin-bottom: 6px;
    }
    .slip-customer { font-size: 16pt; font-weight: 700; color: #111827; margin-bottom: 6px; }
    .slip-address {
      font-size: 14pt;
      line-height: 1.45;
      color: #111827;
      white-space: pre-wrap;
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid #d1d5db;
    }
    .slip-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 18px;
      font-size: 10pt;
      line-height: 1.45;
    }
    .slip-field-wide { grid-column: 1 / -1; }
    .slip-fk { font-weight: 700; color: #374151; }
    .slip-fv { color: #111827; }
    .slip-split-note {
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid #c7d2fe;
      background: #eef2ff;
      color: #1e1b4b;
      border-radius: 4px;
      font-size: 9.5pt;
    }
  </style>
</head>
<body>
  ${sheetsHtml}
  ${slipHtml}
  <script>
    (function () {
      function triggerPrint() {
        setTimeout(function () { window.focus(); window.print(); }, 200);
      }
      var imgs = Array.prototype.slice.call(document.images || []);
      if (!imgs.length) {
        window.onload = triggerPrint;
        return;
      }
      var pending = imgs.length;
      function done() { if (--pending <= 0) triggerPrint(); }
      imgs.forEach(function (img) {
        if (img.complete) done();
        else {
          img.addEventListener('load', done);
          img.addEventListener('error', done);
        }
      });
    })();
  </script>
</body>
</html>`;
}

function writeAndClosePrintWindow(win, html) {
  win.document.open();
  win.document.write(html);
  win.document.close();
}

export function openPrintableSalesOrder({
  order,
  items,
  splits = [],
  zoho_sales_orders_by_entity = {},
  entityKey = null,
  includeAddressSlip = true
}) {
  const html = buildSalesOrderPrintableHtml({
    order,
    items,
    splits,
    zoho_sales_orders_by_entity,
    entityKey,
    includeAddressSlip
  });
  const win = window.open('', '_blank', 'width=900,height=980');
  if (!win) return false;
  writeAndClosePrintWindow(win, html);
  return true;
}

export async function fetchAndPrintSalesOrder(orderId, { entityKey = null, includeAddressSlip = true, onSlipPrinted = null } = {}) {
  // Open synchronously inside click gesture so popup blockers never trigger after await.
  const win = window.open('', '_blank', 'width=900,height=980');
  if (!win) return false;
  writeAndClosePrintWindow(
    win,
    '<!doctype html><html><body style="font-family:Arial,sans-serif;padding:32px;color:#475569;font-size:13px;">Loading Zoho-formatted Sales Order &amp; Address Slip…</body></html>'
  );

  try {
    let payload;
    try {
      const { data: res } = await client.get(`/api/orders/${orderId}/printable-so`);
      payload = res?.data;
    } catch {
      const { data: res } = await client.get(`/api/orders/${orderId}`);
      payload = res?.data;
    }
    const d = payload || {};
    const html = buildSalesOrderPrintableHtml({
      order: d.order || {},
      items: d.items || [],
      splits: d.splits || [],
      zoho_sales_orders_by_entity: d.zoho_sales_orders_by_entity || {},
      entityKey,
      includeAddressSlip
    });
    writeAndClosePrintWindow(win, html);
    if (includeAddressSlip && import.meta?.env?.VITE_DR_WORKFLOW === 'true') {
      client.post(`/api/dispatch/orders/${orderId}/slip-print`)
        .then(() => { if (onSlipPrinted) onSlipPrinted(); })
        .catch(() => {});
    }
    return true;
  } catch (err) {
    win.document.open();
    win.document.write(
      `<!doctype html><html><body style="font-family:Arial,sans-serif;padding:24px;color:#b91c1c;">Could not load Sales Order: ${esc(err?.message || 'Error')}</body></html>`
    );
    win.document.close();
    return false;
  }
}
