import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, ExternalLink, Paperclip, AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import { attachmentLabel, HOSPITAL_REQUIRED_TYPES } from '../../constants/attachmentTypes';

/**
 * The whole order, for the person deciding whether to verify it.
 *
 * Sep 12, 2026. The Finance queue showed one document per row — the proof of
 * payment — because for a long time that was the only kind an order could
 * carry. It is now one of six, and a hospital (PAP/DSWD) order is required to
 * carry four: a Guarantee Letter, a Prescription, a Valid ID and the proof.
 *
 * So Finance was being asked to verify an account against paperwork they could
 * not see, and the row gave no hint the other files existed. Their only route
 * to them was the MedRep's order page, which is not a Finance screen.
 *
 * A modal rather than a link away to /orders/:id: verifying is a decision made
 * ON the queue, against the row. Sending someone to another page to read the
 * evidence loses their place in a list they are working down — they come back
 * to the top of it, or they do not come back.
 *
 * Two requests, deliberately:
 *   GET /orders/:id              the order and its items
 *   GET /orders/:id/attachments  every file, each with a freshly signed URL
 *
 * The second is the only endpoint that returns all types. /payment-proof,
 * which the queue row already uses, answers with just the latest proof — which
 * is precisely how the other five came to be invisible here.
 */

const peso = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const Row = ({ label, value }) =>
  value === null || value === undefined || value === '' ? null : (
    <div className="flex gap-2 text-[13px] py-1 border-b border-slate-100 last:border-0">
      <dt className="w-40 shrink-0 text-ink-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-primary break-words">{value}</dd>
    </div>
  );

const Section = ({ title, children }) => (
  <div>
    <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">{title}</h3>
    <dl className="bg-white border border-slate-200 rounded-lg px-3 py-1.5">{children}</dl>
  </div>
);

