import React from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { Printer, X } from 'lucide-react';
import client from '../../api/client';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function buildDrPrintableHtml(drData) {
  const { receipt, entity_profile: profile, pages = [[]], signatory } = drData;
  const pageHtml = pages.map((rows, pageIdx) => {
    const padded = [...rows];
    while (padded.length < 11) padded.push(null);
    return `
      <div class="sheet" style="${pageIdx < pages.length - 1 ? 'page-break-after: always;' : ''}">
        <div class="head">
          <div>
            <div class="company">${esc(profile?.legal_name || receipt.entity_key)}</div>
            <div class="sub">${esc(profile?.address_line_1 || profile?.address || '')}</div>
            ${profile?.address_line_2 ? `<div class="sub">${esc(profile.address_line_2)}</div>` : ''}
            ${(profile?.email || profile?.tel) ? `<div class="sub">${profile?.email ? `Email: ${esc(profile.email)}` : ''}${profile?.email && profile?.tel ? ' &nbsp;&nbsp; ' : ''}${profile?.tel ? `Tel No. ${esc(profile.tel)}` : ''}</div>` : ''}
            <div class="sub">${esc(profile?.tin || '')}</div>
          </div>
          <div class="dr-box">
            <div class="dr-label">DELIVERY RECEIPT</div>
            <div class="dr-num">No. ${esc(receipt.dr_number)}</div>
            <div class="pg">Page ${pageIdx + 1} of ${pages.length}</div>
          </div>
        </div>
        <div class="meta-grid">
          <div>
            <div><b>DELIVERED TO:</b> ${esc(receipt.customer_name)}</div>
            <div><b>ADDRESS:</b> ${esc(receipt.delivery_address || '—')}</div>
            <div><b>TIN:</b> ${esc(receipt.tin || '—')} &nbsp;·&nbsp; <b>LTO:</b> ${esc(receipt.lto_license_number || '—')}</div>
          </div>
          <div>
            <div><b>DATE:</b> ${esc(receipt.date_issued)}</div>
            <div><b>TERMS:</b> ${esc(receipt.terms || '—')}</div>
            <div><b>SI / REF NO.:</b> ${esc(receipt.si_number || receipt.external_ref || '—')}</div>
            <div><b>${receipt.reference_type === 'transfer_order' ? 'TYPE:' : 'DOCTOR:'}</b> ${esc(receipt.reference_type === 'transfer_order' ? 'Warehouse Transfer' : (receipt.doctor_name || 'NNH'))}</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th style="width:70px;">Item No.</th>
              <th style="width:70px;">Qty</th>
              <th style="width:75px;">Unit</th>
              <th>ARTICLES (Medicine, Batch # &amp; Expiry Date)</th>
            </tr>
          </thead>
          <tbody>
            ${padded.map((it) => it ? `
              <tr>
                <td>${esc(it.item_seq_no)}</td>
                <td><b>${esc(it.quantity)}</b></td>
                <td>${esc(it.unit || 'pc')}</td>
                <td>${esc(it.item_name)}</td>
              </tr>
            ` : '<tr><td>&nbsp;</td><td></td><td></td><td></td></tr>').join('')}
          </tbody>
        </table>
        <div class="sig-grid">
          <div class="sig-left">
            <div class="sig-box top"><b>${esc(signatory?.issued_by_label || 'Issued by:')}</b> ${esc(signatory?.issued_by_name || '')}</div>
            <div class="sig-box"><b>${esc(signatory?.delivered_by_label || 'Delivered by:')}</b></div>
          </div>
          <div class="sig-right">
            <div class="sig-decl">${esc(signatory?.receiver_declaration || 'Received the above goods in good order and condition.')}</div>
            <div class="sig-line">${esc(signatory?.signature_label || "Customer's Signature over Printed Name")}</div>
          </div>
        </div>
        <div class="disclaimer">${esc(signatory?.disclaimer || '"THIS DOCUMENTS IS NOT VALID FOR CLAIM OF INPUT TAX"')}</div>
      </div>
    `;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>DR #${esc(receipt.dr_number)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 10.5pt; margin: 0; }
    .sheet { padding: 4mm; }
    .head { display: flex; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 3mm; margin-bottom: 3mm; }
    .company { font-size: 14pt; font-weight: bold; }
    .sub { font-size: 8.5pt; color: #444; margin-top: 1mm; }
    .dr-box { text-align: right; }
    .dr-label { font-size: 9pt; font-weight: bold; }
    .dr-num { font-size: 16pt; font-weight: bold; color: #b91c1c; font-family: monospace; }
    .pg { font-size: 8pt; color: #555; }
    .meta-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 4mm; margin-bottom: 3mm; font-size: 9.5pt; line-height: 1.4; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #111; padding: 1.5mm 2mm; text-align: left; font-size: 9.5pt; }
    th { background: #f1f5f9; font-size: 8.5pt; text-transform: uppercase; }
    .sig-grid { display: grid; grid-template-columns: 1fr 1fr; border: 1.5px solid #111; margin-top: 3mm; font-size: 9pt; }
    .sig-left { border-right: 1.5px solid #111; }
    .sig-box { padding: 2mm 3mm 6mm; }
    .sig-box.top { border-bottom: 1.5px solid #111; }
    .sig-right { display: flex; flex-direction: column; justify-content: space-between; }
    .sig-decl { padding: 2mm 3mm 8mm; font-style: italic; font-weight: bold; }
    .sig-line { border-top: 1.5px solid #111; padding: 1.5mm 2mm; text-align: center; font-weight: 600; font-size: 8.5pt; }
    .disclaimer { text-align: center; font-weight: bold; font-size: 8.5pt; margin-top: 2mm; }
  </style></head><body>${pageHtml}</body></html>`;
}

const DrPrintVoucherModal = ({ drData, onClose, onPrinted, sideBySide = false }) => {
  if (!drData?.receipt) return null;
  const { receipt, entity_profile: profile, pages = [[]], signatory } = drData;

  const handlePrint = async () => {
    try {
      const { data: res } = await client.post(`/api/dispatch/dr/${receipt.id}/print`);
      if (onPrinted) onPrinted(res.data);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not record print audit, opening print preview.');
    }
    const w = window.open('', '_blank', 'width=900,height=720');
    if (!w) {
      toast.error('Pop-up blocked — allow pop-ups to print DR voucher.');
      return;
    }
    w.document.open();
    w.document.write(buildDrPrintableHtml(drData));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };

  return createPortal(
    <div className={`fixed inset-0 z-[70] bg-slate-900/50 flex items-center p-3 sm:p-4 ${
      sideBySide ? 'justify-center lg:justify-start lg:pr-[37rem]' : 'justify-center'
    }`}>
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
        <div className="px-5 py-3.5 bg-surface border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-ink-primary">
              {receipt.entity_key} Delivery Receipt #{receipt.dr_number}
              {receipt.status === 'void' && (
                <span className="ml-2 px-2 py-0.5 text-xs font-bold rounded bg-red-100 text-red-700">VOID</span>
              )}
            </h3>
            <p className="text-xs text-ink-secondary">
              {pages.length} printable sheet(s) · max 11 rows per sheet
              {receipt.printed_by_name ? ` · Last printed by ${receipt.printed_by_name}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              disabled={receipt.status === 'void'}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
            >
              <Printer className="w-4 h-4" /> Print DR Voucher
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md border border-slate-300 bg-white text-ink-secondary hover:text-ink-primary">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto space-y-6 bg-slate-100">
          {pages.map((rows, pageIdx) => (
            <div key={pageIdx} className="bg-white border-2 border-slate-800 rounded p-5 shadow-sm text-xs">
              <div className="flex justify-between border-b-2 border-slate-800 pb-3 mb-3">
                <div>
                  <div className="text-base font-bold text-slate-900">{profile?.legal_name}</div>
                  <div className="text-[11px] text-slate-700 leading-tight">{profile?.address_line_1 || profile?.address}</div>
                  {profile?.address_line_2 && (
                    <div className="text-[11px] text-slate-700 leading-tight">{profile.address_line_2}</div>
                  )}
                  {(profile?.email || profile?.tel) && (
                    <div className="text-[11px] text-slate-700 leading-tight">
                      {profile?.email ? `Email: ${profile.email}` : ''}
                      {profile?.email && profile?.tel ? '   ' : ''}
                      {profile?.tel ? `Tel No. ${profile.tel}` : ''}
                    </div>
                  )}
                  <div className="text-[11px] font-medium text-slate-800 leading-tight">{profile?.tin}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-[11px] text-slate-700">DELIVERY RECEIPT</div>
                  <div className="text-xl font-bold font-mono text-red-700">No. {receipt.dr_number}</div>
                  <div className="text-[10px] text-slate-500">Page {pageIdx + 1} of {pages.length}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3 text-xs">
                <div className="sm:col-span-2 space-y-0.5">
                  <div><b>DELIVERED TO:</b> {receipt.customer_name}</div>
                  <div><b>ADDRESS:</b> {receipt.delivery_address || '—'}</div>
                  <div><b>TIN:</b> {receipt.tin || '—'} · <b>LTO:</b> {receipt.lto_license_number || '—'}</div>
                </div>
                <div className="space-y-0.5">
                  <div><b>DATE:</b> {receipt.date_issued}</div>
                  <div><b>TERMS:</b> {receipt.terms || '—'}</div>
                  <div><b>SI / REF:</b> {receipt.si_number || receipt.external_ref || '—'}</div>
                  <div><b>DOCTOR:</b> {receipt.doctor_name || 'NNH'}</div>
                </div>
              </div>

              <table className="w-full border-collapse border border-slate-800">
                <thead>
                  <tr className="bg-slate-100 text-[11px] uppercase">
                    <th className="border border-slate-800 px-2 py-1 text-left w-16">Item No.</th>
                    <th className="border border-slate-800 px-2 py-1 text-left w-16">Qty</th>
                    <th className="border border-slate-800 px-2 py-1 text-left w-20">Unit</th>
                    <th className="border border-slate-800 px-2 py-1 text-left">ARTICLES (With Batch &amp; Expiry)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((it) => (
                    <tr key={it.id || it.item_seq_no}>
                      <td className="border border-slate-800 px-2 py-1 font-mono">{it.item_seq_no}</td>
                      <td className="border border-slate-800 px-2 py-1 font-semibold">{it.quantity}</td>
                      <td className="border border-slate-800 px-2 py-1">{it.unit || 'pc'}</td>
                      <td className="border border-slate-800 px-2 py-1">{it.item_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="grid grid-cols-2 border border-slate-800 mt-3 text-[11px]">
                <div className="border-r border-slate-800">
                  <div className="p-2 pb-5 border-b border-slate-800">
                    <b>{signatory?.issued_by_label}</b> {signatory?.issued_by_name}
                  </div>
                  <div className="p-2 pb-5">
                    <b>{signatory?.delivered_by_label}</b>
                  </div>
                </div>
                <div className="flex flex-col justify-between">
                  <div className="p-2 pb-6 italic font-semibold">{signatory?.receiver_declaration}</div>
                  <div className="border-t border-slate-800 py-1 px-2 text-center font-semibold">
                    {signatory?.signature_label}
                  </div>
                </div>
              </div>
              <div className="text-center font-bold text-[10px] mt-1.5 tracking-wide">
                {signatory?.disclaimer}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default DrPrintVoucherModal;
