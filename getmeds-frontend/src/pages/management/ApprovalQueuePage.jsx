import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle, Clock, RefreshCw, ShieldCheck, XCircle, Undo2, ExternalLink } from 'lucide-react';
import client from '../../api/client';

// Sep 7, 2026: "When medrep creates an order, the order will not sync to
// zoho unless the management checks it." A MedRep-submitted order now stops
// at 'pending_management_approval' (see orders.controller.js's submit())
// instead of reaching Zoho immediately — this page is where Management acts
// on it. Approve syncs it to Zoho right away (the same call submit() always
// made, just deferred to now); Reject puts it on hold with a reason, same
// pattern as the Finance Queue's Verify/Hold. An order Management or admin
// submitted themselves never appears here — it already synced to Zoho the
// moment it was submitted, exactly as before this gate existed.
//
// Sep 7, 2026 (2): a third outcome — Send Back — returns the order to the
// MedRep at 'draft' with a reason, instead of putting it on hold. Both
// Send Back and Reject share the same reason-entry UI below (one
// `actionMode` per order id instead of two separate reject-only pieces of
// state), and the Getmeds Order ID now links through to the full order —
// Approve/Send Back/Reject are also available there, alongside the
// line-item and order-detail editors a MedRep or Management would actually
// use to fix what's wrong before resubmitting.
const ApprovalQueuePage = () => {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['management-approval-queue'],
    queryFn: () => client.get('/api/management/orders', { params: { status: 'pending_management_approval', limit: 100 } }).then(r => r.data),
    refetchInterval: 30000
  });
  const orders = data?.data?.orders || [];

  // { id, mode: 'reject' | 'send-back' } | null — one reason box at a time.
  const [actionTarget, setActionTarget] = useState(null);
  const [actionReason, setActionReason] = useState('');

  const approveMutation = useMutation({
    mutationFn: (id) => client.post(`/api/orders/${id}/approve`).then(r => r.data),
    onSuccess: (res) => {
      const synced = res?.data?.zoho_sync_status === 'synced' || res?.data?.zoho_sync_status === 'skipped';
      toast.success(synced
        ? 'Approved — Sales Order created in Zoho.'
        : 'Approved — Zoho sync failed and was queued for automatic retry (see the order for details).');
      qc.invalidateQueries({ queryKey: ['management-approval-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not approve that order')
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }) => client.post(`/api/orders/${id}/reject`, { reason }).then(r => r.data),
    onSuccess: () => {
      toast.success('Rejected. The MedRep has been notified and the order is on hold.');
      setActionTarget(null);
      setActionReason('');
      qc.invalidateQueries({ queryKey: ['management-approval-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not record that')
  });

  // Sep 7, 2026 (2): sends the order back to 'draft' instead of 'on_hold' —
  // the MedRep (or Management) fixes it via the order's Edit Items / Edit
  // Details and resubmits, rather than it sitting closed out on hold.
  const sendBackMutation = useMutation({
    mutationFn: ({ id, reason }) => client.post(`/api/orders/${id}/send-back`, { reason }).then(r => r.data),
    onSuccess: () => {
      toast.success('Sent back to the MedRep to fix and resubmit.');
      setActionTarget(null);
      setActionReason('');
      qc.invalidateQueries({ queryKey: ['management-approval-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not send that order back')
  });

  const waitingHours = (order) => {
    if (!order.submitted_at) return '—';
    const h = (Date.now() - new Date(order.submitted_at).getTime()) / 3600000;
    return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Approval Queue</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Orders a MedRep submitted, waiting for your go-ahead before they sync to Zoho as a Sales Order.
            Orders you or another Management/admin user submit directly skip this queue entirely.
          </p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-center gap-2">
          <Clock className="w-4 h-4 text-state-warning" />
          <h2 className="text-sm font-semibold text-ink-primary">Awaiting approval ({orders.length})</h2>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary">
            <CheckCircle className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
            <p className="text-sm">No MedRep orders currently waiting on you</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map(order => {
              const approveBusy = approveMutation.isPending && approveMutation.variables === order.id;
              const rejectBusy = rejectMutation.isPending && rejectMutation.variables?.id === order.id;
              const sendBackBusy = sendBackMutation.isPending && sendBackMutation.variables?.id === order.id;
              const isActing = actionTarget?.id === order.id;
              return (
                <li key={order.id} className="p-4">
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <Link to={`/orders/${order.id}`} className="text-sm font-mono font-semibold text-getmeds-blue hover:underline">
                        {order.getmeds_order_id}
                      </Link>
                      <p className="text-sm text-ink-primary mt-0.5 font-medium truncate">{order.customer_name}</p>
                      <p className="text-xs text-ink-secondary">
                        {order.medrep_name}
                        {order.customer_type && <> · <span className="capitalize">{order.customer_type}</span></>}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</p>
                      <p className="text-xs text-ink-secondary font-medium mt-0.5">Waiting {waitingHours(order)}</p>
                    </div>
                  </div>

                  <div className="mt-3">
                    {isActing ? (
                      // The reason is the entire output of both actions — it
                      // is what the MedRep acts on — so the API requires one
                      // and the button stays disabled without it.
                      <div className={`rounded-md border p-3 space-y-2 ${actionTarget.mode === 'reject' ? 'border-state-error/40 bg-state-error-light' : 'border-getmeds-blue/40 bg-getmeds-blue/5'}`}>
                        <label className={`block text-xs font-semibold ${actionTarget.mode === 'reject' ? 'text-red-900' : 'text-getmeds-blue-dark'}`}>
                          {actionTarget.mode === 'reject' ? 'Why is this order being rejected?' : 'What does the MedRep need to fix?'}
                        </label>
                        <textarea
                          autoFocus
                          rows={2}
                          value={actionReason}
                          onChange={(e) => setActionReason(e.target.value)}
                          placeholder={actionTarget.mode === 'reject'
                            ? 'e.g. wrong customer selected — resubmit against the correct account'
                            : 'e.g. wrong Division — please correct and resubmit'}
                          className={`w-full text-sm rounded-md border px-2 py-1.5 focus:outline-none focus:ring-1 ${actionTarget.mode === 'reject' ? 'border-red-300 focus:ring-red-400' : 'border-getmeds-blue/40 focus:ring-getmeds-blue'}`}
                        />
                        <div className="flex gap-2">
                          {actionTarget.mode === 'reject' ? (
                            <button
                              disabled={!actionReason.trim() || rejectBusy}
                              onClick={() => rejectMutation.mutate({ id: order.id, reason: actionReason.trim() })}
                              className="px-3 py-1.5 rounded-md bg-state-error text-white text-xs font-semibold disabled:opacity-50"
                            >
                              {rejectBusy ? 'Rejecting…' : 'Reject order'}
                            </button>
                          ) : (
                            <button
                              disabled={!actionReason.trim() || sendBackBusy}
                              onClick={() => sendBackMutation.mutate({ id: order.id, reason: actionReason.trim() })}
                              className="px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold disabled:opacity-50"
                            >
                              {sendBackBusy ? 'Sending back…' : 'Send back to MedRep'}
                            </button>
                          )}
                          <button
                            onClick={() => { setActionTarget(null); setActionReason(''); }}
                            className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-ink-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={approveBusy}
                          onClick={() => approveMutation.mutate(order.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          {approveBusy ? 'Syncing to Zoho…' : 'Approve — sync to Zoho'}
                        </button>
                        <button
                          disabled={approveBusy}
                          onClick={() => { setActionTarget({ id: order.id, mode: 'send-back' }); setActionReason(''); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-getmeds-blue/40 text-getmeds-blue-dark text-xs font-semibold hover:bg-getmeds-blue/10 disabled:opacity-50"
                        >
                          <Undo2 className="w-3.5 h-3.5" /> Send Back
                        </button>
                        <button
                          disabled={approveBusy}
                          onClick={() => { setActionTarget({ id: order.id, mode: 'reject' }); setActionReason(''); }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-state-error/40 text-state-error text-xs font-semibold hover:bg-state-error-light disabled:opacity-50"
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-start gap-2 text-xs text-ink-secondary bg-surface border border-slate-200 rounded-lg p-3">
        <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>Approving here creates the Sales Order in Zoho — the same thing that used to happen the instant a
          MedRep clicked Submit. Send Back returns the order to the MedRep as a draft with your reason attached
          so it can be fixed and resubmitted. Rejecting puts the order on hold with your reason attached instead
          — either way, nothing is ever sent to Zoho until Approve is clicked.</p>
      </div>
    </div>
  );
};

export default ApprovalQueuePage;
