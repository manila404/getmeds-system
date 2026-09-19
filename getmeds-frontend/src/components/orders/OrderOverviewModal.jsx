import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip, Download } from 'lucide-react';
import Modal from '../ui/Modal';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import { attachmentLabel } from '../../constants/attachmentTypes';

/**
 * The whole order on one screen, read-only — the same layout as the order
 * form's "Confirm Requisition Submission" review.
 *
 * Sep 15, 2026. A MedRep checks everything in that review before submitting,
 * and afterwards had no way back to it: the order page spreads the same facts
 * over a header, a details grid and four tabs. This is that review again, for
 * an order that already exists — customer, route, delivery, the details,
 * attachments and the line items with their total.
 */

const NO_PROOF_REASONS = {
  on_payment_terms: 'Customer is on payment terms',
  payment_to_follow: 'Payment to follow',
  paid_no_slip: 'Paid — no slip issued',
  other: 'Other'
};

const peso = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const Line = ({ label, children, top = false }) =>
  children === null || children === undefined || children === '' ? null : (
    <div className={`flex justify-between gap-4 ${top ? 'items-start pt-2 border-t border-slate-200' : 'items-center'}`}>
      <span className="text-xs text-ink-secondary font-medium shrink-0">{label}:</span>
      <span className="font-medium text-ink-primary text-right break-words">{children}</span>
    </div>
  );

const taxLabel = (it) => {
  const pct = Number(it.tax_percent) || 0;
  if (it.tax_label) return `${it.tax_label} (${pct}%)`;
  return pct > 0 ? `VAT ${pct}%` : 'No Tax';
};

