import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient, useIsFetching, keepPreviousData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldCheck, RefreshCw, Search, Download, ChevronLeft, ChevronRight, X
} from 'lucide-react';
import client from '../../api/client';
import OrderDetailsModal from '../../components/finance/OrderDetailsModal';
import FinanceConfirmModal from '../../components/finance/FinanceConfirmModal';
import MyConfirmationsPanel from '../../components/finance/MyConfirmationsPanel';
import SalesBySalespersonPanel from '../../components/finance/SalesBySalespersonPanel';
import { useSearchParams } from 'react-router-dom';
import { FINANCE_STAGES } from '../../constants/financeStages';
import { formatPHT } from '../../utils/dateUtils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const peso = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function humanDuration(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function msAgo(isoStr) {
  if (!isoStr) return null;
  return Date.now() - new Date(isoStr).getTime();
}

function relativeTime(isoStr) {
  if (!isoStr) return null;
  const ms = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Per-stage card descriptors (display labels + sub-titles matching the mockup)
const CARD_META = {
  actionable: { label: 'Awaiting you',        sub: 'Only Finance can clear' },
  upstream:   { label: 'Not yet with Finance', sub: 'With MedRep or Zoho' },
  invoicing:  { label: 'Invoicing in Zoho',    sub: 'Confirmed, being invoiced' },
  fulfilling: { label: 'In fulfilment',         sub: 'Packing and on the road' },
  completed:  { label: 'Completed',             sub: 'Delivered and closed' },
  exceptions: { label: 'Needs attention',       sub: 'On hold, cancelled, exception' },
};

// The time column header and value depend on the active stage.
function timeCol(order, stageKey) {
  if (stageKey === 'actionable') {
    const ms = msAgo(order.submitted_at);
    return { label: 'Waiting', value: humanDuration(ms), overdue: (ms || 0) > 2 * 3_600_000 };
  }
  if (stageKey === 'invoicing') {
    return { label: 'Since confirmed', value: humanDuration(msAgo(order.finance_confirmed_at)), overdue: false };
  }
  if (stageKey === 'fulfilling') {
    return { label: 'In stage', value: humanDuration(msAgo(order.updated_at)), overdue: false };
  }
  if (stageKey === 'completed') {
    return {
      label: 'Completed',
      value: order.updated_at ? formatPHT(order.updated_at, 'short-date') : '—',
      overdue: false,
    };
  }
  return { label: 'Time', value: humanDuration(msAgo(order.updated_at)), overdue: false };
}

// Status badge colours
const PILL_STYLES = {
  ready_for_finance_verified: 'bg-purple-100 text-purple-800',
  ready_for_draft_invoice:    'bg-amber-100 text-amber-800',
  ready_for_invoice_sent:     'bg-blue-100 text-blue-800',
  ready_for_dispatch:         'bg-indigo-100 text-indigo-700',
  picking_packing:            'bg-indigo-50 text-indigo-700',
  dispatched:                 'bg-indigo-50 text-indigo-700',
  tracking_shared:            'bg-indigo-50 text-indigo-700',
  completed:                  'bg-pharmacy-green/15 text-pharmacy-green-dark',
  on_hold:                    'bg-state-error-light text-red-800',
  exception:                  'bg-state-error-light text-red-800',
  cancelled:                  'bg-state-error-light text-red-800',
  deleted:                    'bg-state-error-light text-red-800',
};
const PILL_LABELS = {
  ready_for_finance_verified: 'Awaiting you',
  ready_for_draft_invoice:    'Invoicing',
  ready_for_invoice_sent:     'Invoice sent',
  ready_for_dispatch:         'Awaiting dispatch',
  picking_packing:            'Picking & packing',
  dispatched:                 'Dispatched',
  tracking_shared:            'Tracking shared',
  completed:                  'Completed',
  on_hold:                    'On hold',
  exception:                  'Exception',
  cancelled:                  'Cancelled',
  deleted:                    'Deleted in Zoho',
  draft:                      'Draft',
  submitted:                  'Submitted',
  validating:                 'Validating',
  so_pending:                 'SO pending',
  so_created:                 'SO created',
  pending_management_approval:'Pending approval',
};

const StagePill = ({ status }) => {
  const cls = PILL_STYLES[status] || 'bg-slate-100 text-slate-700';
  const lbl = PILL_LABELS[status] || String(status || '').replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {lbl}
    </span>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const FinanceQueuePage = () => {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const view  = searchParams.get('view')   || null;         // 'mine' | 'reports' | null
  const stage = searchParams.get('stage')  || 'actionable'; // default to actionable
  const source = searchParams.get('source') || 'getmeds';   // 'getmeds' | 'zoho' | 'all'
  const search = searchParams.get('q')     || '';
  const page   = Math.max(1, parseInt(searchParams.get('page') || '1', 10));

  const setParam = (key, value, resetPage = false) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, String(value)); else next.delete(key);
      if (resetPage) next.delete('page');
      return next;
    }, { replace: true });
  };

  const closeView = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('view');
      return next;
    }, { replace: true });
  };

  const [detailOrderId, setDetailOrderId] = useState(null);
  const [confirmOrder, setConfirmOrder]   = useState(null); // order for FinanceConfirmModal
  const undoTimerRef = useRef(null);

  // ── Main queue query ────────────────────────────────────────────────────────
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['finance-orders', stage, source, search, page],
    queryFn: () =>
      client.get('/api/finance/queue', {
        params: {
          stage,
          origin: source === 'all' ? 'all' : source,
          search: search || undefined,
          page,
          limit: 25,
        },
      }).then((r) => r.data),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    enabled: !view, // don't poll while in a sub-view
  });

  // ── Sales summary (header totals) ──────────────────────────────────────────
  const { data: summaryData } = useQuery({
    queryKey: ['finance-sales-summary'],
    queryFn: () => client.get('/api/finance/sales-summary').then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const orders     = data?.data?.orders     || [];
  const stats      = data?.data?.stats      || {};
  const pagination = data?.data?.pagination || { page: 1, pages: 1, total: 0, limit: 25 };
  const workflowV2 = Boolean(data?.data?.workflow_v2);
  const zohoSyncedAt = data?.data?.zoho_synced_at || null;

  const monthTotal = Number(summaryData?.data?.month?.total || 0);
  const monthCount = Number(summaryData?.data?.month?.count || 0);
  const todayTotal = Number(summaryData?.data?.today?.total || 0);
  const monthFrom  = summaryData?.data?.month?.from;
  const monthLabel = monthFrom
    ? new Date(monthFrom + 'T12:00:00+08:00').toLocaleDateString('en-PH', {
        month: 'long', year: 'numeric', timeZone: 'Asia/Manila'
      })
    : 'This month';

  // ── Fetching indicator for sub-views ───────────────────────────────────────
  const mineFetching    = useIsFetching({ queryKey: ['finance-my-confirmations'] }) > 0;
  const reportsFetching = useIsFetching({ queryKey: ['finance-sales-by-salesperson'] }) > 0;
  const activeIsFetching = view === 'mine' ? mineFetching
    : view === 'reports' ? reportsFetching
    : isFetching;

  const handleRefresh = () => {
    if (view === 'mine')    qc.invalidateQueries({ queryKey: ['finance-my-confirmations'] });
    else if (view === 'reports') qc.invalidateQueries({ queryKey: ['finance-sales-by-salesperson'] });
    else {
      refetch();
      qc.invalidateQueries({ queryKey: ['finance-sales-summary'] });
    }
  };

  // ── Verify mutation ─────────────────────────────────────────────────────────
  const verifyMutation = useMutation({
    mutationFn: ({ id, approved, reason }) =>
      client.post(`/api/finance/orders/${id}/verify`, {
        approved, reason,
        pricesChecked: approved ? true : undefined,
        proofChecked:  approved ? true : undefined,
      }).then((r) => r.data),
    onSuccess: (res, vars) => {
      const orderId = vars.id;

      qc.invalidateQueries({ queryKey: ['finance-order-detail'] });
      qc.invalidateQueries({ queryKey: ['finance-sales-summary'] });

      if (vars.approved) {
        const orderRef  = orders.find((o) => o.id === orderId)?.getmeds_order_id || `#${orderId}`;
        const custName  = orders.find((o) => o.id === orderId)?.customer_name || '';

        // Optimistically remove from the current list and adjust the count
        qc.setQueryData(['finance-orders', stage, source, search, page], (old) => {
          if (!old) return old;
          return {
            ...old,
            data: {
              ...old.data,
              orders: old.data.orders.filter((o) => o.id !== orderId),
              stats: {
                ...old.data.stats,
                actionable: Math.max(0, (old.data.stats.actionable || 0) - 1),
              },
              pagination: {
                ...old.data.pagination,
                total: Math.max(0, old.data.pagination.total - 1),
              },
            },
          };
        });

        setDetailOrderId(null);
        setConfirmOrder(null);

        // Undo toast — 8 seconds
        const zohoConfirm = res?.data?.zohoConfirmed;
        const zohoFailed  = zohoConfirm && zohoConfirm.ok === false;

        let toastId;
        toastId = toast.custom(
          (t) => (
            <div
              className={`${t.visible ? 'opacity-100' : 'opacity-0'} transition-opacity flex items-center gap-3 bg-white border border-slate-200 rounded-lg shadow-lg px-4 py-3 text-sm max-w-sm`}
            >
              <ShieldCheck className="w-4 h-4 text-pharmacy-green shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-ink-primary font-semibold truncate">{orderRef} confirmed</p>
                {custName && <p className="text-ink-secondary text-xs truncate">{custName}</p>}
                {zohoFailed && (
                  <p className="text-xs text-state-error mt-0.5">
                    Zoho not updated yet — confirm the SO there too.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  toast.dismiss(toastId);
                  if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
                  unverifyMutation.mutate({ id: orderId });
                }}
                className="shrink-0 text-xs font-bold text-getmeds-blue hover:text-getmeds-blue-dark"
              >
                Undo
              </button>
            </div>
          ),
          { duration: 8_000, position: 'bottom-right' }
        );

        undoTimerRef.current = setTimeout(() => {
          // After undo window, do a hard refetch to sync any optimistic state
          qc.invalidateQueries({ queryKey: ['finance-orders'] });
        }, 8_500);
      } else {
        // Hold
        toast.success('Order put on hold.');
        setDetailOrderId(null);
        qc.invalidateQueries({ queryKey: ['finance-orders'] });
      }
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not record that'),
  });

  // ── Unverify mutation (undo) ────────────────────────────────────────────────
  const unverifyMutation = useMutation({
    mutationFn: ({ id }) =>
      client.post(`/api/finance/orders/${id}/unverify`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance-orders'] });
      qc.invalidateQueries({ queryKey: ['finance-sales-summary'] });
      toast.success('Confirmation reversed — order is back in the queue.');
    },
    onError: (err) =>
      toast.error(err.response?.data?.error?.message || 'Could not undo — the order may have moved on.'),
  });

  const handleConfirmSubmit = () => {
    if (!confirmOrder) return;
    verifyMutation.mutate({ id: confirmOrder.id, approved: true });
  };

  const handleHold = (id, reason) => {
    verifyMutation.mutate({ id, approved: false, reason });
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const currentCard = CARD_META[stage] || CARD_META.actionable;
  const thCol       = timeCol(orders[0] || {}, stage); // for header label
  const showingFrom = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const showingTo   = Math.min(pagination.page * pagination.limit, pagination.total);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          {view === 'mine' ? (
            <>
              <h1 className="text-2xl font-semibold text-ink-primary">My Confirmations</h1>
              <p className="text-sm text-ink-secondary mt-0.5">Orders you have confirmed or held.</p>
            </>
          ) : view === 'reports' ? (
            <>
              <h1 className="text-2xl font-semibold text-ink-primary">Reports</h1>
              <p className="text-sm text-ink-secondary mt-0.5">Sales by salesperson.</p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold text-ink-primary">Orders</h1>
              <p className="text-sm text-ink-secondary mt-0.5">
                {monthLabel} ·{' '}
                <span className="font-medium text-ink-primary">{peso(monthTotal)}</span>
                {' '}confirmed ({monthCount.toLocaleString('en-PH')} orders) · Today{' '}
                <span className="font-medium text-ink-primary">{peso(todayTotal)}</span>
              </p>
            </>
          )}
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {!view && zohoSyncedAt && (
            <span className="text-xs text-ink-secondary hidden sm:block">
              Zoho synced {relativeTime(zohoSyncedAt)}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary"
          >
            <RefreshCw className={`w-4 h-4 ${activeIsFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Sub-views: My Confirmations / Reports ──────────────────────────── */}
      {view === 'mine'    && <MyConfirmationsPanel    onClose={closeView} />}
      {view === 'reports' && <SalesBySalespersonPanel onClose={closeView} />}

      {/* ── Main Orders view ───────────────────────────────────────────────── */}
      {!view && (<>

        {/* Stage cards — all 6, one always selected */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {FINANCE_STAGES.map((card) => {
            const isSelected  = stage === card.key;
            const isException = card.key === 'exceptions';
            const count = stats[card.key] ?? 0;
            const meta  = CARD_META[card.key] || {};
            return (
              <button
                key={card.key}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setParam('stage', card.key, true)}
                className={`text-left rounded-xl border p-4 transition-all ${
                  isSelected
                    ? 'border-getmeds-blue bg-getmeds-blue/5 ring-1 ring-getmeds-blue'
                    : isException
                    ? 'border-state-error/30 bg-white hover:border-state-error/60 hover:shadow-sm'
                    : 'border-slate-200 bg-white hover:border-getmeds-blue/50 hover:shadow-sm'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <p className={`text-[10px] font-bold uppercase tracking-wider leading-tight ${
                    isException ? 'text-state-error' : isSelected ? 'text-getmeds-blue-dark' : 'text-ink-secondary'
                  }`}>
                    {meta.label}
                  </p>
                  {isSelected && <span className="w-2 h-2 rounded-full bg-getmeds-blue shrink-0 mt-0.5" />}
                </div>
                <p className={`text-2xl font-bold mt-2 tabular-nums ${
                  isException ? 'text-state-error' : 'text-ink-primary'
                }`}>
                  {count.toLocaleString('en-PH')}
                </p>
                <p className="text-[11px] text-ink-secondary mt-0.5 leading-tight">{meta.sub}</p>
              </button>
            );
          })}
        </div>

        {/* Order table */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">

          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
            {/* Title */}
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold text-ink-primary">
                {currentCard.label}
                <span className="ml-1.5 font-normal text-ink-secondary">
                  · {pagination.total.toLocaleString('en-PH')} orders
                </span>
              </h2>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-secondary pointer-events-none" />
              <input
                type="search"
                placeholder="Order #, customer, MedRep"
                value={search}
                onChange={(e) => setParam('q', e.target.value || null, true)}
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md w-52 focus:outline-none focus:ring-1 focus:ring-getmeds-blue text-ink-primary placeholder:text-ink-secondary"
              />
            </div>

            {/* Source filter — GetMeds is the default */}
            <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs font-semibold">
              {[
                { key: 'getmeds', label: 'GetMeds' },
                { key: 'zoho',    label: 'Zoho' },
                { key: 'all',     label: 'All' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setParam('source', key === 'getmeds' ? null : key, true)}
                  className={`px-3 py-1.5 transition-colors ${
                    source === key
                      ? 'bg-getmeds-blue text-white'
                      : 'bg-white text-ink-secondary hover:bg-surface hover:text-ink-primary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Export CSV (stub) */}
            <button
              type="button"
              onClick={() => toast('CSV export coming soon', { icon: '📋' })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-md text-ink-secondary hover:bg-surface hover:text-ink-primary"
            >
              <Download className="w-3.5 h-3.5" /> Export CSV
            </button>
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="flex justify-center py-14">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-14 text-ink-secondary">
              <p className="text-sm">No orders match this stage{source !== 'all' ? ` and source` : ''}{search ? ' and search' : ''}.</p>
              {search && (
                <button
                  type="button"
                  onClick={() => setParam('q', null)}
                  className="mt-2 text-xs font-semibold text-getmeds-blue hover:underline"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-[13px]">
                <thead>
                  <tr className="bg-surface border-b border-slate-200">
                    <th className="px-4 py-2.5 text-left font-semibold text-ink-secondary text-[11px] uppercase tracking-wide">
                      Order #
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-ink-secondary text-[11px] uppercase tracking-wide">
                      Customer
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-ink-secondary text-[11px] uppercase tracking-wide hidden md:table-cell">
                      MedRep
                    </th>
                    <th className="px-4 py-2.5 text-right font-semibold text-ink-secondary text-[11px] uppercase tracking-wide">
                      Amount
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-ink-secondary text-[11px] uppercase tracking-wide hidden lg:table-cell">
                      Stage
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-ink-secondary text-[11px] uppercase tracking-wide">
                      {timeCol({}, stage).label}
                    </th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {orders.map((order) => {
                    const tc = timeCol(order, stage);
                    const isZoho = order.is_zoho_import;
                    return (
                      <tr
                        key={order.id}
                        className="hover:bg-surface/50 transition-colors cursor-pointer"
                        onClick={() => setDetailOrderId(order.id)}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-semibold text-getmeds-blue">
                              {order.getmeds_order_id}
                            </span>
                            {isZoho && (
                              <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded tracking-wide">
                                ZOHO
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-ink-primary max-w-[180px] truncate">
                          {order.customer_name}
                        </td>
                        <td className="px-4 py-3 text-ink-secondary hidden md:table-cell max-w-[140px] truncate">
                          {order.medrep_name || '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-ink-primary tabular-nums whitespace-nowrap">
                          {peso(order.total_amount)}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <StagePill status={order.status} />
                        </td>
                        <td className={`px-4 py-3 font-mono text-xs tabular-nums ${
                          tc.overdue ? 'text-state-error font-bold' : 'text-ink-secondary'
                        }`}>
                          {tc.value}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDetailOrderId(order.id); }}
                            className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-md text-ink-secondary hover:bg-surface hover:text-ink-primary whitespace-nowrap"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {pagination.total > 0 && (
            <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between gap-3 text-xs text-ink-secondary">
              <p>
                {pagination.total > 0
                  ? `Showing ${showingFrom.toLocaleString('en-PH')}–${showingTo.toLocaleString('en-PH')} of ${pagination.total.toLocaleString('en-PH')}`
                  : 'No orders'}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pagination.page <= 1 || isFetching}
                  onClick={() => setParam('page', String(page - 1))}
                  className="flex items-center gap-1 px-3 py-1.5 border border-slate-200 rounded-md font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Previous
                </button>
                <button
                  type="button"
                  disabled={pagination.page >= pagination.pages || isFetching}
                  onClick={() => setParam('page', String(page + 1))}
                  className="flex items-center gap-1 px-3 py-1.5 border border-slate-200 rounded-md font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

      </>)}

      {/* ── Details drawer ─────────────────────────────────────────────────── */}
      {detailOrderId && (
        <OrderDetailsModal
          orderId={detailOrderId}
          onClose={() => setDetailOrderId(null)}
          onOpenConfirm={(order) => setConfirmOrder(order)}
          onConfirm={(id, panelChecks) =>
            verifyMutation.mutate({ id, approved: true, pricesChecked: panelChecks?.prices, proofChecked: panelChecks?.proof })
          }
          onReject={(id, reason) => verifyMutation.mutate({ id, approved: false, reason })}
          confirming={verifyMutation.isPending}
          workflowV2={workflowV2}
        />
      )}

      {/* ── Confirm modal ──────────────────────────────────────────────────── */}
      {confirmOrder && (
        <FinanceConfirmModal
          order={confirmOrder}
          confirming={verifyMutation.isPending}
          onClose={() => setConfirmOrder(null)}
          onConfirm={handleConfirmSubmit}
          workflowV2={workflowV2}
        />
      )}
    </div>
  );
};

export default FinanceQueuePage;
