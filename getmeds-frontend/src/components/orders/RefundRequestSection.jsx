import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Loader2, Banknote, Check, Clock } from 'lucide-react';
import client from '../../api/client';

/**
 * Refund requests on the order page. Oct 22, 2026.
 *
 * The one entry point for a refund on an order that is already paid for: the MedRep (or Team Lead,
 * Management, Admin) asks, Management decides, and for an invoiced order Finance and Dispatch clear
 * the invoice in Zoho first. See services/refundRequestService.js and the walkthrough in
 * getmeds-documents/refund-process-walkthrough.html.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const OPEN = ['requested', 'approved', 'voided', 'queued'];
const GOODS = [
  ['not_shipped', 'Not shipped'],
  ['returning', 'Shipped, coming back to us'],
  ['customer_returns', 'Delivered, customer returns them'],
  ['customer_keeps', 'Customer keeps them']
];

export const stageOf = (order) => (order.zoho_invoice_id || order.zoho_invoice_number ? 'invoiced' : order.zoho_so_id ? 'so' : 'draft');
const STAGE_TEXT = {
  draft: 'This order is not in Zoho yet. Management decides; if it approves, the order is cancelled and Finance arranges the refund.',
  so: 'This order has a Sales Order but no invoice. Management decides; if it approves, Finance arranges the refund and Dispatch closes the Sales Order in Zoho.',
  invoiced: 'This order is invoiced. Management decides. If the goods are not with the customer, Dispatch records them as returned. Finance removes any payment in Zoho, Dispatch voids the invoice, then Finance pays.'
};

const errText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

const RequestModal = ({ order, onClose, onDone }) => {
  const stage = stageOf(order);
  const total = Number(order.total_amount) || 0;
  const [reason, setReason] = useState('');
  const [goods, setGoods] = useState(stage === 'draft' ? 'not_shipped' : '');
  const [amount, setAmount] = useState(String(total));

  const save = useMutation({
    mutationFn: () => client.post('/api/refund-requests', { order_id: order.id, reason: reason.trim(), goods_status: goods || undefined, amount: Number(amount) }).then((r) => r.data),
    onSuccess: () => { toast.success('Refund requested. Management will decide.'); onDone(); },
    onError: (err) => toast.error(errText(err, 'Could not send the request'), { duration: 8000 })
  });
  const amt = Number(amount);
  const ready = reason.trim().length > 0 && (stage === 'draft' || goods) && amt > 0 && amt <= total + 0.005;
  const label = 'block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-16">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary">Request a refund</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={save.isPending} className="text-ink-secondary hover:text-ink-primary" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-950">{STAGE_TEXT[stage]}</p>
          <div>
            <label className={label} htmlFor="rr-reason">Why does the customer want a refund?</label>
            <textarea id="rr-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
              className="w-full text-sm rounded-md border border-slate-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-getmeds-blue" placeholder="e.g. Customer cancelled the order, parcel not received yet" />
          </div>
          {stage !== 'draft' && (
            <div>
              <span className={label}>Where are the goods?</span>
              <div className="flex flex-wrap gap-2">
                {GOODS.map(([k, t]) => (
                  <button key={k} type="button" onClick={() => setGoods(k)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs ${goods === k ? 'border-getmeds-blue bg-blue-50 text-getmeds-blue-dark font-semibold' : 'border-slate-300 text-ink-secondary'}`}>{t}</button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className={label} htmlFor="rr-amount">Amount to refund (₱)</label>
            <input id="rr-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="w-full text-sm rounded-md border border-slate-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-getmeds-blue" />
            <p className="text-[11px] text-ink-secondary mt-1">Order total {peso(total)}. Enter less for a partial refund.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" onClick={onClose} disabled={save.isPending} className="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-ink-secondary">Cancel</button>
          <button type="button" disabled={!ready || save.isPending} onClick={() => save.mutate()}
            className="px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-1.5">
            {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Send request
          </button>
        </div>
      </div>
    </div>
  );
};

const Step = ({ done, children }) => (
  <li className="flex items-start gap-2 text-[12.5px]">
    <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
      {done ? <Check className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
    </span>
    <span className={done ? 'text-ink-secondary' : 'text-ink-primary'}>{children}</span>
  </li>
);

const RefundRequestSection = ({ order, user, onChanged }) => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rr = order.refund_request || null;
  const isOpen = rr && OPEN.includes(rr.status);
  const role = String(user?.role || '').toLowerCase();
  const mine = user?.id === order.medrep_id || user?.id === order.raised_by_id;
  const canAsk = !isOpen && !['cancelled', 'deleted'].includes(order.status) &&
    (['management', 'admin', 'team_lead'].includes(role) || (role === 'medrep' && mine));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['order', String(order.id)] }); qc.invalidateQueries({ queryKey: ['order', order.id] }); onChanged?.(); };

  const withdraw = useMutation({
    mutationFn: () => client.post(`/api/refund-requests/${rr.id}/withdraw`).then((r) => r.data),
    onSuccess: () => { toast.success('Request withdrawn.'); refresh(); },
    onError: (err) => toast.error(errText(err, 'Could not withdraw it'))
  });

  if (!rr && !canAsk) return null;

  return (
    <>
      {isOpen && (
        <div className="mb-4 rounded-lg border border-getmeds-blue/30 bg-blue-50 px-4 py-3 text-[13px] text-slate-900">
          <p className="font-semibold flex items-center gap-1.5"><Banknote className="w-4 h-4" />
            {rr.status === 'requested' && 'Refund requested: waiting for Management'}
            {rr.status === 'approved' && 'Refund approved: clearing the invoice in Zoho'}
            {rr.status === 'voided' && 'Invoice void: waiting for Management to send it to Finance'}
            {rr.status === 'queued' && 'Refund with Finance'}
            <span className="font-normal text-ink-secondary"> · {peso(rr.requested_amount)}</span>
          </p>
          <p className="mt-0.5 text-[12.5px]">Reason: {rr.reason}</p>
          {rr.status === 'approved' && rr.stage === 'invoiced' && (
            <ul className="mt-2 space-y-1">
              <Step done>Approved by {rr.decided_by_name || 'Management'}</Step>
              {rr.payment_applied !== false && <Step done={Boolean(rr.payment_removed_at)}>Payment removed from {rr.zoho_invoice_number || 'the invoice'} in Zoho (Finance)</Step>}
              {['returning', 'customer_returns'].includes(rr.goods_status) && <Step done={Boolean(rr.goods_returned_at)}>Goods recorded as returned (Dispatch)</Step>}
              <Step done={false}>{rr.zoho_invoice_number || 'Invoice'} voided in Zoho (Dispatch)</Step>
            </ul>
          )}
          {rr.status === 'requested' && (rr.requested_by === user?.id || role === 'admin') && (
            <button type="button" disabled={withdraw.isPending} onClick={() => withdraw.mutate()} className="mt-2 text-xs font-semibold text-getmeds-blue hover:underline">
              Withdraw this request
            </button>
          )}
        </div>
      )}
      {!isOpen && rr && ['rejected', 'withdrawn'].includes(rr.status) && (
        <p className="mb-3 text-[12.5px] text-ink-secondary">
          Last refund request {rr.status === 'rejected' ? `was rejected${rr.decision_note ? `: ${rr.decision_note}` : ''}` : 'was withdrawn'}.
        </p>
      )}
      {canAsk && (
        <div className="mb-4">
          <button type="button" onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-getmeds-blue/40 bg-white text-xs font-semibold text-getmeds-blue hover:bg-getmeds-blue/5">
            <Banknote className="w-3.5 h-3.5" /> Request refund
          </button>
        </div>
      )}
      {open && <RequestModal order={order} onClose={() => setOpen(false)} onDone={() => { setOpen(false); refresh(); }} />}
    </>
  );
};

export default RefundRequestSection;