const OrderOverviewModal = ({ order, items = [], onClose }) => {
  // Its own cache key: the Attachments tab caches this endpoint in a
  // different shape, and sharing a key would hand one the other's data.
  const files = useQuery({
    queryKey: ['order-overview-attachments', order.id],
    queryFn: () => client.get(`/api/orders/${order.id}/attachments`).then((r) => r.data?.data?.attachments || [])
  });
  const attachments = files.data || [];
  const hasProof = attachments.some((a) => a.file_type === 'payment_proof');

  const details = [
    ['Delivery Method', order.intake_delivery_method],
    ['Expected Shipment', order.intake_expected_shipment_date],
    ['Doctor', order.intake_doctor],
    ['Customer is the doctor', order.intake_is_doctor === 1 ? 'Yes' : order.intake_is_doctor === 0 ? 'No' : ''],
    ['TIN', order.intake_tin],
    ['GL Number', order.intake_gl_number],
    ['Receiver Type', order.intake_receiver_type === 'patient' ? 'Patient' : order.intake_receiver_type === 'representative' ? 'Representative' : ''],
    ['Receiver', order.intake_receiver],
    ['Contact No.', order.intake_contact_no],
    ['Terms & Conditions', order.intake_terms],
    ['Zoho Sales Order', order.zoho_so_number]
  ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');

  return (
    <Modal isOpen onClose={onClose} title={`Order overview — ${order.getmeds_order_id}`}>
      <div className="space-y-4 text-sm text-ink-primary max-h-[70vh] overflow-y-auto pr-1 -mr-1">
        <div className="bg-surface rounded-xl p-4 space-y-2.5 border border-slate-200">
          <Line label="Customer"><span className="font-bold">{order.customer_name || 'N/A'}</span></Line>
          <Line label="Account Type">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                order.customer_type === 'credit'
                  ? 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30'
                  : 'bg-state-warning-light text-amber-950 border border-state-warning/30'
              }`}
            >
              {order.customer_type === 'credit' ? '🏦 Credit Customer' : '💳 Direct Patient'}
            </span>
          </Line>
          <Line label="Status"><span className="capitalize">{String(order.status || '').replace(/_/g, ' ')}</span></Line>
          <Line label="Sales Order Date">{order.sales_order_date || formatPHT(order.created_at, 'date')}</Line>
          <Line label="MedRep">
            {order.medrep_name}
            {order.raised_by_id && order.raised_by_name ? ` (raised by ${order.raised_by_name})` : ''}
          </Line>
          <Line label="Salesperson">{order.salesperson}</Line>
          <Line label="Division">{order.division || '—'}</Line>
          <Line label="Sub-division">{order.sub_division}</Line>
          <Line label="Headquarter">{order.headquarter}</Line>
          <Line label="Source">{order.intake_source}</Line>
          <Line label="Invoicing From">{order.invoicing_from}</Line>
          <Line label="Payment Terms">{order.intake_payment_terms}</Line>
          <Line label="Delivery Address" top>{order.delivery_address}</Line>
          {order.delivery_notes && (
            <div className="flex justify-between items-start gap-4">
              <span className="text-xs text-ink-secondary font-medium shrink-0">Remarks:</span>
              <span className="text-ink-secondary text-right italic break-words">{order.delivery_notes}</span>
            </div>
          )}
        </div>

        {details.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Additional Details</h4>
            <div className="bg-surface rounded-xl p-4 space-y-2 border border-slate-200">
              {details.map(([label, value]) => (
                <div key={label} className="flex justify-between items-start gap-4">
                  <span className="text-xs text-ink-secondary font-medium shrink-0">{label}:</span>
                  <span className="text-ink-primary text-right break-words">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Attachments</h4>
          <div className="bg-surface rounded-xl p-3 border border-slate-200 text-xs text-ink-primary space-y-1.5">
            {files.isLoading && <span className="text-ink-secondary">Loading…</span>}
            {attachments.map((a) => (
              <div key={a.id} className="flex items-center gap-1.5">
                <a
                  href={a.viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 min-w-0 hover:text-getmeds-blue"
                >
                  <Paperclip size={11} className="text-ink-secondary shrink-0" />
                  <span className="truncate">{a.file_name}</span>
                  <span className="text-ink-secondary shrink-0">({attachmentLabel(a.file_type)})</span>
                </a>
                {/* Sep 19, 2026: download for all users, alongside view. */}
                {a.downloadUrl && (
                  <a href={a.downloadUrl} title={`Download ${a.file_name || 'file'}`} className="shrink-0 text-ink-secondary hover:text-getmeds-blue">
                    <Download size={11} />
                  </a>
                )}
              </div>
            ))}
            {!files.isLoading && !hasProof && (
              <span className="flex items-center gap-1.5">
                No proof of payment
                {order.no_payment_proof_reason
                  ? ` — ${NO_PROOF_REASONS[order.no_payment_proof_reason] || order.no_payment_proof_reason}`
                  : ''}
                {order.no_payment_proof_note && <span className="text-ink-secondary"> · {order.no_payment_proof_note}</span>}
              </span>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">
            Order Line Items
            <span className="ml-2 normal-case font-medium tracking-normal">
              · {order.is_inclusive_tax === 1 || order.is_inclusive_tax === true ? 'Tax Inclusive' : 'Tax Exclusive'}
            </span>
          </h4>
          <div className="border border-slate-200 rounded-xl overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-surface">
                <tr>
                  <th className="px-3 py-2 text-left font-bold text-ink-secondary">Item</th>
                  <th className="px-2 py-2 text-center font-bold text-ink-secondary">Qty</th>
                  <th className="px-3 py-2 text-right font-bold text-ink-secondary">Price</th>
                  <th className="px-3 py-2 text-right font-bold text-ink-secondary">Discount</th>
                  <th className="px-3 py-2 text-center font-bold text-ink-secondary">Tax</th>
                  <th className="px-3 py-2 text-right font-bold text-ink-secondary">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-3 py-2 font-medium text-ink-primary">
                      {it.product_name} {it.sku && <span className="text-ink-secondary">({it.sku})</span>}
                      {it.price_remark && (
                        <span className="block text-[11px] font-normal text-ink-secondary italic mt-0.5">💬 {it.price_remark}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center text-ink-primary font-bold">{it.quantity}</td>
                    <td className="px-3 py-2 text-right text-ink-secondary">{peso(it.unit_price)}</td>
                    <td className="px-3 py-2 text-right text-ink-secondary">
                      {Number(it.discount_amount) > 0 ? `-${peso(it.discount_amount)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-ink-secondary">{taxLabel(it)}</td>
                    <td className="px-3 py-2 text-right font-bold text-ink-primary">{peso(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface">
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-right font-bold text-ink-primary">Grand Total:</td>
                  <td className="px-3 py-2 text-right font-extrabold text-getmeds-blue text-sm">{peso(order.total_amount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-3 mt-3 border-t border-slate-100">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 border border-slate-200 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
        >
          Close
        </button>
      </div>
    </Modal>
  );
};

export default OrderOverviewModal;
