import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import client from '../../api/client';

/**
 * Management's Refund requests. Oct 22, 2026.
 *
 * Four tabs, split by what comes next:
 *   Needs decision      approve or reject (a note the requester reads)
 *   Waiting for goods   approved, the goods are coming back: Dispatch checks them when they arrive
 *   Ready to refund     Dispatch checked the goods (good or damaged): check it and press Refund to put it on Finance's list
 *   Done                queued, paid, rejected or withdrawn
 *
 * See services/refundRequestService.js and getmeds-documents/refund-process-walkthrough.html.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TABS = [['needs_decision', 'Needs decision'], ['waiting', 'Waiting for returned goods'], ['ready', 'Ready to refund'], ['done', 'Done']];
const STAGE = {
  draft: ['Draft', 'bg-amber-100 text-amber-900 border-amber-300'],
  so: ['Sales Order, not invoiced', 'bg-sky-100 text-sky-900 border-sky-300'],
  invoiced: ['Invoiced', 'bg-violet-100 text-violet-900 border-violet-300']
};
const STATUS = {
  requested: ['Requested', 'bg-blue-50 text-blue-900 border-blue-200'], approved: ['Approved', 'bg-amber-100 text-amber-900 border-amber-300'],
  returned: ['Goods checked', 'bg-violet-100 text-violet-900 border-violet-300'], voided: ['Goods checked', 'bg-violet-100 text-violet-900 border-violet-300'], queued: ['With Finance', 'bg-emerald-50 text-emerald-900 border-emerald-200'],
  done: ['Refunded', 'bg-emerald-100 text-emerald-900 border-emerald-300'], not_due: ['No refund due', 'bg-slate-100 text-slate-700 border-slate-300'],
  rejected: ['Rejected', 'bg-red-50 text-red-900 border-red-200'], withdrawn: ['Withdrawn', 'bg-slate-100 text-slate-700 border-slate-300']
};
const NEXT_TEXT = {
  dispatch_goods: 'Waiting for Dispatch to check the returned goods',
  management_refund: 'Check it and press Refund to send it to Finance',
  finance_payment: 'Finance: record the customer payment in Zoho, then refund it',
  finance_credit_note: 'Finance: create the credit note in Zoho, then refund it',
  finance_refund: 'Finance is refunding it in Zoho'
};
const GOODS = { not_shipped: 'not shipped', returning: 'coming back', customer_returns: 'customer returns', customer_keeps: 'customer keeps' };
const errText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

const RefundRequestsPage = () => {
  const qc = useQueryClient();
  const [tab, setTab] = useState('needs_decision');
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['refund-requests', tab],
    queryFn: () => client.get('/api/refund-requests', { params: { tab } }).then((r) => r.data?.data),
    staleTime: 15_000
  });
  const rows = data?.requests || [];
  const counts = data?.counts || {};
  const refresh = () => { qc.invalidateQueries({ queryKey: ['refund-requests'] }); qc.invalidateQueries({ queryKey: ['refunds'] }); qc.invalidateQueries({ queryKey: ['refund-summary'] }); qc.invalidateQueries({ queryKey: ['return-checks'] }); qc.invalidateQueries({ queryKey: ['finance-steps'] }); };

  const approve = useMutation({
    mutationFn: (r) => client.post(`/api/refund-requests/${r.id}/approve`).then((x) => x.data),
    onSuccess: (res) => { const s = res?.data?.request?.status; toast.success(s === 'queued' ? 'Approved: the order is cancelled and the refund is on Finance\'s list.' : 'Approved. Dispatch was told to check the goods when they are back.'); refresh(); },
    onError: (err) => toast.error(errText(err, 'Could not approve it'), { duration: 8000 })
  });
  const refund = useMutation({
    mutationFn: (r) => client.post(`/api/refund-requests/${r.id}/refund`).then((x) => x.data),
    onSuccess: () => { toast.success('Sent to Finance\'s refund list. The order is cancelled.'); refresh(); },
    onError: (err) => toast.error(errText(err, 'Could not send it to Finance'), { duration: 8000 })
  });
  const reject = useMutation({
    mutationFn: ({ r, text }) => client.post(`/api/refund-requests/${r.id}/reject`, { note: text }).then((x) => x.data),
    onSuccess: () => { toast.success('Rejected. The requester was told why.'); setRejecting(null); setNote(''); refresh(); },
    onError: (err) => toast.error(errText(err, 'Could not reject it'))
  });
  const busy = approve.isPending || refund.isPending || reject.isPending;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-semibold text-ink-primary">Refund requests</h1>
      <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
        MedReps ask for a refund on an order that is already paid for. If the goods are not coming back, approving puts it on Finance's list (Finance records the payment in Zoho, then refunds it). If they are, Dispatch checks them first, you check it and press Refund, then Finance creates the credit note.
      </p>

      <div className="flex flex-wrap gap-2 mt-5">
        {TABS.map(([k, t]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${tab === k ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'border-slate-300 text-ink-secondary bg-white'}`}>
            {t}{counts[k] != null && k !== 'done' ? ` (${counts[k]})` : ''}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white overflow-x-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>
        ) : isError ? (
          <p className="p-6 text-sm text-red-700">Could not load the list. <button className="underline" onClick={() => refetch()}>Try again</button></p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-ink-secondary">Nothing here.</p>
        ) : (
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200">
                <th className="px-4 py-2.5">Order</th><th className="px-3 py-2.5">Customer</th><th className="px-3 py-2.5">Where it is</th>
                <th className="px-3 py-2.5 text-right">Refund</th><th className="px-3 py-2.5">Asked by</th><th className="px-3 py-2.5">Reason</th><th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="border-b border-slate-100 align-top">
                    <td className="px-4 py-3 font-semibold whitespace-nowrap"><Link className="text-getmeds-blue hover:underline" to={`/orders/${r.order_id}`}>{r.getmeds_order_id}</Link></td>
                    <td className="px-3 py-3">{r.customer_name}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STAGE[r.stage]?.[1]}`}>{STAGE[r.stage]?.[0]}</span>
                      {r.stage !== 'draft' && <span className="block text-[11px] text-ink-secondary mt-1">Goods: {GOODS[r.goods_status]}</span>}
                      {r.stage === 'invoiced' && <span className="block text-[11px] text-ink-secondary">{r.zoho_invoice_number}</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{peso(r.requested_amount)}{Number(r.requested_amount) < Number(r.total_amount) ? <span className="block text-[11px] text-ink-secondary">of {peso(r.total_amount)}</span> : null}</td>
                    <td className="px-3 py-3">{r.requested_by_name}<span className="block text-[11px] text-ink-secondary">{r.requested_at ? new Date(r.requested_at).toLocaleDateString() : ''}</span></td>
                    <td className="px-3 py-3 max-w-[260px]">
                      <span className="block">{r.reason}</span>
                      {r.decision_note && <span className="block text-xs text-ink-secondary mt-0.5">Decision: {r.decision_note}</span>}
                      {r.goods_condition && (
                        <span className={`block text-xs mt-1 ${r.goods_condition === 'damaged' ? 'text-red-700 font-semibold' : 'text-emerald-800'}`}>
                          Dispatch: {r.goods_condition === 'good' ? 'goods in good condition' : 'goods DAMAGED'}{r.goods_returned_note ? ` (${r.goods_returned_note})` : ''}
                        </span>
                      )}
                      {tab !== 'needs_decision' && (
                        <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS[r.status]?.[1]}`}>{STATUS[r.status]?.[0]}</span>
                      )}
                      {NEXT_TEXT[r.next] && <span className="block text-xs text-ink-secondary mt-1">{NEXT_TEXT[r.next]}</span>}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {r.status === 'requested' && (
                        <span className="inline-flex gap-1.5">
                          <button type="button" disabled={busy} onClick={() => approve.mutate(r)} className="rounded-md bg-getmeds-blue px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                            {r.path === 'return' ? 'Approve' : 'Approve & refund'}
                          </button>
                          <button type="button" disabled={busy} onClick={() => { setRejecting(r.id); setNote(''); }} className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 disabled:opacity-50">Reject</button>
                        </span>
                      )}
                      {['returned', 'voided'].includes(r.status) && (
                        <span className="inline-flex gap-1.5">
                          <button type="button" disabled={busy} onClick={() => refund.mutate(r)} className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Refund</button>
                          <button type="button" disabled={busy} onClick={() => { setRejecting(r.id); setNote(''); }} className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 disabled:opacity-50">Reject</button>
                        </span>
                      )}
                    </td>
                  </tr>
                  {rejecting === r.id && (
                    <tr className="border-b border-slate-100 bg-red-50/40">
                      <td colSpan={7} className="px-4 py-3">
                        <label className="block text-xs font-semibold text-red-900 mb-1" htmlFor={`rj-${r.id}`}>Why? The requester reads this.</label>
                        <textarea id={`rj-${r.id}`} rows={2} maxLength={500} value={note} autoFocus onChange={(e) => setNote(e.target.value)}
                          className="w-full max-w-xl text-sm rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400" />
                        <div className="mt-2 flex gap-2">
                          <button type="button" disabled={!note.trim() || busy} onClick={() => reject.mutate({ r, text: note.trim() })} className="rounded-md bg-red-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Reject request</button>
                          <button type="button" onClick={() => setRejecting(null)} className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-ink-secondary">Back</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default RefundRequestsPage;
