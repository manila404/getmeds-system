import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, FileText, ExternalLink, Paperclip, AlertTriangle, Loader2, ShieldCheck, XCircle, Download } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import { attachmentLabel, HOSPITAL_REQUIRED_TYPES } from '../../constants/attachmentTypes';

// Sep 22, 2026: split-invoicing orders — a line item tagged to the other
// entity creates a second Zoho Sales Order (order_split_sales_orders), which
// Finance must verify independently of the primary (two entities, two bank
// accounts — see orderSplitService.js). This panel is the one place that
// already loads the order's full detail (including `splits`), so the second
// Verify action lives here rather than duplicating the fetch elsewhere.
const SplitVerifyRow = ({ orderId, split, canAct }) => {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: ({ approved, reason: r }) =>
      client
        .post(`/api/finance/orders/${orderId}/splits/${split.id}/verify`, { approved, reason: r })
        .then((res) => res.data),
    onSuccess: (res) => {
      const zohoConfirm = res?.data?.zohoConfirmed;
      if (res?.data?.approved && zohoConfirm && zohoConfirm.ok === false) {
        toast.error(
          `${split.invoicing_from} verified — but its Sales Order is not confirmed in Zoho yet (${zohoConfirm.error || 'Zoho did not answer'}).`,
          { duration: 9000 }
        );
      } else if (res?.data?.approved) {
        const awaiting = res?.data?.awaitingOtherEntities || [];
        toast.success(
          awaiting.length
            ? `${split.invoicing_from} verified — still awaiting ${awaiting.join(', ')}.`
            : `${split.invoicing_from} verified — every entity is now cleared to invoice.`
        );
      } else {
        toast.success(`${split.invoicing_from} put on hold — the whole order is held.`);
      }
      setRejecting(false);
      setReason('');
      qc.invalidateQueries({ queryKey: ['finance-order-detail', orderId] });
      qc.invalidateQueries({ queryKey: ['finance-queue'] });
      qc.invalidateQueries({ queryKey: ['order', String(orderId)] });
    },
    onError: (err) =>
      toast.error(err.response?.data?.error?.message || 'Could not record that'),
  });

  const isPending = split.payment_status === 'pending';
  const statusColor =
    split.payment_status === 'verified'
      ? 'text-pharmacy-green-dark'
      : split.payment_status === 'rejected'
        ? 'text-red-700'
        : 'text-amber-900';

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-primary">{split.invoicing_from}</p>
        <span className={`text-[11px] font-semibold capitalize ${statusColor}`}>{split.payment_status}</span>
      </div>
      <dl className="text-[12px] text-ink-secondary space-y-0.5">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0">Zoho SO</dt>
          <dd className="text-ink-primary">{split.zoho_so_number || (split.zoho_sync_error ? `Not synced — ${split.zoho_sync_error}` : '—')}</dd>
        </div>
        {split.zoho_invoice_number && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0">Zoho invoice</dt>
            <dd className="text-ink-primary">{split.zoho_invoice_number}</dd>
          </div>
        )}
      </dl>
      {isPending && !canAct && (
        <p className="text-[11px] text-ink-secondary pt-1">Awaiting Finance's verification of this entity.</p>
      )}
      {isPending && canAct && (
        rejecting ? (
          <div className="space-y-1.5 pt-1">
            <textarea
              autoFocus
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this entity's payment being held?"
              className="w-full text-xs rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex gap-2">
              <button
                disabled={!reason.trim() || mutation.isPending}
                onClick={() => mutation.mutate({ approved: false, reason: reason.trim() })}
                className="px-2.5 py-1 rounded-md bg-state-error text-white text-[11px] font-semibold disabled:opacity-50"
              >
                {mutation.isPending ? 'Holding…' : 'Put on hold'}
              </button>
              <button
                onClick={() => { setRejecting(false); setReason(''); }}
                className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-[11px] text-ink-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ approved: true })}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-pharmacy-green text-white text-[11px] font-semibold hover:opacity-90 disabled:opacity-50"
            >
              <ShieldCheck className="w-3 h-3" /> {mutation.isPending ? 'Verifying…' : 'Verify'}
            </button>
            <button
              disabled={mutation.isPending}
              onClick={() => setRejecting(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-state-error/40 text-state-error text-[11px] font-semibold hover:bg-state-error-light disabled:opacity-50"
            >
              <XCircle className="w-3 h-3" /> Hold
            </button>
          </div>
        )
      )}
    </div>
  );
};

