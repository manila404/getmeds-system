import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pill, RefreshCw, ShieldCheck, XCircle, CheckCircle2, Clock, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
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
  { key: 'needs_attention', label: 'Needs attention', hint: 'Orders with attachments but no prescription labeled (may be mislabeled), or where the MedRep noted they have no prescription. Resolves automatically once retagged or a decision is made.' },
  { key: 'rejected', label: 'Rejected', hint: 'Sent back to the MedRep. They come back under "Awaiting review" once replaced.' },
  { key: 'verified', label: 'Verified', hint: 'Cleared by the pharmacy, and not yet packed.' },
  { key: 'all_orders', label: 'All orders', hint: 'Every order of the six channels since Sep 12, 2026, with or without a prescription attached.' },
];

// The six channels a pharmacist audits. The server maps each to its divisions.
const CHANNELS = ['HOS', 'Telesales', 'B&B', 'STC', 'URO', 'B2C'];

const STAGE_LABEL = {
  ready_for_finance_verified: 'Awaiting Finance',
  ready_for_draft_invoice: 'Finance confirmed',
  ready_for_invoice_sent: 'Finance confirmed · invoice not sent',
  ready_for_dispatch: 'Finance confirmed · ready for dispatch',
  picking_packing: 'Packed',
  on_hold: 'On hold',
};

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const errorText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

// Returns YYYY-MM-DD in PHT (UTC+8) for today + daysOffset.
function phtDate(daysOffset = 0) {
  const pht = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(pht.getUTCFullYear(), pht.getUTCMonth(), pht.getUTCDate() + daysOffset));
  return d.toISOString().slice(0, 10);
}

const DATE_PRESETS = [
  { key: 'all', label: 'All dates' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'custom', label: 'Custom…' },
];

function presetToDates(preset, customFrom, customTo) {
  if (preset === 'today') return { from: phtDate(0), to: phtDate(0) };
  if (preset === 'yesterday') return { from: phtDate(-1), to: phtDate(-1) };
  if (preset === 'last7') return { from: phtDate(-6), to: phtDate(0) };
  if (preset === 'custom') return { from: customFrom || '', to: customTo || '' };
  return { from: '', to: '' };
}

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

/**
 * Sep 28, 2026: a second look at a decision Pharmacy already made. The
 * Rejected tab used to be a dead end past "View files" — this is the one
 * action offered there (and in the details view's footer), for the order's
 * own live rejection (not one a MedRep has already answered with a
 * replacement — that's Decision's "Verify prescription" above, once it's
 * back at Awaiting review).
 */
const ReReview = ({ order, canDecide, onDone }) => {
  const [open, setOpen] = useState(false);
  const [editingReason, setEditingReason] = useState(false);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pharmacy-queue'] });
    qc.invalidateQueries({ queryKey: ['dispatch-recent'] });
  };

  const act = useMutation({
    mutationFn: (body) => client.post(`/api/dispatch/pharmacy/orders/${order.id}/re-review`, body).then((r) => r.data),
    onSuccess: (_res, body) => {
      toast.success(
        {
          verify: `${order.getmeds_order_id}: re-reviewed and verified.`,
          reject: `${order.getmeds_order_id}: still rejected — the MedRep was told the updated reason.`,
          reset: `${order.getmeds_order_id}: moved back to Awaiting review.`,
        }[body.action]
      );
      setOpen(false);
      setEditingReason(false);
      setReason('');
      refresh();
      onDone?.();
    },
    onError: (err) => toast.error(errorText(err, 'Could not update the review.')),
  });

  const liveRejected = order.prescriptions.find((p) => p.status === 'rejected' && !p.superseded);
  if (!canDecide || !liveRejected) return null;
  const busy = act.isPending;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setReason(liveRejected.rejection_reason || ''); }}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
      >
        <RotateCcw className="w-3.5 h-3.5" /> Re-review
      </button>
    );
  }

  if (editingReason) {
    return (
      <div className="w-full space-y-2">
        <label htmlFor={`rx-rereview-reason-${order.id}`} className="block text-xs font-semibold text-red-900">
          Updated reason — the MedRep sees this.
        </label>
        <textarea
          id={`rx-rereview-reason-${order.id}`}
          rows={2}
          autoFocus
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          className="w-full text-sm rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!reason.trim() || busy}
            onClick={() => act.mutate({ action: 'reject', reason: reason.trim() })}
            className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save — still rejected'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditingReason(false)}
            className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-ink-secondary"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      <p className="text-xs font-semibold text-ink-primary">Re-review this prescription</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => act.mutate({ action: 'verify' })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> Verify (override rejection)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditingReason(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
        >
          <XCircle className="w-3.5 h-3.5" /> Edit rejection reason
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act.mutate({ action: 'reset' })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-amber-300 bg-amber-50 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          <Clock className="w-3.5 h-3.5" /> Back to Awaiting review
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="text-xs text-ink-secondary hover:text-ink-primary">
          Cancel
        </button>
      </div>
    </div>
  );
};

