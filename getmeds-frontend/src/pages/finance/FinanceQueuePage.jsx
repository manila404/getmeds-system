import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle, Clock, RefreshCw, FileText, Banknote, ExternalLink, Truck, ShieldCheck, XCircle, Receipt } from 'lucide-react';
import client from '../../api/client';

// Almost read-only. Every stage below EXCEPT the first is reported by Zoho:
//   1. MedRep submits an order here -> it syncs to Zoho as a Sales Order.
//   2. Finance confirms the Sales Order in Zoho.
//   3. >>> Finance checks the customer's account and verifies it HERE. <<<
//   4. Finance converts it to an Invoice in Zoho.
//   5. Finance marks that Invoice as Sent in Zoho.
//   6. Finance records the Customer Payment against it in Zoho.
// Steps 2, 4, 5 and 6 call back to this app's webhook and move the order on
// their own — this page just shows where things stand for those.
//
// Step 3 is the exception, and the reason this page has buttons at all: there
// is nothing in Zoho that represents "Finance looked at this customer's
// account and it's fine to invoice them". It's a human judgement, so it is
// recorded here, against the person who made it.
const NO_PROOF_REASONS = {
  on_payment_terms:  'Customer is on payment terms',
  payment_to_follow: 'Payment to follow',
  paid_no_slip:      'Paid — no slip issued',
  other:             'Other',
};

