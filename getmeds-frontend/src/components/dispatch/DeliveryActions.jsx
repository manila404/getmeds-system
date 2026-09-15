import React from 'react';
import toast from 'react-hot-toast';
import { Printer, CheckCircle2, AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';

/**
 * Print the delivery slip, and confirm the order for delivery.
 *
 * Sep 15, 2026. Dispatch prints the slip, checks the address on it, and
 * presses Confirm. Confirming only records who and when (on the order's
 * timeline) — it changes no status and sends nothing to Zoho.
 */

// Finance has confirmed these and the parcel has not left — the same list the
// server accepts a confirmation for (dispatch.controller.js FINANCE_CONFIRMED).
export const CONFIRMABLE_STATUSES = ['ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing'];

const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function slipHtml({ order, items }) {
  const e = escapeHtml;
  const contact = order.intake_contact_no || order.contact_number;
  const date = formatPHT(order.sales_order_date || order.created_at, 'date');
  const confirmed = order.delivery_confirmed_at && !order.delivery_address_changed
    ? `Confirmed in the system by ${e(order.delivery_confirmed_by)} on ${e(formatPHT(order.delivery_confirmed_at))}`
    : '';
  const rows = items.length
    ? items.map((it) => `<tr><td class="qty">${e(it.quantity)}</td><td>${e(it.name || 'Item')}</td><td class="sku">${e(it.sku || '')}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No items recorded.</td></tr>';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Delivery slip ${e(order.getmeds_order_id)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12pt; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 2mm; letter-spacing: .5px; }
  .meta { font-size: 10.5pt; color: #333; margin-bottom: 6mm; }
  .meta span { margin-right: 6mm; }
  .box { border: 1.5px solid #111; border-radius: 3mm; padding: 5mm 6mm; margin-bottom: 6mm; }
  .label { font-size: 9pt; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: #555; margin-bottom: 2mm; }
  .customer { font-size: 15pt; font-weight: bold; }
  .address { font-size: 14pt; margin: 2mm 0 3mm; white-space: pre-wrap; }
  .line { margin: 1mm 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11pt; }
  th, td { text-align: left; padding: 2mm; border-bottom: 1px solid #ccc; }
  th { font-size: 9pt; text-transform: uppercase; color: #555; }
  .qty { width: 18mm; font-weight: bold; }
  .sku { color: #555; font-family: monospace; font-size: 10pt; }
  .muted { color: #777; }
  .signs { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 12mm; }
  .sign { border-top: 1px solid #111; padding-top: 1.5mm; font-size: 10pt; }
  .confirmed { font-size: 10pt; color: #1a6b35; margin-top: 4mm; }
</style></head><body>
  <h1>GETMEDS — DELIVERY SLIP</h1>
  <div class="meta">
    <span><b>Order</b> ${e(order.getmeds_order_id)}</span>
    ${order.zoho_so_number ? `<span><b>SO</b> ${e(order.zoho_so_number)}</span>` : ''}
    <span><b>Date</b> ${e(date)}</span>
  </div>

  <div class="box">
    <div class="label">Deliver to</div>
    <div class="customer">${e(order.customer_name)}</div>
    <div class="address">${e(order.delivery_address || 'NO DELIVERY ADDRESS ON THIS ORDER')}</div>
    ${order.intake_receiver ? `<div class="line"><b>Receiver:</b> ${e(order.intake_receiver)}</div>` : ''}
    ${contact ? `<div class="line"><b>Contact no.:</b> ${e(contact)}</div>` : ''}
    ${order.intake_delivery_method ? `<div class="line"><b>Delivery method:</b> ${e(order.intake_delivery_method)}</div>` : ''}
    ${order.delivery_notes ? `<div class="line"><b>Notes:</b> ${e(order.delivery_notes)}</div>` : ''}
  </div>

  <div class="label">Items</div>
  <table><thead><tr><th>Qty</th><th>Item</th><th>SKU</th></tr></thead><tbody>${rows}</tbody></table>

  <p class="line" style="margin-top:5mm"><b>MedRep:</b> ${e(order.medrep_name || '—')}</p>
  ${confirmed ? `<p class="confirmed">${confirmed}</p>` : ''}

  <div class="signs">
    <div class="sign">Address confirmed by / Date</div>
    <div class="sign">Received by (name, signature) / Date</div>
  </div>
</body></html>`;
}

/**
 * Opens the slip in a new window and prints it. The window is opened before
 * the request, inside the click, so a pop-up blocker treats it as the user's.
 */
export async function printDeliverySlip(orderId) {
  const win = window.open('', '_blank');
  if (!win) {
    toast.error('Allow pop-ups for this site to print the delivery slip.');
    return;
  }
  win.document.write('<p style="font-family:Arial;padding:24px">Preparing the delivery slip…</p>');
  try {
    const res = await client.get(`/api/dispatch/orders/${orderId}/slip`);
    win.document.open();
    win.document.write(slipHtml(res.data.data));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  } catch (err) {
    win.close();
    toast.error(err.response?.data?.error?.message || 'Could not load the delivery slip.');
  }
}

/** Print + Confirm for one order, or the confirmation already recorded. */
const DeliveryActions = ({ order, onConfirm, busy }) => {
  const confirmed = Boolean(order.delivery_confirmed_at);
  const stale = confirmed && order.delivery_address_changed;
  const canConfirm = CONFIRMABLE_STATUSES.includes(order.status);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => printDeliverySlip(order.id)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-primary hover:bg-surface"
      >
        <Printer className="w-3.5 h-3.5" />
        Print address
      </button>

      {confirmed && !stale && (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-pharmacy-green">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Confirmed for delivery — {order.delivery_confirmed_by}, {formatPHT(order.delivery_confirmed_at, 'short-datetime')}
        </span>
      )}
      {stale && (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800">
          <AlertTriangle className="w-3.5 h-3.5" />
          Address changed since {order.delivery_confirmed_by} confirmed it
        </span>
      )}
      {canConfirm && (!confirmed || stale) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(order)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          {stale ? 'Confirm again' : 'Confirm for delivery'}
        </button>
      )}
    </div>
  );
};

export default DeliveryActions;
