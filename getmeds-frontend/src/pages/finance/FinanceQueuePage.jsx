import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle, Clock, RefreshCw, FileText, Banknote, ExternalLink, Truck, ShieldCheck, XCircle, Receipt, FileSearch, ChevronLeft } from 'lucide-react';
import client from '../../api/client';
import OrderDetailsModal from '../../components/finance/OrderDetailsModal';
import { useSearchParams } from 'react-router-dom';
import { FINANCE_STAGES, financeStageLabel } from '../../constants/financeStages';

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

  /**
   * Sep 12, 2026: which order is open in the details panel.
   *
   * An id rather than the row object, so the panel always fetches fresh
   * detail and a freshly signed URL per attachment. Holding the row would
   * mean showing the queue's summary columns back as if they were the whole
   * order, which is exactly the gap this closes.
   */
  const [detailOrderId, setDetailOrderId] = useState(null);

  /**
   * Sep 12, 2026: this page stopped being a four-status queue.
   *
   * Finance and the MedRep need the same picture of an order. Previously an
   * order was invisible here until the moment it needed confirming and
   * invisible again afterwards, so "where did it go" had no answer on the one
   * screen Finance uses. Now every stage shows, filtered by these chips.
   *
   * What Finance can DO is unchanged and still narrow: confirm, and nothing
   * else. Seeing is not acting.
   */
  /**
   * Sep 12, 2026: the stage lives in the URL, not in component state.
   *
   * The sidebar's "Finance Confirmation" group links straight to a stage, so
   * the page has to be able to open already filtered. Keeping it in state
   * would mean those links landed on an unfiltered page and the selection had
   * to be re-applied by hand.
   *
   * It also makes a view shareable: "look at the on-hold ones" is now a link
   * somebody can paste, rather than an instruction to click two things.
   *
   * The server validates it independently — an unrecognised stage in a
   * hand-edited URL shows everything rather than nothing.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const stage = searchParams.get('stage') || null;
  const [page, setPage] = useState(1);

  // Paging is per-view, so a stage arriving from the URL must not land on
  // page 7 of the view that was open before it.
  useEffect(() => { setPage(1); }, [stage]);

  const { data, isLoading, refetch, isFetching } = useQuery({
    // Every input is part of the key, or a tab would serve another's rows.
    queryKey: ['finance-queue', origin, stage, page],
    queryFn: () =>
      client
        .get('/api/finance/queue', {
          params: {
            origin,
            stage: stage || undefined,
            page,
            // The dashboard renders no list, so it asks for the smallest page
            // the endpoint allows rather than 20 rows nobody sees — this
            // refetches every 30s, and on the Zoho tab those rows are drawn
            // from 60,948. stats, counts and `recent` are unaffected: they are
            // computed independently of the page.
            limit: stage ? undefined : 1,
          },
        })
        .then(r => r.data),
    refetchInterval: 30000,
    // Keeps the previous view's rows on screen while the next loads, so
    // switching does not flash the empty state. v5 spelling: the old
    // `keepPreviousData: true` option was removed and is silently ignored,
    // which looks like it works until you switch on a slow connection.
    placeholderData: keepPreviousData
  });
  const orders = data?.data?.orders || [];
  const counts = data?.data?.counts || { getmeds: 0, zoho: 0, total: 0 };
  const recent = data?.data?.recent || [];
  const stats = data?.data?.stats || {};
  const pagination = data?.data?.pagination || { page: 1, pages: 1, total: 0, limit: 20 };

  // Changing what is being listed must reset the pager, or switching to a tab
  // with fewer pages lands on an empty one that looks like no results.
  const chooseOrigin = (key) => { setOrigin(key); setPage(1); };
  const chooseStage = (key) => {
    // Clicking the selected stage again clears it — the cards are toggles, and
    // `replace` keeps that out of the browser's back history, where a trail of
    // filter changes is noise rather than navigation.
    const next = new URLSearchParams(searchParams);
    if (stage === key) next.delete('stage');
    else next.set('stage', key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  /**
   * The cards, in pipeline order. Mirrors the MedRep dashboard's shape
   * deliberately — same layout, Finance's meanings — with 'exceptions' pulled
   * out below as a banner rather than a card, exactly as that page does it.
   *
   * Keys and labels must match services/financeStages.js on the server, which
   * is what `stats` is keyed by.
   */
  const STAGE_ICONS = {
    actionable: { icon: ShieldCheck, color: 'bg-purple-100 text-purple-700' },
    upstream:   { icon: Clock,       color: 'bg-state-warning-light text-state-warning' },
    invoicing:  { icon: Receipt,     color: 'bg-getmeds-blue/15 text-getmeds-blue' },
    fulfilling: { icon: Truck,       color: 'bg-indigo-100 text-indigo-700' },
    completed:  { icon: CheckCircle, color: 'bg-pharmacy-green/15 text-pharmacy-green' },
    exceptions: { icon: XCircle,     color: 'bg-state-error-light text-state-error' },
  };
  // 'exceptions' is a banner below, not a card — same reason MedrepDashboardPage
  // keeps it out of its own row of cards: it is not a pipeline stage, it is
  // things that stopped.
  const STAGE_CARDS = FINANCE_STAGES
    .filter(g => g.key !== 'exceptions')
    .map(g => ({ ...g, title: g.label, ...STAGE_ICONS[g.key] }));

  const TABS = [
    {
      key: 'getmeds',
      label: 'Raised in GetMeds',
      count: counts.getmeds,
      hint: stage
        ? `Orders raised here at this stage.`
        : 'Orders your MedReps submitted here. This is the work.'
    },
    {
      key: 'zoho',
      label: 'Imported from Zoho',
      count: counts.zoho,
      hint: stage
        ? 'Imported Sales Orders at this stage. Reference only — they are maintained in Zoho.'
        : 'Historical Sales Orders brought over by the import. Reference only — they are maintained in Zoho.'
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
      // The details panel holds its own copy of the order; without this it
      // would still offer Confirm on an order just confirmed.
      qc.invalidateQueries({ queryKey: ['finance-order-detail'] });
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
    },

    // Sep 12, 2026: the stages BEFORE and AFTER Finance.
    //
    // This map used to hold only the four statuses the page could show, and
    // anything else fell through to "at an unexpected status". Now that every
    // stage is listed, that fallback would fire on most rows and describe a
    // perfectly normal completed order as a problem.
    //
    // Each says what Finance should do, and for most of them the answer is
    // nothing — which is worth saying plainly rather than leaving someone to
    // wonder whether a row is waiting on them.
    draft: {
      label: 'Draft — not submitted',
      hint: 'The MedRep has not sent this yet. Nothing for Finance.',
      icon: FileText,
      className: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    pending_management_approval: {
      label: 'Waiting for Management approval',
      hint: 'A manager has to approve it before it reaches Zoho, and Finance after that.',
      icon: Clock,
      className: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    submitted: {
      label: 'Submitted',
      hint: 'On its way to Zoho. Nothing for Finance yet.',
      icon: Clock,
      className: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    validating: {
      label: 'Validating',
      hint: 'Being checked before the Sales Order is raised. Nothing for Finance yet.',
      icon: Clock,
      className: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    so_pending: {
      label: 'Sales Order pending in Zoho',
      hint: 'Waiting on Zoho to accept the Sales Order. Nothing for Finance yet.',
      icon: Clock,
      className: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    so_created: {
      label: 'Sales Order created',
      hint: 'Raised in Zoho. It reaches Finance once it is confirmed there.',
      icon: Receipt,
      className: 'bg-slate-100 text-slate-700 border-slate-300'
    },
    picking_packing: {
      label: 'Picking and packing',
      hint: 'With the warehouse. Nothing for Finance unless the payment is still outstanding.',
      icon: Truck,
      className: 'bg-indigo-50 text-indigo-700 border-indigo-200'
    },
    dispatched: {
      label: 'Dispatched',
      hint: 'On the road to the customer. Nothing for Finance.',
      icon: Truck,
      className: 'bg-indigo-50 text-indigo-700 border-indigo-200'
    },
    tracking_shared: {
      label: 'Tracking shared',
      hint: 'The customer has the tracking details. Nothing for Finance.',
      icon: Truck,
      className: 'bg-indigo-50 text-indigo-700 border-indigo-200'
    },
    completed: {
      label: 'Completed',
      hint: 'Delivered and closed. Kept here so the order does not disappear once it is done.',
      icon: CheckCircle,
      className: 'bg-pharmacy-green/15 text-pharmacy-green-dark border-pharmacy-green/40'
    },
    on_hold: {
      label: 'On hold',
      hint: 'Someone paused this deliberately. The trail on the order says who and why.',
      icon: XCircle,
      className: 'bg-state-error-light text-red-800 border-state-error/40'
    },
    exception: {
      label: 'Exception',
      hint: 'Something went wrong and a human has to look. Open the details for the trail.',
      icon: XCircle,
      className: 'bg-state-error-light text-red-800 border-state-error/40'
    },
    cancelled: {
      label: 'Cancelled',
      hint: 'No longer going ahead. Shown so it is not mistaken for missing.',
      icon: XCircle,
      className: 'bg-state-error-light text-red-800 border-state-error/40'
    },
    deleted: {
      label: 'Deleted in Zoho',
      hint: 'The Sales Order was removed in Zoho. Shown so it is not mistaken for missing.',
      icon: XCircle,
      className: 'bg-state-error-light text-red-800 border-state-error/40'
    }
  };
  // Still here for a status the workflow gains that nobody wires up. It no
  // longer fires for anything in the state machine today — financeStages.js
  // has a test pinning that every status is accounted for.
  const stageInfo = (status) => STAGES[status] || {
    label: String(status || 'Unknown').replace(/_/g, ' '),
    hint: 'This order is at a status this page does not recognise yet.',
    icon: Clock,
    className: 'bg-slate-100 text-slate-700 border-slate-300'
  };



  return (
    <div className="space-y-6">
      {/* Sep 12, 2026: two views, not one scrolling page.
          Everything used to stack — cards, then the confirmation panel, then
          the tabs, then the list — so an order awaiting confirmation appeared
          TWICE on the same screen, once in the panel and once in the list,
          with a different button label on each. The dashboard now summarises
          and a stage page lists; neither shows an order the other is showing. */}
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          {stage ? (
            <>
              <button
                type="button"
                onClick={() => chooseStage(stage)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark mb-1"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Finance Confirmation
              </button>
              <h1 className="text-2xl font-semibold text-ink-primary">
                {financeStageLabel(stage) || 'Orders'}
              </h1>
              <p className="text-sm text-ink-secondary mt-1">
                {(FINANCE_STAGES.find(g => g.key === stage) || {}).sub || ''}
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold text-ink-primary">Finance Confirmation</h1>
              <p className="text-sm text-ink-secondary mt-1">
                Every order, at every stage — the same picture the MedRep has. Confirming the
                customer's account is yours; invoicing and payment happen in Zoho and appear here
                once Zoho reports them.
              </p>
            </>
          )}
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
            onClick={() => chooseOrigin(t.key)}
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

      {/* Sep 12, 2026: the same dashboard shape the MedRep gets, counting the
          things Finance acts on. Each card OPENS that stage rather than
          filtering in place — the number and the way to see what is behind it
          should not be two separate controls. */}
      {!stage && (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {STAGE_CARDS.map(card => {
          const Icon = card.icon;
          const active = stage === card.key;
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => chooseStage(card.key)}
              className="text-left bg-white rounded-xl border border-slate-200 p-4 transition-colors hover:border-getmeds-blue"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary leading-tight">
                  {card.title}
                </p>
                <div className={`p-1.5 rounded-lg shrink-0 ${card.color}`}>
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <p className="text-2xl font-bold text-ink-primary mt-2">{stats[card.key] ?? 0}</p>
              <p className="text-[11px] text-ink-secondary mt-0.5">{card.sub}</p>
            </button>
          );
        })}
      </div>
      )}

      {/* A banner rather than a sixth card, the way MedrepDashboardPage does
          it: these are not a pipeline stage, they are things that stopped. */}
      {!stage && stats.exceptions > 0 && (
        <button
          type="button"
          onClick={() => chooseStage('exceptions')}
          className={`w-full text-left rounded-xl border p-4 flex items-center justify-between gap-3 transition-colors ${
            stage === 'exceptions'
              ? 'border-state-error ring-1 ring-state-error bg-state-error-light'
              : 'border-state-error/30 bg-state-error-light hover:border-state-error'
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            <XCircle className="w-5 h-5 text-state-error shrink-0" />
            <span className="text-sm text-ink-primary">
              <span className="font-semibold">{stats.exceptions}</span> on hold, cancelled or in
              exception
            </span>
          </span>
          <span className="text-xs font-semibold text-state-error shrink-0">
            {stage === 'exceptions' ? 'Showing these' : 'Show these'}
          </span>
        </button>
      )}

      {/* Sep 12, 2026: the orders actually waiting on Finance, newest first.
          Served separately from the list below so it ignores the stage filter
          and the page — the work should not disappear because someone clicked
          "Completed" to check something, or paged to the end of 60,948
          imported orders. It does follow the origin tab, because an imported
          Zoho order sitting at this status is a historical record rather than
          a thing to do. */}
      {!stage && recent.length > 0 && (
        <div className="bg-white shadow rounded-lg border border-purple-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-purple-100 bg-purple-50 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-purple-700 shrink-0" />
            <h2 className="text-sm font-semibold text-purple-900">
              Needs your confirmation
              {stats.actionable > recent.length && (
                <span className="ml-1.5 font-normal text-purple-800">
                  · showing the {recent.length} most recent of {stats.actionable}
                </span>
              )}
            </h2>
            {stats.actionable > recent.length && (
              <button
                type="button"
                onClick={() => chooseStage('actionable')}
                className="ml-auto text-xs font-semibold text-purple-800 hover:text-purple-900"
              >
                See all {stats.actionable}
              </button>
            )}
          </div>

          <ul className="divide-y divide-purple-100">
            {recent.map(order => {
              const busy = verifyMutation.isPending && verifyMutation.variables?.id === order.id;
              return (
                <li key={order.id} className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-mono font-semibold text-getmeds-blue">
                      {order.getmeds_order_id}
                    </p>
                    <p className="text-[13px] text-ink-primary truncate">
                      {order.customer_name}
                      <span className="text-ink-secondary"> · {order.medrep_name}</span>
                    </p>
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-ink-primary">
                      ₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                    </p>
                    <p className="text-[11px] text-ink-secondary">Waiting {waitingHours(order)}</p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Details first, and deliberately: the attachments are
                        the evidence the confirmation rests on. */}
                    <button
                      type="button"
                      onClick={() => setDetailOrderId(order.id)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
                    >
                      <FileSearch className="w-3.5 h-3.5" /> Details & files
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => verifyMutation.mutate({ id: order.id, approved: true })}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {busy ? 'Confirming…' : 'Confirm'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}


      {/* The LIST is the stage page. On the dashboard it would repeat the
          orders the panel above already shows, which is exactly the
          duplication this split removes. */}
      {stage && (<>
      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-center gap-2">
          <Clock className="w-4 h-4 text-state-warning" />
          <h2 className="text-sm font-semibold text-ink-primary">
            {origin === 'zoho' ? 'Imported from Zoho' : 'Raised in GetMeds'}
            {/* The filtered total, not this page's row count — showing 20 on a
                list of 60,948 reads as though that is all there is. */}
            <span className="ml-1.5 font-normal text-ink-secondary">
              ({pagination.total.toLocaleString('en-PH')})
            </span>
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
                onClick={() => chooseOrigin('zoho')}
                className="mt-2 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
              >
                {counts.zoho} imported Zoho order{counts.zoho === 1 ? '' : 's'}{' '}
                {counts.zoho === 1 ? 'is' : 'are'} here too
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
                      {/* Sep 12, 2026: the row shows the proof of payment and
                          nothing else. An order can carry five other document
                          types, and a hospital order is required to carry four
                          — so the evidence Finance verifies against was not on
                          this screen at all. */}
                      <button
                        type="button"
                        onClick={() => setDetailOrderId(order.id)}
                        className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
                      >
                        <FileSearch className="w-3.5 h-3.5" /> Details & files
                      </button>
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
                            {busy ? 'Confirming…' : 'Confirm'}
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
        {/* Sep 12, 2026: this used to say verifying creates nothing in Zoho.
            It now does — confirming is what moves the Sales Order out of
            Draft, and leaving the old wording up would have been the screen
            telling Finance the opposite of what their click does. */}
        <p>Confirming here checks the customer&rsquo;s account and moves the Sales Order in Zoho from Draft to
          Confirmed, which is what releases it to be invoiced. Raising the Invoice, marking it Sent and
          recording the Customer Payment all still happen in Zoho Books, and this page follows along
          automatically. If Zoho is unreachable the confirmation still stands here and the sync is retried —
          the timeline says so either way.</p>
      </div>


      {/* Sep 12, 2026: needed from the moment this page widened to every
          status — the Zoho tab is 60,948 orders, where the old four-status
          queue could only ever be a few hundred. */}
      {pagination.pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink-secondary">
            Page {pagination.page} of {pagination.pages.toLocaleString('en-PH')} ·{' '}
            {pagination.total.toLocaleString('en-PH')} orders
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pagination.page <= 1 || isFetching}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={pagination.page >= pagination.pages || isFetching}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
      </>)}


      {/* Mounted once at page level, not per row: it would otherwise be
          instantiated for every row and is almost never open. */}
      {detailOrderId && (
        <OrderDetailsModal
          orderId={detailOrderId}
          onClose={() => setDetailOrderId(null)}
          // Confirming from the panel is the point of opening it: the
          // attachments are the evidence, and making someone close the
          // evidence to act on it is how people end up confirming from the
          // row without looking.
          onConfirm={(id) => verifyMutation.mutate({ id, approved: true })}
          confirming={verifyMutation.isPending}
        />
      )}
    </div>
  );
};

export default FinanceQueuePage;