/**
 * Sep 28, 2026: an order with zero prescription rows — a MedRep mis-tagged
 * the division, or uploaded the prescription under the wrong attachment
 * category, and it sits in "All orders" as "No prescription uploaded" with
 * nothing to press. Two ways to resolve it: ask the MedRep for one, or say
 * Pharmacy has looked and it genuinely does not need one.
 */
const NoRxActions = ({ order, canDecide, onDone }) => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(null); // null | 'request' | 'not_required'
  const [reason, setReason] = useState('');
  const qc = useQueryClient();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pharmacy-queue'] });
    qc.invalidateQueries({ queryKey: ['dispatch-recent'] });
  };

  const act = useMutation({
    mutationFn: (body) => client.post(`/api/dispatch/pharmacy/orders/${order.id}/no-rx-decision`, body).then((r) => r.data),
    onSuccess: (_res, body) => {
      toast.success(
        body.action === 'not_required'
          ? `${order.getmeds_order_id}: marked as not needing a prescription.`
          : `${order.getmeds_order_id}: asked the MedRep for a prescription.`
      );
      setOpen(false);
      setMode(null);
      setReason('');
      refresh();
      onDone?.();
    },
    onError: (err) => toast.error(errorText(err, 'Could not save that.')),
  });

  if (!canDecide) return null;
  const busy = act.isPending;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
      >
        Decide on this
      </button>
    );
  }

  if (mode) {
    const isRequest = mode === 'request';
    return (
      <div className="w-full space-y-2">
        <label htmlFor={`no-rx-reason-${order.id}`} className={`block text-xs font-semibold ${isRequest ? 'text-red-900' : 'text-ink-primary'}`}>
          {isRequest ? 'What do you need from the MedRep? They see this.' : 'Why is it not needed? (optional)'}
        </label>
        <textarea
          id={`no-rx-reason-${order.id}`}
          rows={2}
          autoFocus
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder={isRequest ? 'e.g. Upload the prescription for the item(s) on this order' : 'e.g. Hospital PO, item does not require an Rx'}
          className={`w-full text-sm rounded-md border px-2 py-1.5 focus:outline-none focus:ring-1 ${isRequest ? 'border-red-300 focus:ring-red-400' : 'border-slate-300 focus:ring-getmeds-blue'}`}
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || (isRequest && !reason.trim())}
            onClick={() => act.mutate({ action: mode, reason: reason.trim() })}
            className={`px-3 py-1.5 rounded-md text-white text-xs font-semibold disabled:opacity-50 ${
              isRequest ? 'bg-red-600 hover:bg-red-700' : 'bg-pharmacy-green hover:bg-pharmacy-green-dark'
            }`}
          >
            {busy ? 'Saving…' : isRequest ? 'Send request' : 'Confirm — not required'}
          </button>
          <button type="button" disabled={busy} onClick={() => setMode(null)} className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-ink-secondary">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => setMode('request')}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
      >
        <XCircle className="w-3.5 h-3.5" /> Request prescription
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setMode('not_required')}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50"
      >
        <CheckCircle2 className="w-3.5 h-3.5" /> Mark not required
      </button>
      <button type="button" disabled={busy} onClick={() => setOpen(false)} className="text-xs text-ink-secondary hover:text-ink-primary">
        Cancel
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
  const [channel, setChannel] = useState('');
  const [datePreset, setDatePreset] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [page, setPage] = useState(1);
  const [viewingId, setViewingId] = useState(null);

  const { from: dateFrom, to: dateTo } = presetToDates(datePreset, customFrom, customTo);

  const changeTab = useCallback((key) => { setTab(key); setPage(1); }, []);
  const changeChannel = useCallback((c) => { setChannel(c); setPage(1); }, []);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['pharmacy-queue', tab, channel, dateFrom, dateTo, page],
    queryFn: () => client.get('/api/dispatch/pharmacy/queue', {
      params: {
        state: tab,
        ...(channel ? { channel } : {}),
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
        page,
      },
    }).then((r) => r.data.data),
    refetchInterval: 30000,
  });
  const orders = data?.orders || [];
  const counts = data?.counts || { pending: 0, rejected: 0, verified: 0, all_orders: 0, needs_attention: 0 };
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
            reviewed while Finance checks the payment. An order goes out once both are done. "All orders" also lists the orders of
            HOS, Telesales, B&B, STC, URO and B2C that have no prescription yet, so you can check whether one is needed.
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
            onClick={() => changeTab(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              tab === t.key ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-ink-secondary border-slate-200 hover:bg-surface hover:text-ink-primary'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 font-normal tabular-nums ${tab === t.key ? 'text-white/80' : 'text-ink-secondary'}`}>({counts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Channel">
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary mr-1">Channel</span>
        {['', ...CHANNELS].map((c) => (
          <button
            key={c || 'all'}
            type="button"
            aria-pressed={channel === c}
            onClick={() => changeChannel(c)}
            className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
              channel === c ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-ink-secondary border-slate-200 hover:bg-surface hover:text-ink-primary'
            }`}
          >
            {c || 'All'}
          </button>
        ))}

        <span className="text-slate-300 mx-1 select-none">|</span>
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary mr-1">Date</span>
        <select
          value={datePreset}
          onChange={(e) => { setDatePreset(e.target.value); setPage(1); }}
          className="px-2.5 py-1 rounded-full text-xs font-semibold border border-slate-200 bg-white text-ink-secondary focus:outline-none focus:ring-1 focus:ring-getmeds-blue cursor-pointer"
        >
          {DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {datePreset === 'custom' && (
          <>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1 rounded-md text-xs border border-slate-200 bg-white text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
            />
            <span className="text-xs text-ink-secondary">to</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1 rounded-md text-xs border border-slate-200 bg-white text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
            />
          </>
        )}
      </div>

      <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
            <p className="text-sm">
              {tab === 'pending' ? 'No prescription is waiting for review.' : tab === 'needs_attention' ? 'Nothing needs attention right now.' : tab === 'rejected' ? 'No rejected prescription is waiting on a MedRep.' : tab === 'verified' ? 'Nothing verified is waiting to be packed.' : 'No orders match.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map((o) => {
              // Sep 28, 2026: the live (not superseded) rejection(s) — the one
              // thing worth calling out at a glance now that the per-file
              // filename row is gone; everything else about the file (who,
              // when, which one) is what the details view is for.
              const liveRejections = o.prescriptions.filter((p) => p.status === 'rejected' && !p.superseded && p.rejection_reason);
              return (
                <li
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  title="Open the order details"
                  onClick={() => setViewingId(o.id)}
                  // Only the card itself, not a keyboard activation bubbling up
                  // from one of its own buttons (Verify/Reject/Re-review) —
                  // keydown bubbles even though their onClick's stopPropagation
                  // (below) already keeps a mouse click from double-firing this.
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewingId(o.id); }
                  }}
                  className="p-4 space-y-3 cursor-pointer hover:bg-surface transition-colors"
                >
                  <div className="flex justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-semibold text-getmeds-blue hover:underline">{o.getmeds_order_id}</p>
                      <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                      <p className="text-xs text-ink-secondary">
                        {o.medrep_name}{o.division ? ` · ${o.division}` : ''}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {STAGE_LABEL[o.status] && <FinancePill cleared={o.finance_cleared} />}
                        <span className="text-[11px] text-ink-secondary">{STAGE_LABEL[o.status] || String(o.status).replace(/_/g, ' ')}</span>
                      </div>
                    </div>
                    <p className="text-sm font-bold text-ink-primary shrink-0">{peso(o.total_amount)}</p>
                  </div>

                  {/* Oct 5, 2026: Pharmacy already asked the MedRep; Dispatch is blocked until it arrives. */}
                  {o.requested && o.prescriptions.length === 0 && (
                    <p className="rounded-md bg-red-50 border border-red-200 px-3 py-1.5 text-xs text-red-900">
                      <span className="font-semibold">⏳ Prescription requested from MedRep</span>
                      {o.requested.by ? ` by ${o.requested.by}` : ''}
                      {o.requested.at ? ` · ${new Date(o.requested.at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
                      {o.requested.reason ? `: ${o.requested.reason}` : ''}
                      <span className="block text-red-900/80">Dispatch cannot send it out until the prescription is verified or you mark it not required.</span>
                    </p>
                  )}
                  {o.resubmitted && (
                    <p className="rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-950">
                      <span className="font-semibold">↩ Re-submitted{o.resubmitted.by ? ` by ${o.resubmitted.by}` : ''}:</span> {o.resubmitted.note || 'No note.'}
                    </p>
                  )}
                  {/* Sep 28, 2026: zero prescription rows — a mis-tagged
                      division or attachment, or a genuine "does not need one".
                      "not_required" is Pharmacy's own call (rx_state carries
                      it); anything else with no file gets the two actions. */}
                  {o.prescriptions.length === 0 && o.rx_state === 'not_required' && (
                    <p className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-xs text-emerald-900">
                      <span className="font-semibold">No prescription needed</span>
                      {o.not_required?.by ? ` — confirmed by ${o.not_required.by}` : ''}
                      {o.not_required?.reason ? `: ${o.not_required.reason}` : ''}
                    </p>
                  )}
                  {/* Sep 29, 2026: order has other attachments but none is
                      tagged prescription — the MedRep may have mislabeled it.
                      The existing retag tool (one click on the attachment in
                      the order details) is the fix. */}
                  {o.suspicious_attachments && (
                    <p className="rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-900">
                      <span className="font-semibold">🟡 Has attachments — no prescription labeled.</span> One may be mislabeled. Open the order and use Retag if so.
                    </p>
                  )}
                  {/* Sep 29, 2026: MedRep's reason for submitting without
                      a prescription on an Rx-required channel. */}
                  {o.no_rx_reason && (
                    <p className="rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-950">
                      <span className="font-semibold">MedRep note (no prescription):</span> {o.no_rx_reason}
                    </p>
                  )}
                  {o.prescriptions.length === 0 && o.rx_state !== 'not_required' && !o.suspicious_attachments && !o.no_rx_reason && (
                    <p className="rounded-md bg-surface px-3 py-1.5 text-xs text-ink-secondary">No prescription uploaded. Open the order to check the items and notes.</p>
                  )}
                  {liveRejections.map((p) => (
                    <p key={p.id} className="rounded-md bg-red-50 border border-red-200 px-3 py-1.5 text-xs text-red-800">
                      <span className="font-semibold">Rejected:</span> {p.rejection_reason}
                    </p>
                  ))}

                  {/* Sep 28, 2026: the card itself now opens the order — these
                      buttons stop that click from also firing.
                      Sep 29, 2026: NoRxActions is shown outside the reviewable
                      gate on the Needs Attention tab so pharmacy can act on
                      orders at any status (pre-approval, post-ship, etc.). */}
                  {(o.reviewable !== false || tab === 'needs_attention') && (
                    <div onClick={(e) => e.stopPropagation()}>
                      {o.reviewable !== false && <Decision order={o} canDecide={canDecide} />}
                      {o.reviewable !== false && <ReReview order={o} canDecide={canDecide} />}
                      {o.prescriptions.length === 0 && o.rx_state !== 'not_required' && (
                        <NoRxActions order={o} canDecide={canDecide} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {data?.pagination && data.pagination.pages > 1 && (
        <div className="flex items-center justify-between gap-3 py-2">
          <p className="text-xs text-ink-secondary">
            Page {data.pagination.page} of {data.pagination.pages} · {data.pagination.total.toLocaleString()} orders
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-ink-secondary disabled:opacity-40 hover:bg-surface disabled:cursor-default"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            {Array.from({ length: data.pagination.pages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === data.pagination.pages || Math.abs(p - page) <= 2)
              .reduce((acc, p, idx, arr) => {
                if (idx > 0 && p - arr[idx - 1] > 1) acc.push('…');
                acc.push(p);
                return acc;
              }, [])
              .map((item, idx) =>
                item === '…' ? (
                  <span key={`ellipsis-${idx}`} className="px-1.5 text-xs text-ink-secondary select-none">…</span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setPage(item)}
                    className={`min-w-[30px] px-2 py-1.5 rounded-md border text-xs font-semibold transition-colors ${
                      item === page ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-ink-secondary border-slate-200 hover:bg-surface'
                    }`}
                  >
                    {item}
                  </button>
                )
              )}
            <button
              type="button"
              disabled={page >= data.pagination.pages}
              onClick={() => setPage((p) => Math.min(data.pagination.pages, p + 1))}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-ink-secondary disabled:opacity-40 hover:bg-surface disabled:cursor-default"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {viewing && (
        <OrderDetailsModal
          orderId={viewing.id}
          onClose={() => setViewingId(null)}
          footer={
            (viewing.reviewable !== false || tab === 'needs_attention') ? (
              <div className="w-full space-y-2">
                {viewing.reviewable !== false && <Decision order={viewing} canDecide={canDecide} onDone={() => setViewingId(null)} />}
                {viewing.reviewable !== false && <ReReview order={viewing} canDecide={canDecide} onDone={() => setViewingId(null)} />}
                {viewing.prescriptions.length === 0 && viewing.rx_state !== 'not_required' && (
                  <NoRxActions order={viewing} canDecide={canDecide} onDone={() => setViewingId(null)} />
                )}
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
};

export default PharmacyQueuePage;
