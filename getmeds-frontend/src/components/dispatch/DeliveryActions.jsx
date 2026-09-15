import React, { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Printer, CheckCircle2, AlertTriangle, PauseCircle, PlayCircle, Camera, Truck } from 'lucide-react';
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
// Where the tracking number can be put on hold: the same, plus shipped from
// Zoho but no tracking number yet (dispatch.controller.js TRACKING_HOLDABLE).
export const TRACKING_HOLDABLE_STATUSES = [...CONFIRMABLE_STATUSES, 'dispatched'];
// Where Dispatch can attach a proof photo: from Finance's confirmation until
// the order is done (paymentProof.controller.js DISPATCH_PROOF_STATUSES).
export const DISPATCH_PROOF_STATUSES = [...TRACKING_HOLDABLE_STATUSES, 'tracking_shared', 'completed'];
// Where a tracking number can be added or updated (dispatch.controller.js
// TRACKING_EDITABLE) — the same span as the proof photo.
export const TRACKING_EDITABLE_STATUSES = DISPATCH_PROOF_STATUSES;

// The file types the server accepts (services/paymentProofStorage.js), minus
// the office documents — a proof here is a photo or a scan.
const PROOF_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';

/**
 * Sep 15, 2026: one dispatch proof, through the same three steps as every
 * attachment — ask for a signed URL, PUT the file straight to storage (plain
 * fetch, so our session token never goes to another origin), confirm. The
 * server then attaches it to the Zoho Sales Order and tells the MedRep.
 */
async function uploadDispatchProof(orderId, file) {
  const meta = { contentType: file.type, fileName: file.name, fileSize: file.size, file_type: 'dispatch_proof' };
  const { data: urlRes } = await client.post(`/api/orders/${orderId}/attachments/upload-url`, meta);
  const { signedUrl, storagePath } = urlRes.data;
  const put = await fetch(signedUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  if (!put.ok) throw new Error(`Upload to storage failed (${put.status}). Nothing was recorded — try again.`);
  const { data: res } = await client.post(`/api/orders/${orderId}/attachments`, { ...meta, storagePath });
  return res.data;
}

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

/**
 * Print + Confirm for one order, or the confirmation already recorded — and,
 * once confirmed, putting the tracking number on hold (Sep 15, 2026).
 */
const DeliveryActions = ({ order, onConfirm, onHold, onAddTracking, busy }) => {
  const confirmed = Boolean(order.delivery_confirmed_at);
  const stale = confirmed && order.delivery_address_changed;
  const canConfirm = CONFIRMABLE_STATUSES.includes(order.status);
  const hold = order.tracking_hold;
  const entered = order.entered_tracking;
  // The tracking number can be added on any order Dispatch has that does not
  // have one yet — confirmed or not (Sep 15, 2026: Dispatch asked to add it
  // straight from the list). Putting it on hold follows the confirmation (or
  // a shipment from Zoho without a number), since "not ready yet" answers the
  // confirm step.
  const trackingFree =
    !order.tracking_number && !entered && TRACKING_HOLDABLE_STATUSES.includes(order.status);
  const canHold = Boolean(onHold) && trackingFree && !hold &&
    ((confirmed && !stale) || order.status === 'dispatched');
  // Add, or update one Dispatch typed in earlier — never over Zoho's own.
  const canAddTracking = Boolean(onAddTracking) && !order.tracking_number && TRACKING_EDITABLE_STATUSES.includes(order.status);

  // Sep 15, 2026: the proof photo. Several can be picked at once; they go up
  // one after another, and the toast says what reached Zoho.
  const qc = useQueryClient();
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const canUploadProof = DISPATCH_PROOF_STATUSES.includes(order.status);
  const onProofPicked = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    let saved = 0;
    const notInZoho = [];
    const failed = [];
    for (const file of files) {
      try {
        const res = await uploadDispatchProof(order.id, file);
        saved += 1;
        if (!res?.zoho_pushed) notInZoho.push(file.name);
      } catch (err) {
        failed.push(`${file.name}: ${err.response?.data?.error?.message || err.message}`);
      }
    }
    setUploading(false);
    qc.invalidateQueries({ queryKey: ['finance-order-attachments', order.id] });
    qc.invalidateQueries({ queryKey: ['order-attachments', order.id] });
    if (saved) {
      const where = notInZoho.length
        ? ` Saved, but not attached in Zoho yet: ${notInZoho.join(', ')}.`
        : ' Attached to the Sales Order in Zoho.';
      toast.success(`${saved} proof photo${saved === 1 ? '' : 's'} uploaded.${where} The MedRep was notified.`, { duration: 7000 });
    }
    if (failed.length) toast.error(`Not uploaded — ${failed.join('; ')}`, { duration: 10000 });
  };

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

      {hold && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900"
          title={hold.note || ''}
        >
          <PauseCircle className="w-3.5 h-3.5" />
          Tracking on hold — {hold.reason}
          <span className="font-normal text-amber-900/80">({hold.by}, {formatPHT(hold.at, 'short-datetime')})</span>
        </span>
      )}
      {entered && (
        <span className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-800">
          <Truck className="w-3.5 h-3.5" />
          Tracking: {entered.courier} · <span className="font-mono">{entered.tracking_number}</span>
          <span className="font-normal text-teal-800/80">({entered.by}, {formatPHT(entered.at, 'short-datetime')})</span>
        </span>
      )}
      {canAddTracking && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAddTracking(order)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-white text-xs font-semibold disabled:opacity-50 ${
            hold ? 'border-amber-400 text-amber-900 hover:bg-amber-50' : 'border-slate-300 text-ink-primary hover:bg-surface'
          }`}
        >
          <PlayCircle className="w-3.5 h-3.5" />
          {entered ? 'Update tracking' : 'Add tracking number'}
        </button>
      )}
      {canHold && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onHold(order)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-primary hover:bg-surface disabled:opacity-50"
        >
          <PauseCircle className="w-3.5 h-3.5" />
          Hold tracking number
        </button>
      )}

      {canUploadProof && (
        <>
          <input ref={fileInput} type="file" accept={PROOF_ACCEPT} multiple className="hidden" onChange={onProofPicked} />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            title="Photo of the packed parcel, the waybill or a signed receipt — attached to the Zoho Sales Order, and the MedRep is told"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-primary hover:bg-surface disabled:opacity-50"
          >
            <Camera className="w-3.5 h-3.5" />
            {uploading ? 'Uploading…' : 'Upload proof photo'}
          </button>
        </>
      )}
    </div>
  );
};

export default DeliveryActions;
