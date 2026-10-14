import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Plus, RefreshCw, Search, X, ChevronLeft, ChevronRight } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { formatPHT } from '../../utils/dateUtils';

const STATUS_COLORS = {
  draft: 'bg-slate-100 text-slate-700 border border-slate-300',
  submitted: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  validating: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_pending: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_created: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  waiting_for_payment: 'bg-state-warning-light text-amber-950 border border-state-warning font-semibold',
  payment_verified: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30',
  ready_for_dispatch: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  picking_packing: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  dispatched: 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40',
  tracking_shared: 'bg-teal-50 text-teal-800 border border-teal-200',
  completed: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/40',
  on_hold: 'bg-state-error-light text-red-800 border border-state-error/30',
  exception: 'bg-state-error-light text-red-950 border border-state-error font-bold',
  cancelled: 'bg-state-error-light text-red-700 border border-state-error/30',
  deleted: 'bg-slate-200 text-slate-600 border border-slate-400',
};

// Oct 8, 2026: a draft Management deleted stays here for one day (see deletedDraftPurge.js).
const removedBy = (at) => new Date(new Date(at).getTime() + 24 * 60 * 60 * 1000)
  .toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const PAGE_SIZE = 15;

// Sep 28, 2026: "Showing 1–15 of 10,108" with Previous / Next — see the same
// pattern on the Dispatch queue page (pages/dispatch/DispatchQueuePage.jsx).
const Pager = ({ pagination, onPage }) => {
  if (!pagination || pagination.total <= pagination.limit) return null;
  const { page, pages, total, limit } = pagination;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const btn = 'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-ink-primary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-2xs';
  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 bg-surface">
      <p className="text-xs text-ink-secondary text-center sm:text-left">
        Showing <span className="font-semibold text-ink-primary">{from.toLocaleString()}–{to.toLocaleString()}</span> of{' '}
        <span className="font-semibold text-ink-primary">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center justify-center gap-2">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="w-3.5 h-3.5" /> Previous
        </button>
        <span className="text-xs text-ink-secondary tabular-nums px-1">Page {page} of {pages.toLocaleString()}</span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

const MyOrdersPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState('');
  // Sep 15, 2026: for Dispatch, "My Orders" is the orders they cater (take
  // on from the Dispatch page), so each person can focus on theirs; "All
  // orders" is the old log. Everyone else sees this page as before.
  const isDispatch = String(user?.role || '').toLowerCase() === 'dispatch';
  const [dispatchView, setDispatchView] = useState('mine');
  const cateredOnly = isDispatch && dispatchView === 'mine';

  /**
   * Sep 12, 2026. This list now holds two kinds of order: the rep's own, and
   * the ones they raised for a colleague. Both belong here — the rep who typed
   * an order in has to be able to find it again — but an unlabelled row under
   * somebody else's customer reads as a bug, so each says which it is.
   *
   * raised_by_id is NULL for an ordinary order, so only genuinely on-behalf
   * rows are ever labelled.
   */
  const behalfLabel = (order) => {
    if (!order.raised_by_id || !user) return null;
    if (String(order.raised_by_id) === String(user.id)) {
      return { text: `for ${order.medrep_name || 'a colleague'}`, own: false };
    }
    if (String(order.medrep_id) === String(user.id)) {
      return { text: `raised by ${order.raised_by_name || 'a colleague'}`, own: true };
    }
    return null;
  };

  // Sep 25, 2026: search by order id, customer, SO number or receiver. Typed
  // into one box and sent to the server after a short pause, so it searches
  // every order and not only the ones already on screen.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Sep 28, 2026: paged at 15 rows, all-time — this used to ask for no page or
  // limit at all, so the server's default of 20 quietly capped the table to
  // its newest 20 rows, which on a busy day read as "orders older than
  // 2 days are missing" rather than a page 1 of many.
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [statusFilter, cateredOnly, search]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['my-orders', statusFilter, cateredOnly, search, page],
    queryFn: () =>
      client
        .get('/api/orders', {
          params: {
            status: statusFilter || undefined, catered: cateredOnly ? 'mine' : undefined,
            search: search || undefined, page, limit: PAGE_SIZE
          }
        })
        .then(r => r.data),
    // Keeps the last rows on screen while the next search loads, so typing does
    // not flash the table away.
    placeholderData: keepPreviousData,
    refetchInterval: 60000 // was 30000 (Oct 3, 2026: lighter polling)
  });

  const orders = data?.data?.orders || [];
  const pagination = data?.data?.pagination || null;

  const statuses = [
    'draft', 'submitted', 'waiting_for_payment', 'payment_verified',
    'ready_for_dispatch', 'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled'
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-ink-primary">{isDispatch ? 'My Catered Orders' : 'My Orders'}</h1>
          <p className="text-xs sm:text-sm text-ink-secondary mt-0.5">
            {isDispatch
              ? 'The orders you cater. Take one on with "Cater this order" on the Dispatch page; open one to update its tracking.'
              : 'Track status of orders you have submitted.'}
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button onClick={() => refetch()} className="flex-1 sm:flex-none justify-center flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-lg text-xs sm:text-sm font-medium text-ink-secondary hover:bg-surface hover:text-ink-primary transition-colors bg-white shadow-2xs">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          {!isDispatch && (
            <button onClick={() => navigate('/orders/new')} className="flex-1 sm:flex-none justify-center flex items-center gap-1.5 px-3.5 py-2 bg-getmeds-blue text-white rounded-lg text-xs sm:text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors shadow-sm">
              <Plus className="w-4 h-4" /> New Order
            </button>
          )}
        </div>
      </div>

      {isDispatch && (
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="tablist">
          {[['mine', 'Catered by me'], ['all', 'All orders']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={dispatchView === key}
              onClick={() => setDispatchView(key)}
              className={`px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold transition-colors ${dispatchView === key ? 'bg-getmeds-blue text-white shadow-xs' : 'text-ink-secondary hover:bg-surface'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary pointer-events-none" />
        <input
          id="orders-search"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search order ID, customer, SO number or receiver…"
          aria-label="Search orders by order ID, customer, SO number or receiver"
          className="w-full pl-9 pr-9 py-2 text-xs sm:text-sm bg-white border border-slate-200 rounded-lg text-ink-primary placeholder:text-ink-secondary/70 focus:outline-none focus:ring-2 focus:ring-getmeds-blue transition-colors"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => setSearchInput('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-ink-secondary hover:text-ink-primary hover:bg-surface"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filter Chips - horizontally scrollable on mobile */}
      <div className="flex gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar py-1 flex-nowrap sm:flex-wrap">
        <button
          onClick={() => setStatusFilter('')}
          className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${!statusFilter ? 'bg-getmeds-blue text-white shadow-2xs' : 'bg-white border border-slate-200 text-ink-secondary hover:bg-surface'}`}
        >All</button>
        {statuses.map(s => (
          <button key={s} onClick={() => setStatusFilter(s === statusFilter ? '' : s)}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium capitalize whitespace-nowrap transition-colors ${statusFilter === s ? 'bg-getmeds-blue text-white shadow-2xs' : 'bg-white border border-slate-200 text-ink-secondary hover:bg-surface'}`}
          >{s.replace(/_/g, ' ')}</button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">Failed to load orders.</div>
      ) : orders.length === 0 && search ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200 shadow-sm">
          <p className="text-ink-secondary text-sm">No orders match &ldquo;{search}&rdquo;{statusFilter ? ' at this status' : ''}.</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          {cateredOnly ? (
            <>
              <p className="text-ink-secondary mb-4 text-sm">You are not catering any orders{statusFilter ? ' at this status' : ''} yet.</p>
              <button onClick={() => navigate('/dispatch')} className="px-4 py-2 bg-getmeds-blue text-white rounded-lg text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors">
                Pick orders on the Dispatch page
              </button>
            </>
          ) : (
            <>
              <p className="text-ink-secondary mb-4 text-sm">No orders found.</p>
              {!isDispatch && (
                <button onClick={() => navigate('/orders/new')} className="px-4 py-2 bg-getmeds-blue text-white rounded-lg text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors">
                  Create Your First Order
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          {/* Mobile Card List View (visible on < md screens) */}
          <div className="md:hidden space-y-3">
            {orders.map(order => (
              <div
                key={order.id}
                onClick={() => navigate(`/orders/${order.id}`)}
                className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs hover:border-getmeds-blue/50 transition-all cursor-pointer active:bg-slate-50"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <span className="text-sm font-mono font-bold text-getmeds-blue">
                      {order.getmeds_order_id}
                    </span>
                    <span className="block text-[11px] text-ink-secondary mt-0.5">
                      {formatPHT(order.created_at, 'date')}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold capitalize ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-700'}`}>
                      {order.status?.replace(/_/g, ' ')}
                    </span>
                    {order.payment_status && (
                      <span className={`px-2 py-0.2 rounded-full text-[10px] font-medium ${order.payment_status === 'verified' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : order.payment_status === 'rejected' ? 'bg-state-error-light text-red-700' : 'bg-state-warning-light text-amber-900'}`}>
                        {order.payment_status}
                      </span>
                    )}
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-2 mb-2">
                  <p className="text-sm font-semibold text-ink-primary">
                    {order.customer_name}
                    {behalfLabel(order) && (
                      <span className={`ml-1.5 align-middle px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${behalfLabel(order).own ? 'bg-slate-100 text-ink-secondary' : 'bg-getmeds-blue/10 text-getmeds-blue-dark'}`}>
                        {behalfLabel(order).text}
                      </span>
                    )}
                  </p>
                  {(order.intake_receiver || order.intake_contact_no) && (
                    <p className="text-xs text-ink-secondary mt-0.5">
                      Receiver: {order.intake_receiver || '—'} {order.intake_contact_no ? `· ${order.intake_contact_no}` : ''}
                    </p>
                  )}
                  {order.status === 'draft' && order.stock_hold_at && (
                    <p className="text-[11px] font-semibold text-amber-800 mt-1">
                      ⏳ Waiting for stock{order.stock_hold_item ? `: ${order.stock_hold_item}` : ''}
                    </p>
                  )}
                  {order.draft_cancel_kind === 'deleted' && (
                    <p className="text-[11px] text-ink-secondary mt-1">
                      Removed when you read notice, or {removedBy(order.draft_cancelled_at)}
                    </p>
                  )}
                  {order.draft_cancel_kind === 'keep_record' && (
                    <p className="text-[11px] font-semibold text-ink-secondary mt-1">
                      {order.refund_status === 'done' ? 'Refund done' : order.refund_status === 'not_due' ? 'No refund due' : 'Refund pending'}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-xs font-medium text-ink-secondary">Total Amount</span>
                  <span className="text-base font-bold text-ink-primary font-mono">
                    ₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            ))}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
              <Pager pagination={pagination} onPage={setPage} />
            </div>
          </div>

          {/* Desktop Table View (visible on md+ screens) */}
          <div className="hidden md:block bg-white shadow rounded-lg overflow-hidden border border-slate-200">
            <div className="overflow-x-auto thin-scroll">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-surface">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Receiver</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Total</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Payment</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {orders.map(order => (
                    <tr
                      key={order.id}
                      onClick={() => navigate(`/orders/${order.id}`)}
                      className="cursor-pointer hover:bg-surface transition-colors"
                    >
                      <td className="px-4 py-3 text-sm font-mono font-semibold">
                        <Link
                          to={`/orders/${order.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-getmeds-blue hover:text-getmeds-blue-dark hover:underline"
                        >
                          {order.getmeds_order_id}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-ink-primary">
                        {order.customer_name}
                        {behalfLabel(order) && (
                          <span
                            className={`ml-2 align-middle px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                              behalfLabel(order).own
                                ? 'bg-slate-100 text-ink-secondary'
                                : 'bg-getmeds-blue/10 text-getmeds-blue-dark'
                            }`}
                          >
                            {behalfLabel(order).text}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-ink-primary">
                        {order.intake_receiver || order.intake_contact_no ? (
                          <>
                            {order.intake_receiver && <div>{order.intake_receiver}</div>}
                            {order.intake_contact_no && <div className="text-xs text-ink-secondary">{order.intake_contact_no}</div>}
                          </>
                        ) : (
                          <span className="text-ink-secondary/60" title="No separate receiver on this order">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-700'}`}>
                          {order.status?.replace(/_/g, ' ')}
                        </span>
                        {order.status === 'draft' && order.stock_hold_at && (
                          <span className="block mt-1 text-[11px] font-semibold text-amber-800" title={order.stock_hold_reason || ''}>
                            ⏳ Waiting for stock{order.stock_hold_item ? `: ${order.stock_hold_item}` : ''}
                          </span>
                        )}
                        {order.draft_cancel_kind === 'deleted' && (
                          <span className="block mt-1 text-[11px] text-ink-secondary" title={order.draft_cancel_reason || ''}>
                            Removed when you read the notice, or {removedBy(order.draft_cancelled_at)}
                          </span>
                        )}
                        {order.draft_cancel_kind === 'keep_record' && (
                          <span className="block mt-1 text-[11px] font-semibold text-ink-secondary">
                            {order.refund_status === 'done' ? 'Refund done' : order.refund_status === 'not_due' ? 'No refund due' : 'Refund pending'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                      <td className="px-4 py-3">
                        {order.payment_status ? (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${order.payment_status === 'verified' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : order.payment_status === 'rejected' ? 'bg-state-error-light text-red-700' : 'bg-state-warning-light text-amber-900'}`}>
                            {order.payment_status}
                          </span>
                        ) : <span className="text-ink-secondary/60 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-secondary">
                        {formatPHT(order.created_at, 'date')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager pagination={pagination} onPage={setPage} />
          </div>
        </>
      )}
    </div>
  );
};

export default MyOrdersPage;