const OrderDetailsModal = ({ orderId, onClose, onConfirm, confirming }) => {
  const detail = useQuery({
    queryKey: ['finance-order-detail', orderId],
    queryFn: () => client.get(`/api/orders/${orderId}`).then((r) => r.data),
    enabled: Boolean(orderId),
  });

  const files = useQuery({
    queryKey: ['finance-order-attachments', orderId],
    queryFn: () => client.get(`/api/orders/${orderId}/attachments`).then((r) => r.data),
    enabled: Boolean(orderId),
  });

  const order = detail.data?.data?.order;
  const items = detail.data?.data?.items || [];
  const attachments = files.data?.data?.attachments || [];

  // A hospital order is the one case where a missing document actually blocks
  // something downstream, so it is the only case worth calling out. Elsewhere
  // a missing file is a normal, allowed state — see paymentProof.controller.js
  // on why the proof is a soft gate.
  const isHospital = Boolean(order?.intake_hospital);
  const missing = isHospital
    ? HOSPITAL_REQUIRED_TYPES.filter((t) => !attachments.some((a) => a.file_type === t))
    : [];

  /**
   * Confirming is the ONE thing Finance can do to an order, and it is offered
   * only at the one status where it means anything. Read from the order this
   * panel fetched rather than from the row that opened it: the row may be
   * thirty seconds stale, and this is a write.
   */
  const canConfirm = Boolean(onConfirm) && order?.status === 'ready_for_finance_verified';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
      onClick={onClose}
    >
      {/* The backdrop closes; the panel must not, or every click inside it
          dismisses the thing being read. */}
      <div
        className="bg-surface rounded-xl shadow-xl w-full max-w-4xl my-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-slate-200 bg-white rounded-t-xl flex items-start justify-between gap-3 sticky top-0 z-10">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink-primary font-mono">
              {order?.getmeds_order_id || 'Loading…'}
            </h2>
            {order && (
              <p className="text-xs text-ink-secondary mt-0.5 truncate">
                {order.customer_name}
                {order.medrep_name ? ` · ${order.medrep_name}` : ''}
                {order.raised_by_name ? ` (raised by ${order.raised_by_name})` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {order && (
              <a
                href={`/orders/${order.getmeds_order_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
              >
                Full page <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary" title="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {detail.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-ink-secondary text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading the order…
          </div>
        ) : detail.isError ? (
          <div className="px-5 py-12 text-center">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-state-error" />
            <p className="text-sm text-ink-primary">This order could not be loaded.</p>
            <p className="text-xs text-ink-secondary mt-1">
              {detail.error?.response?.data?.error?.message || detail.error?.message}
            </p>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            {missing.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-state-warning bg-state-warning-light px-3 py-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-900" />
                <p className="text-[12px] text-amber-950">
                  <span className="font-semibold">
                    Hospital order missing {missing.length} required document
                    {missing.length > 1 ? 's' : ''}:
                  </span>{' '}
                  {missing.map(attachmentLabel).join(', ')}. Worth chasing before verifying — these are
                  what the hospital reimburses against.
                </p>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="Order">
                <Row label="Status" value={String(order.status || '').replace(/_/g, ' ')} />
                <Row label="Total" value={<span className="font-semibold">{peso(order.total_amount)}</span>} />
                <Row label="Customer type" value={order.customer_type} />
                <Row label="Sales order date" value={order.sales_order_date} />
                <Row label="Submitted" value={order.submitted_at ? formatPHT(order.submitted_at) : null} />
                <Row label="Division" value={order.division} />
                <Row label="Sub-division" value={order.sub_division} />
                <Row label="Salesperson" value={order.salesperson} />
              </Section>

              <Section title="Payment & terms">
                <Row label="Mode of payment" value={order.intake_mop} />
                <Row label="Payment terms" value={order.intake_payment_terms} />
                <Row label="Terms" value={order.intake_terms} />
                <Row label="Invoicing from" value={order.invoicing_from} />
                <Row label="TIN" value={order.intake_tin} />
                <Row label="Zoho SO" value={order.zoho_so_number} />
                <Row label="Zoho invoice" value={order.zoho_invoice_number} />
                {/* The two fields that explain an order with no proof at all. */}
                <Row label="No-proof reason" value={order.no_payment_proof_reason} />
                <Row label="No-proof note" value={order.no_payment_proof_note} />
              </Section>

              <Section title="Delivery">
                <Row label="Address" value={order.delivery_address} />
                <Row label="Notes" value={order.delivery_notes} />
                <Row label="Method" value={order.intake_delivery_method} />
                <Row label="Courier" value={order.intake_courier} />
                <Row label="Expected shipment" value={order.intake_expected_shipment_date} />
                <Row label="Receiver" value={order.intake_receiver} />
                <Row label="Receiver type" value={order.intake_receiver_type} />
                <Row label="Contact no." value={order.intake_contact_no || order.contact_number} />
              </Section>

              <Section title="Patient & hospital">
                <Row label="Hospital" value={order.intake_hospital} />
                <Row label="Patient" value={order.intake_patient} />
                <Row label="Doctor" value={order.intake_doctor} />
                <Row label="GL number" value={order.intake_gl_number} />
                <Row label="Source" value={order.intake_source} />
                <Row label="Pls give" value={order.intake_pls_give} />
              </Section>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
                Items ({items.length})
              </h3>
              <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                <table className="min-w-full text-[13px]">
                  <thead className="bg-surface">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-ink-secondary">Product</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Qty</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Unit</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Disc.</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Line total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((it) => (
                      <tr key={it.id}>
                        <td className="px-3 py-2 text-ink-primary">
                          {it.product_name}
                          {it.sku && <span className="block text-[11px] text-ink-secondary">{it.sku}</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-primary">{it.quantity}</td>
                        <td className="px-3 py-2 text-right text-ink-primary">{peso(it.unit_price)}</td>
                        <td className="px-3 py-2 text-right text-ink-secondary">
                          {Number(it.discount_amount) ? peso(it.discount_amount) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-ink-primary">
                          {peso(it.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-surface">
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-right font-medium text-ink-secondary">
                        Grand total
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-ink-primary">
                        {peso(order.total_amount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
                Attachments ({attachments.length})
              </h3>

              {files.isLoading ? (
                <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-4 text-[13px] text-ink-secondary">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading files…
                </div>
              ) : files.isError ? (
                <div className="bg-white border border-state-error/40 rounded-lg px-3 py-4 text-[13px] text-ink-primary">
                  The files on this order could not be loaded. The order details above are still accurate.
                </div>
              ) : attachments.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-lg px-3 py-4 text-[13px] text-ink-secondary">
                  No files on this order.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {attachments.map((a) => {
                    const isImage = String(a.content_type || '').startsWith('image/');
                    return (
                      <a
                        key={a.id}
                        href={a.viewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-getmeds-blue transition-colors"
                      >
                        {/* Images preview inline; a PDF or scanned document
                            gets an honest placeholder rather than a broken
                            <img> that reads as a failed upload. */}
                        {isImage ? (
                          <img
                            src={a.viewUrl}
                            alt={a.file_name}
                            className="w-full h-32 object-cover bg-slate-50"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-32 flex items-center justify-center bg-slate-50">
                            <FileText className="w-8 h-8 text-ink-secondary" />
                          </div>
                        )}
                        <div className="px-2.5 py-2">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-getmeds-blue-dark">
                            {attachmentLabel(a.file_type)}
                          </p>
                          <p className="text-[12px] text-ink-primary truncate" title={a.file_name}>
                            {a.file_name}
                          </p>
                          <p className="text-[11px] text-ink-secondary mt-0.5">
                            {a.uploaded_by_name || 'Unknown'}
                            {a.uploaded_at ? ` · ${formatPHT(a.uploaded_at)}` : ''}
                          </p>
                          {/* Only the proof of payment carries a Finance
                              decision; the other types are evidence, not
                              something to approve. */}
                          {a.file_type === 'payment_proof' && a.status && (
                            <p
                              className={`text-[11px] mt-1 font-semibold ${
                                a.status === 'verified'
                                  ? 'text-pharmacy-green-dark'
                                  : a.status === 'rejected'
                                    ? 'text-red-700'
                                    : 'text-amber-900'
                              }`}
                            >
                              {a.status === 'verified'
                                ? 'Verified'
                                : a.status === 'rejected'
                                  ? `Rejected${a.rejection_reason ? ` — ${a.rejection_reason}` : ''}`
                                  : 'Awaiting your check'}
                            </p>
                          )}
                        </div>
                      </a>
                    );
                  })}
                </div>
              )}

              <p className="flex items-center gap-1.5 text-[11px] text-ink-secondary mt-2">
                <Paperclip className="w-3 h-3 shrink-0" />
                Links are signed and short-lived — reopen this panel if one stops working.
              </p>
            </div>
          </div>
        )}

        <div className="px-5 py-3 border-t border-slate-200 bg-white rounded-b-xl flex items-center justify-between gap-3">
          {/* Says why there is no Confirm button, rather than leaving its
              absence to be read as the panel being broken. */}
          <p className="text-[11px] text-ink-secondary min-w-0">
            {canConfirm
              ? 'Confirming clears this order to be invoiced in Zoho.'
              : order?.status === 'ready_for_finance_verified'
                ? ''
                : 'Not awaiting Finance — nothing to confirm at this stage.'}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-slate-200 text-sm font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
            >
              Close
            </button>
            {canConfirm && (
              <button
                onClick={() => onConfirm(order.id)}
                disabled={confirming}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-pharmacy-green text-white text-sm font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {confirming ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                Confirm account
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OrderDetailsModal;