const FinanceQueuePage = () => {
  const qc = useQueryClient();

  /**
   * Sep 12, 2026. Two queues, not one.
   *
   * The Zoho import brought historical Sales Orders in carrying real statuses,
   * four of which this page selects on — so Finance opened it to 138 imported
   * orders and the 4 they were meant to act on. Nothing was broken; the work
   * was buried at roughly 35 to 1.
   *
   * Imported orders are separated rather than hidden. They are still the ones
   * someone rings up about, and a queue that silently drops rows is worse than
   * a crowded one — so the other tab is always visible and always carries its
   * count, even when this one is empty.
   */
  const [origin, setOrigin] = useState('getmeds');

  const { data, isLoading, refetch, isFetching } = useQuery({
    // origin is part of the key: without it the two tabs would serve each
    // other's cached rows on switch.
    queryKey: ['finance-queue', origin],
    queryFn: () => client.get(`/api/finance/queue?origin=${origin}`).then(r => r.data),
    refetchInterval: 30000,
    // Keeps the previous tab's rows on screen while the next loads, so
    // switching does not flash the empty state. v5 spelling: the old
    // `keepPreviousData: true` option was removed and is silently ignored,
    // which looks like it works until you switch tabs on a slow connection.
    placeholderData: keepPreviousData
  });
  const orders = data?.data?.orders || [];
  const counts = data?.data?.counts || { getmeds: 0, zoho: 0, total: 0 };

  const TABS = [
    {
      key: 'getmeds',
      label: 'Raised in GetMeds',
      count: counts.getmeds,
      hint: 'Orders your MedReps submitted here. This is the work.'
    },
    {
      key: 'zoho',
      label: 'Imported from Zoho',
      count: counts.zoho,
      hint: 'Historical Sales Orders brought over by the import. Reference only — they are maintained in Zoho.'
    }
  ];

  // Which order's reject box is open, and what's been typed into it. Kept as
  // an id rather than a boolean so only one is ever open at a time.
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  // Sep 4, 2026: proof of payment. Signed view URLs are short-lived and minted
  // per request, so they are fetched for the row being looked at rather than
  // for every row up front — a queue of thirty would otherwise mint thirty
  // links that mostly expire unused.
  const [viewingProof, setViewingProof] = useState({});
  const [rejectingProofId, setRejectingProofId] = useState(null);
  const [proofReason, setProofReason] = useState('');

  const openProof = async (orderId) => {
    try {
      const res = await client.get(`/api/orders/${orderId}/payment-proof`);
      const proof = res.data?.data?.proof;
      if (!proof?.viewUrl) throw new Error('No document on this record');
      setViewingProof((v) => ({ ...v, [orderId]: proof }));
    } catch (err) {
      toast.error(err.response?.data?.error?.message || err.message || 'Could not open that document');
    }
  };

  // Rejecting the SLIP, not the order. "This is for another invoice, send the
  // right one" should not put the order on hold while a correct one is
  // fetched — that is what the Hold button is for, and it is a different
  // judgement. There is no matching approve: verifying the order below marks a
  // pending proof verified in the same transaction.
  const rejectProofMutation = useMutation({
    mutationFn: ({ id, reason }) =>
      client.post(`/api/finance/orders/${id}/payment-proof/reject`, { reason }).then(r => r.data),
    onSuccess: () => {
      toast.success('Proof rejected. The MedRep has been asked to upload a replacement.');
      setRejectingProofId(null);
      setProofReason('');
      setViewingProof({});
      qc.invalidateQueries({ queryKey: ['finance-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not record that')
  });

  const verifyMutation = useMutation({
    mutationFn: ({ id, approved, reason }) =>
      client.post(`/api/finance/orders/${id}/verify`, { approved, reason }).then(r => r.data),
    onSuccess: (res) => {
      toast.success(res?.data?.approved
        ? (res?.data?.paymentProofVerified
            ? 'Verified with its proof of payment — cleared to invoice in Zoho.'
            : 'Verified — cleared to invoice in Zoho.')
        : 'Put on hold. The reason is on the order timeline.');
      setRejectingId(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['finance-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not record that')
  });

  const waitingHours = (order) => {
    if (!order.submitted_at) return '—';
    const h = (Date.now() - new Date(order.submitted_at).getTime()) / 3600000;
    return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
  };

  // Sep 1, 2026: rewritten for the renamed pipeline. This used to be a
  // two-way check on 'invoice_drafted', a status that no longer exists — so
  // every row in the queue was falling through to the "Sales Order confirmed"
  // branch and telling Finance the wrong thing about where the order was.
  const STAGES = {
    ready_for_finance_verified: {
      label: 'Awaiting your account check',
      hint: 'Check the proof of payment below and this customer in Zoho Books (overdue balance, account problems), then verify.',
      icon: ShieldCheck,
      className: 'bg-purple-50 text-purple-800 border-purple-300'
    },
    ready_for_draft_invoice: {
      label: 'Verified — raise the invoice',
      hint: 'Convert the Sales Order to an Invoice in Zoho Books.',
      icon: Banknote,
      className: 'bg-state-warning-light text-amber-950 border-state-warning'
    },
    ready_for_invoice_sent: {
      label: 'Invoice drafted in Zoho',
      hint: 'Mark the Invoice as Sent in Zoho so the customer receives it.',
      icon: FileText,
      className: 'bg-indigo-50 text-indigo-700 border-indigo-300'
    },
    ready_for_dispatch: {
      label: 'Invoice issued — with the warehouse',
      hint: 'Nothing for Finance to do until the payment lands. Customers are on terms, so it may arrive after the goods ship.',
      icon: Truck,
      className: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/30'
    }
  };
  const stageInfo = (status) => STAGES[status] || {
    label: String(status || 'Unknown').replace(/_/g, ' '),
    hint: 'This order is in the Finance queue but at an unexpected status.',
    icon: Clock,
    className: 'bg-slate-100 text-slate-700 border-slate-300'
  };

  const awaitingCount = orders.filter(o => o.status === 'ready_for_finance_verified').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Finance Queue</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Orders waiting on Finance. Verify the customer's account here; do the invoicing and payment
            steps in Zoho — this page updates itself once Zoho reports them.
          </p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Sep 12, 2026: the split. Both tabs always show, both always carry
          their count — an empty GetMeds tab beside "Imported from Zoho (138)"
          says the queue is clear, where a single merged list of 143 said
          nothing at all. */}
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={origin === t.key}
            onClick={() => setOrigin(t.key)}
            title={t.hint}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
              origin === t.key
                ? 'bg-getmeds-blue text-white border-getmeds-blue'
                : 'bg-white text-ink-secondary border-slate-200 hover:bg-surface hover:text-ink-primary'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 font-normal ${origin === t.key ? 'text-white/80' : 'text-ink-secondary'}`}>
              ({t.count})
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-center gap-2">
          <Clock className="w-4 h-4 text-state-warning" />
          <h2 className="text-sm font-semibold text-ink-primary">
            {origin === 'zoho' ? 'Imported from Zoho' : 'Raised in GetMeds'} ({orders.length})
            {awaitingCount > 0 && (
              <span className="ml-2 font-normal text-purple-800">· {awaitingCount} needing your account check</span>
            )}
          </h2>
        </div>

        {/* Said once, at the top of the tab, rather than on all 138 rows. */}
        {origin === 'zoho' && (
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <p className="text-[12px] text-ink-secondary">
              These came from the Zoho import and are kept for reference — they are maintained in
              Zoho, not here. MedReps can view them but cannot change them.
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary">
            <CheckCircle className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
            <p className="text-sm">
              {origin === 'zoho'
                ? 'No imported Zoho orders are sitting in the Finance queue'
                : 'No orders currently waiting on Finance'}
            </p>
            {/* An empty GetMeds tab while imported orders are waiting used to
                be indistinguishable from a broken page. */}
            {origin === 'getmeds' && counts.zoho > 0 && (
              <button
                type="button"
                onClick={() => setOrigin('zoho')}
                className="mt-2 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
              >
                {counts.zoho} imported Zoho order{counts.zoho === 1 ? '' : 's'} are in this queue too
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map(order => {
              const stage = stageInfo(order.status);
              const Icon = stage.icon;
              const needsVerification = order.status === 'ready_for_finance_verified';
              const busy = verifyMutation.isPending && verifyMutation.variables?.id === order.id;
              return (
                <li key={order.id} className="p-4">
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</p>
                      <p className="text-sm text-ink-primary mt-0.5 font-medium truncate">{order.customer_name}</p>
                      <p className="text-xs text-ink-secondary">{order.medrep_name}</p>
                      {order.zoho_so_number && (
                        <p className="text-xs text-ink-secondary mt-1">
                          Zoho SO: <span className="font-mono">{order.zoho_so_number}</span>
                          {order.zoho_invoice_number && <> · Invoice: <span className="font-mono">{order.zoho_invoice_number}</span></>}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</p>
                      <p className="text-xs text-ink-secondary font-medium mt-0.5">Waiting {waitingHours(order)}</p>
                    </div>
                  </div>
                  <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${stage.className}`}>
                    <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold">{stage.label}</p>
                      <p className="opacity-90 mt-0.5">{stage.hint}</p>
                    </div>
                  </div>

                  {/* Sep 4, 2026: the proof of payment, on the row where the
                      decision is actually made. Deliberately NOT a separate
                      queue — this is evidence for the account check, not a
                      second verification, and a second list would be a second
                      place to forget to look. */}
                  {needsVerification && (() => {
                    const proof = viewingProof[order.id];
                    const isImage = (proof?.content_type || order.payment_proof_content_type || '').startsWith('image/');
                    const proofBusy = rejectProofMutation.isPending && rejectProofMutation.variables?.id === order.id;

                    // No proof is a normal, allowed state — it is a soft gate,
                    // for the same reason the account check is one. Finance is
                    // told, and decides.
                    if (!order.payment_proof_status) {
                      return (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-slate-200 bg-surface px-3 py-2 text-xs text-ink-secondary">
                          <Receipt className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          <div>
                            {order.no_payment_proof_reason ? (
                              <>
                                <p className="font-semibold text-ink-primary">
                                  No proof — {NO_PROOF_REASONS[order.no_payment_proof_reason] || order.no_payment_proof_reason}
                                </p>
                                {order.no_payment_proof_note && <p className="mt-0.5">{order.no_payment_proof_note}</p>}
                              </>
                            ) : (
                              <p className="font-semibold text-ink-primary">No proof of payment attached, and no reason on file.</p>
                            )}
                            <p className="mt-0.5">You can still verify — the timeline records that none was attached.</p>
                          </div>
                        </div>
                      );
                    }

                    if (order.payment_proof_status === 'rejected') {
                      return (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-state-error/40 bg-state-error-light px-3 py-2 text-xs text-red-800">
                          <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          <p>Proof of payment rejected — waiting for the MedRep to upload a replacement.</p>
                        </div>
                      );
                    }

                    return (
                      <div className="mt-3 rounded-md border border-slate-200 bg-surface overflow-hidden">
                        <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-ink-primary flex items-center gap-1.5">
                            <Receipt className="w-3.5 h-3.5" />
                            Proof of payment
                          </span>
                          <span className="text-xs text-ink-secondary truncate">
                            {order.payment_proof_uploaded_by_name || '—'}
                          </span>
                        </div>

                        {!proof ? (
                          <button
                            onClick={() => openProof(order.id)}
                            className="w-full flex items-center justify-center gap-2 px-3 py-3 text-xs font-semibold text-getmeds-blue hover:bg-white"
                          >
                            {isImage ? <Receipt className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                            Show {order.payment_proof_file_name || 'the document'}
                          </button>
                        ) : isImage ? (
                          <a href={proof.viewUrl} target="_blank" rel="noopener noreferrer" className="block bg-white">
                            <img src={proof.viewUrl} alt={`Proof of payment for ${order.getmeds_order_id}`} className="max-h-80 w-auto mx-auto" />
                          </a>
                        ) : (
                          <div className="p-4 text-center">
                            <a href={proof.viewUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-getmeds-blue underline">
                              Open {proof.file_name || 'document'}
                            </a>
                          </div>
                        )}

                        {rejectingProofId === order.id ? (
                          <div className="border-t border-slate-200 p-3 space-y-2">
                            <label className="block text-xs font-semibold text-red-900">
                              What is wrong with this proof?
                            </label>
                            <textarea
                              autoFocus
                              rows={2}
                              value={proofReason}
                              onChange={(e) => setProofReason(e.target.value)}
                              placeholder="e.g. slip is for invoice INV-0042, not this order"
                              className="w-full text-sm rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
                            />
                            <div className="flex gap-2">
                              <button
                                disabled={!proofReason.trim() || proofBusy}
                                onClick={() => rejectProofMutation.mutate({ id: order.id, reason: proofReason.trim() })}
                                className="px-3 py-1.5 rounded-md bg-state-error text-white text-xs font-semibold disabled:opacity-50"
                              >
                                {proofBusy ? 'Rejecting…' : 'Ask for a new one'}
                              </button>
                              <button
                                onClick={() => { setRejectingProofId(null); setProofReason(''); }}
                                className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-ink-secondary"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="border-t border-slate-200 px-3 py-2">
                            <button
                              onClick={() => { setRejectingProofId(order.id); setProofReason(''); }}
                              className="text-xs font-semibold text-state-error hover:underline"
                            >
                              Reject this proof (without holding the order)
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {needsVerification && (
                    <div className="mt-3">
                      {rejectingId === order.id ? (
                        // The reason is the entire output of a rejection — it is
                        // what the MedRep and Management act on — so the API
                        // requires one and the button stays disabled without it.
                        <div className="rounded-md border border-state-error/40 bg-state-error-light p-3 space-y-2">
                          <label className="block text-xs font-semibold text-red-900">
                            Why is this order being held?
                          </label>
                          <textarea
                            autoFocus
                            rows={2}
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="e.g. ₱48,000 overdue past 60 days — collect before invoicing"
                            className="w-full text-sm rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
                          />
                          <div className="flex gap-2">
                            <button
                              disabled={!rejectReason.trim() || busy}
                              onClick={() => verifyMutation.mutate({ id: order.id, approved: false, reason: rejectReason.trim() })}
                              className="px-3 py-1.5 rounded-md bg-state-error text-white text-xs font-semibold disabled:opacity-50"
                            >
                              {busy ? 'Putting on hold…' : 'Put on hold'}
                            </button>
                            <button
                              onClick={() => { setRejectingId(null); setRejectReason(''); }}
                              className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-ink-secondary"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            disabled={busy}
                            onClick={() => verifyMutation.mutate({ id: order.id, approved: true })}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {busy ? 'Recording…' : 'Verify account'}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => { setRejectingId(order.id); setRejectReason(''); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-state-error/40 text-state-error text-xs font-semibold hover:bg-state-error-light disabled:opacity-50"
                          >
                            <XCircle className="w-3.5 h-3.5" /> Hold
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-start gap-2 text-xs text-ink-secondary bg-surface border border-slate-200 rounded-lg p-3">
        <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>Verifying here does not create anything in Zoho — it records that the account was checked and
          clears the order to be invoiced. Raising the Invoice, marking it Sent and recording the Customer
          Payment all still happen in Zoho Books, and this page follows along automatically. If an invoice
          appears in Zoho before anyone verifies here, the order moves on anyway and the timeline says so.</p>
      </div>
    </div>
  );
};

export default FinanceQueuePage;
