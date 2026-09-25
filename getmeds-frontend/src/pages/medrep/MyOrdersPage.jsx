import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Plus, RefreshCw, Search, X } from 'lucide-react';
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

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['my-orders', statusFilter, cateredOnly, search],
    queryFn: () =>
      client
        .get('/api/orders', {
          params: { status: statusFilter || undefined, catered: cateredOnly ? 'mine' : undefined, search: search || undefined }
        })
        .then(r => r.data),
    // Keeps the last rows on screen while the next search loads, so typing does
    // not flash the table away.
    placeholderData: keepPreviousData,
    refetchInterval: 30000
  });

  const orders = data?.data?.orders || [];

  const statuses = [
    'draft', 'submitted', 'waiting_for_payment', 'payment_verified',
    'ready_for_dispatch', 'picking_packing', 'dispatched', 'tracking_shared',
    'completed', 'on_hold', 'exception', 'cancelled'
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">{isDispatch ? 'My Catered Orders' : 'My Orders'}</h1>
          <p className="text-sm text-ink-secondary mt-1">
            {isDispatch
              ? 'The orders you cater. Take one on with "Cater this order" on the Dispatch page; open one to update its tracking.'
              : 'Track status of orders you have submitted.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          {!isDispatch && (
            <button onClick={() => navigate('/orders/new')} className="flex items-center gap-1.5 px-3.5 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors shadow-sm">
              <Plus className="w-4 h-4" /> New Order
            </button>
          )}
        </div>
      </div>

      {isDispatch && (
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5" role="tablist">
          {[['mine', 'Catered by me'], ['all', 'All orders']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={dispatchView === key}
              onClick={() => setDispatchView(key)}
              className={`px-3 py-1.5 rounded text-sm font-semibold ${dispatchView === key ? 'bg-getmeds-blue text-white' : 'text-ink-secondary hover:bg-surface'}`}
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
          className="w-full pl-9 pr-9 py-2 text-sm bg-white border border-slate-200 rounded-lg text-ink-primary placeholder:text-ink-secondary/70 focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
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

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setStatusFilter('')}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${!statusFilter ? 'bg-getmeds-blue text-white' : 'bg-white border border-slate-200 text-ink-secondary hover:bg-surface'}`}
        >All</button>
        {statuses.map(s => (
          <button key={s} onClick={() => setStatusFilter(s === statusFilter ? '' : s)}
            className={`px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors ${statusFilter === s ? 'bg-getmeds-blue text-white' : 'bg-white border border-slate-200 text-ink-secondary hover:bg-surface'}`}
          >{s.replace(/_/g, ' ')}</button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700 text-sm">Failed to load orders.</div>
      ) : orders.length === 0 && search ? (
        <div className="text-center py-16 bg-white rounded-lg border border-slate-200 shadow-sm">
          <p className="text-ink-secondary">No orders match &ldquo;{search}&rdquo;{statusFilter ? ' at this status' : ''}.</p>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border border-slate-200 shadow-sm">
          {cateredOnly ? (
            <>
              <p className="text-ink-secondary mb-4">You are not catering any orders{statusFilter ? ' at this status' : ''} yet.</p>
              <button onClick={() => navigate('/dispatch')} className="px-4 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover">
                Pick orders on the Dispatch page
              </button>
            </>
          ) : (
            <>
              <p className="text-ink-secondary mb-4">No orders found.</p>
              {!isDispatch && (
                <button onClick={() => navigate('/orders/new')} className="px-4 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover">
                  Create Your First Order
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
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
                // Sep 25, 2026: the whole row opens the order, and the id is a
                // real link (so it can be opened in a new tab, and reached from
                // the keyboard). The View column that used to do this is gone.
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
                  {/* Sep 25, 2026: who the delivery is for (intake_receiver), with
                      their contact number underneath. An order with no separate
                      receiver shows a dash rather than an empty cell. */}
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
      )}
    </div>
  );
};

export default MyOrdersPage;
