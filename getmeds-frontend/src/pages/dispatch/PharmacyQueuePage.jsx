import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pill, RefreshCw, FileSearch, ShieldCheck, XCircle, CheckCircle2, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import OrderDetailsModal from '../../components/finance/OrderDetailsModal';
import { formatPHT } from '../../utils/dateUtils';

/**
 * Pharmacy — prescription verification. Sep 25, 2026.
 *
 * Every order that carries a prescription, from the moment Management approves
 * it: BEFORE Finance has confirmed the payment, so the pharmacist reviews the
 * prescription while Finance checks the money. The order goes out when both are
 * done, and Dispatch's board says which of the two is still holding it.
 *
 * Verify clears the prescription; Reject needs a reason, tells the MedRep, and
 * the order comes back here once they upload a replacement. Neither changes the
 * order's status. Dispatch and Admin decide; Management can look.
 *
 * The files themselves open in the same order-details view Finance and Dispatch
 * already use ("View files"), with the same two buttons at the bottom, so the
 * decision can be made looking at the prescription.
 */

const TABS = [
  { key: 'pending', label: 'Awaiting review', hint: 'Prescriptions nobody has reviewed yet, including replacements.' },
  { key: 'rejected', label: 'Rejected', hint: 'Sent back to the MedRep. They come back under "Awaiting review" once replaced.' },
  { key: 'verified', label: 'Verified', hint: 'Cleared by the pharmacy, and not yet packed.' },
];

const STAGE_LABEL = {
  ready_for_finance_verified: 'Awaiting Finance',
  ready_for_draft_invoice: 'Finance confirmed',
  ready_for_invoice_sent: 'Finance confirmed · invoice not sent',
  ready_for_dispatch: 'Finance confirmed · ready for dispatch',
  picking_packing: 'Packed',
};

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const errorText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

/** Verify / Reject for one order. Used on the row and in the details view's footer. */
const Decision = ({ order, canDecide, onDone }) => {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pharmacy-queue'] });
    qc.invalidateQueries({ queryKey: ['dispatch-recent'] });
  };

  const verify = useMutation({
    mutationFn: () => client.post(`/api/dispatch/pharmacy/orders/${order.id}/verify`).then((r) => r.data),
    onSuccess: () => {
      toast.success(`${order.getmeds_order_id}: prescription verified.`);
      refresh();
      onDone?.();
    },
    onError: (err) => toast.error(errorText(err, 'Could not verify.')),
  });

  const reject = useMutation({
    mutationFn: () => client.post(`/api/dispatch/pharmacy/orders/${order.id}/reject`, { reason: reason.trim() }).then((r) => r.data),
    onSuccess: () => {
      toast.success(`${order.getmeds_order_id}: prescription rejected. The MedRep was told.`);
      setRejecting(false);
      setReason('');
      refresh();
      onDone?.();
    },
    onError: (err) => toast.error(errorText(err, 'Could not reject.')),
  });

  const waiting = order.prescriptions.some((p) => p.status === 'pending');
  if (!canDecide || !waiting) return null;
  const busy = verify.isPending || reject.isPending;

  if (rejecting) {
    return (
      <div className="w-full space-y-2">
        <label htmlFor={`rx-reason-${order.id}`} className="block text-xs font-semibold text-red-900">
          Why is it being rejected? The MedRep sees this.
        </label>
        <textarea
          id={`rx-reason-${order.id}`}
          rows={2}
          autoFocus
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Prescription is unsigned / expired / not legible"
          className="w-full text-sm rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!reason.trim() || busy}
            onClick={() => reject.mutate()}
            className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
          >
            {reject.isPending ? 'Rejecting…' : 'Reject and tell the MedRep'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setRejecting(false); setReason(''); }}
            className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-ink-secondary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => verify.mutate()}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        {verify.isPending ? 'Verifying…' : 'Verify prescription'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setRejecting(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
      >
        <XCircle className="w-3.5 h-3.5" />
        Reject
      </button>
    </div>
  );
};