// Sep 22, 2026: the primary entity's own card in the "Split Sales Orders"
// section — same shape as SplitVerifyRow (status pill, Verify/Hold inline),
// but the primary's verify/reject already had a real implementation before
// splits existed (verifyAccount, driven by the `onConfirm`/`onReject` props
// the parent — FinanceQueuePage — passes in), so this reuses those instead
// of posting to a new endpoint. Previously this card was just a status
// readout pointing at a "Confirm account" button in the modal's shared
// footer; that made the primary the odd one out next to a split's fully
// self-contained card, and the footer had no Hold at all (only the queue
// row's own separate reject box did). Folding the workflowV2 price/proof
// checklist in here too, since that's the same judgement Verify always
// required — just moved next to the entity it's about.
const PrimaryVerifyCard = ({ order, onConfirm, onReject, confirming, confirmsSalesOrder, canAct, checks, setChecks, checksDone }) => {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const isPending = !order.primary_finance_verified_at;

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-primary">{order.invoicing_from} (primary)</p>
        <span className={`text-[11px] font-semibold ${isPending ? 'text-amber-900' : 'text-pharmacy-green-dark'}`}>
          {isPending ? 'pending' : 'verified'}
        </span>
      </div>
      {order.zoho_so_number && (
        <dl className="text-[12px] text-ink-secondary space-y-0.5">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0">Zoho SO</dt>
            <dd className="text-ink-primary">{order.zoho_so_number}</dd>
          </div>
        </dl>
      )}
      {isPending && !canAct && (
        <p className="text-[11px] text-ink-secondary pt-1">Awaiting Finance's verification of this entity.</p>
      )}
      {isPending && canAct && (
        rejecting ? (
          <div className="space-y-1.5 pt-1">
            <textarea
              autoFocus
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this entity's payment being held?"
              className="w-full text-xs rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex gap-2">
              <button
                disabled={!reason.trim() || confirming}
                onClick={() => onReject(order.id, reason.trim())}
                className="px-2.5 py-1 rounded-md bg-state-error text-white text-[11px] font-semibold disabled:opacity-50"
              >
                {confirming ? 'Holding…' : 'Put on hold'}
              </button>
              <button
                onClick={() => { setRejecting(false); setReason(''); }}
                className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-[11px] text-ink-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5 pt-1">
            {confirmsSalesOrder && (
              <fieldset className="space-y-1">
                <label className="flex items-start gap-2 text-[11px] text-ink-primary">
                  <input
                    type="checkbox"
                    checked={checks.prices}
                    onChange={() => setChecks((c) => ({ ...c, prices: !c.prices }))}
                    className="mt-0.5"
                  />
                  I checked the prices on the Sales Order.
                </label>
                <label className="flex items-start gap-2 text-[11px] text-ink-primary">
                  <input
                    type="checkbox"
                    checked={checks.proof}
                    onChange={() => setChecks((c) => ({ ...c, proof: !c.proof }))}
                    className="mt-0.5"
                  />
                  I checked the proof of payment, or the reason there is none.
                </label>
              </fieldset>
            )}
            <div className="flex gap-2">
              <button
                disabled={confirming || (confirmsSalesOrder && !checksDone)}
                onClick={() => (confirmsSalesOrder ? onConfirm(order.id, checks) : onConfirm(order.id))}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-pharmacy-green text-white text-[11px] font-semibold hover:opacity-90 disabled:opacity-50"
              >
                <ShieldCheck className="w-3 h-3" /> {confirming ? 'Verifying…' : 'Verify'}
              </button>
              <button
                disabled={confirming}
                onClick={() => setRejecting(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-state-error/40 text-state-error text-[11px] font-semibold hover:bg-state-error-light disabled:opacity-50"
              >
                <XCircle className="w-3 h-3" /> Hold
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
};

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

// Sep 15, 2026: `footer` — Dispatch opens this same panel as the order's
// receipt (what to prepare), and puts its own actions there instead of
// Finance's Confirm. Without `onConfirm` no Confirm button can appear anyway.
const OrderDetailsModal = ({ orderId, onClose, onConfirm, onReject, confirming, workflowV2 = false, footer = null }) => {
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
  const splits = detail.data?.data?.splits || [];
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
  //
  // Sep 14, 2026 (GETMEDS_WORKFLOW_V2): with the switch on, confirming takes
  // the same two ticks the queue row asks for — prices and proof of payment —
  // because Dispatch invoices straight after it. They reset for each order.
  const canConfirm = Boolean(onConfirm) && order?.status === 'ready_for_finance_verified';
  const confirmsSalesOrder = canConfirm && workflowV2;
  const [checks, setChecks] = useState({ prices: false, proof: false });
  useEffect(() => { setChecks({ prices: false, proof: false }); }, [orderId]);
  const checksDone = checks.prices && checks.proof;

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
                href={`/orders/${order.id}`}
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
                    Hospital order missing {missing.length} requested document
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
                <Row label="Headquarter" value={order.headquarter} />
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

            {splits.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
                  Split Sales Orders — verify each entity independently
                </h3>
                <div className="grid sm:grid-cols-2 gap-2.5">
                  <PrimaryVerifyCard
                    order={order}
                    onConfirm={onConfirm}
                    onReject={onReject}
                    confirming={confirming}
                    confirmsSalesOrder={confirmsSalesOrder}
                    canAct={canConfirm}
                    checks={checks}
                    setChecks={setChecks}
                    checksDone={checksDone}
                  />
                  {splits.map((s) => (
                    <SplitVerifyRow key={s.id} orderId={order.id} split={s} canAct={canConfirm} />
                  ))}
                </div>
              </div>
            )}

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
                          {it.price_remark && (
                            <span className="block text-[11px] text-ink-secondary italic mt-0.5">💬 {it.price_remark}</span>
                          )}
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
                      <div
                        key={a.id}
                        className="relative block bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-getmeds-blue transition-colors"
                      >
                        {/* Sep 19, 2026: "add download feature for all users
                            to download attachments" — same signed object,
                            minted with Content-Disposition: attachment so
                            this saves the file instead of opening the view
                            tab the rest of the card still opens. A sibling of
                            the view link below, not nested inside it — an
                            <a> inside an <a> is invalid HTML and browsers
                            handle it inconsistently. */}
                        {a.downloadUrl && (
                          <a
                            href={a.downloadUrl}
                            title={`Download ${a.file_name || 'file'}`}
                            className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-md bg-white/90 border border-slate-200 text-ink-secondary hover:text-getmeds-blue hover:border-getmeds-blue shadow-sm"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <a href={a.viewUrl} target="_blank" rel="noopener noreferrer" className="block">
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
                        </a>
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
                      </div>
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
              absence to be read as the panel being broken.
              Sep 22, 2026: for a split order, the primary now has its own
              Verify/Hold inline in the "Split Sales Orders" section above —
              this footer would otherwise offer the exact same action a
              second time, with no Hold of its own to match it. */}
          {footer ? (
            <div className="min-w-0">{footer}</div>
          ) : splits.length > 0 ? (
            <p className="text-[11px] text-ink-secondary min-w-0">
              Verify or hold each entity above — this order is split across {splits.length + 1} Sales Orders.
            </p>
          ) : confirmsSalesOrder ? (
            <fieldset className="min-w-0 space-y-1">
              <legend className="text-[11px] text-ink-secondary mb-1">
                Confirming confirms this Sales Order in Zoho. Dispatch invoices it next.
              </legend>
              <label htmlFor="modal-check-prices" className="flex items-start gap-2 text-xs text-ink-primary">
                <input
                  id="modal-check-prices"
                  type="checkbox"
                  checked={checks.prices}
                  onChange={() => setChecks((c) => ({ ...c, prices: !c.prices }))}
                  className="mt-0.5"
                />
                I checked the prices on the Sales Order.
              </label>
              <label htmlFor="modal-check-proof" className="flex items-start gap-2 text-xs text-ink-primary">
                <input
                  id="modal-check-proof"
                  type="checkbox"
                  checked={checks.proof}
                  onChange={() => setChecks((c) => ({ ...c, proof: !c.proof }))}
                  className="mt-0.5"
                />
                I checked the proof of payment, or the reason there is none.
              </label>
            </fieldset>
          ) : (
            <p className="text-[11px] text-ink-secondary min-w-0">
              {canConfirm
                ? 'Confirming moves the Sales Order in Zoho from Draft to Confirmed, which releases it to be invoiced.'
                : order?.status === 'ready_for_finance_verified'
                  ? ''
                  : 'Not awaiting Finance — nothing to confirm at this stage.'}
            </p>
          )}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-slate-200 text-sm font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
            >
              Close
            </button>
            {canConfirm && splits.length === 0 && (
              <button
                onClick={() => (confirmsSalesOrder ? onConfirm(order.id, checks) : onConfirm(order.id))}
                disabled={confirming || (confirmsSalesOrder && !checksDone)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-pharmacy-green text-white text-sm font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {confirming ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                {confirmsSalesOrder ? 'Confirm order' : 'Confirm account'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OrderDetailsModal;