const FinancePill = ({ cleared }) =>
  cleared ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
      <ShieldCheck className="w-3 h-3" /> Finance confirmed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
      <Clock className="w-3 h-3" /> Awaiting Finance
    </span>
  );

const PharmacyQueuePage = () => {
  const [tab, setTab] = useState('pending');
  const [viewingId, setViewingId] = useState(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['pharmacy-queue', tab],
    queryFn: () => client.get('/api/dispatch/pharmacy/queue', { params: { state: tab } }).then((r) => r.data.data),
    refetchInterval: 30000,
  });
  const orders = data?.orders || [];
  const counts = data?.counts || { pending: 0, rejected: 0, verified: 0 };
  const canDecide = Boolean(data?.can_decide);
  const viewing = orders.find((o) => o.id === viewingId) || null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Pill className="w-7 h-7 text-getmeds-blue" />
            <h1 className="text-2xl font-semibold text-ink-primary">Pharmacy</h1>
          </div>
          <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
            Orders that carry a prescription, from the moment Management approves them, so a prescription can be
            reviewed while Finance checks the payment. An order goes out once both are done.
            {!canDecide && data ? ' You can look here; Dispatch verifies and rejects.' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 rounded-md text-sm font-medium text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary shadow-sm shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            title={t.hint}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              tab === t.key ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-ink-secondary border-slate-200 hover:bg-surface hover:text-ink-primary'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 font-normal tabular-nums ${tab === t.key ? 'text-white/80' : 'text-ink-secondary'}`}>({counts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
            <p className="text-sm">
              {tab === 'pending' ? 'No prescription is waiting for review.' : tab === 'rejected' ? 'No rejected prescription is waiting on a MedRep.' : 'Nothing verified is waiting to be packed.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map((o) => (
              <li key={o.id} className="p-4 space-y-3">
                <div className="flex justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-mono font-semibold text-getmeds-blue">{o.getmeds_order_id}</p>
                    <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                    <p className="text-xs text-ink-secondary">
                      {o.medrep_name}{o.division ? ` · ${o.division}` : ''}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <FinancePill cleared={o.finance_cleared} />
                      <span className="text-[11px] text-ink-secondary">{STAGE_LABEL[o.status] || o.status}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-ink-primary">{peso(o.total_amount)}</p>
                    <button
                      type="button"
                      onClick={() => setViewingId(o.id)}
                      className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
                    >
                      <FileSearch className="w-3.5 h-3.5" /> View files
                    </button>
                  </div>
                </div>

                <ul className="space-y-1">
                  {o.prescriptions.filter((p) => !p.superseded).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-surface px-3 py-1.5 text-xs">
                      <Pill className="w-3.5 h-3.5 text-ink-secondary shrink-0" />
                      <span className="font-medium text-ink-primary truncate max-w-[16rem]">{p.file_name || 'Prescription'}</span>
                      <span className="text-ink-secondary">
                        {p.uploaded_by_name ? `${p.uploaded_by_name} · ` : ''}{p.uploaded_at ? formatPHT(p.uploaded_at, 'short-datetime') : ''}
                      </span>
                      <span
                        className={`ml-auto font-semibold ${p.status === 'verified' ? 'text-emerald-700' : p.status === 'rejected' ? 'text-red-700' : 'text-amber-800'}`}
                      >
                        {p.status === 'verified' ? `Verified${p.verified_by_name ? ` by ${p.verified_by_name}` : ''}` : p.status === 'rejected' ? 'Rejected' : 'Waiting'}
                      </span>
                      {p.status === 'rejected' && p.rejection_reason && (
                        <span className="w-full text-red-800">Reason: {p.rejection_reason}</span>
                      )}
                    </li>
                  ))}
                </ul>

                <Decision order={o} canDecide={canDecide} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {viewing && (
        <OrderDetailsModal
          orderId={viewing.id}
          onClose={() => setViewingId(null)}
          footer={<Decision order={viewing} canDecide={canDecide} onDone={() => setViewingId(null)} />}
        />
      )}
    </div>
  );
};

export default PharmacyQueuePage;
