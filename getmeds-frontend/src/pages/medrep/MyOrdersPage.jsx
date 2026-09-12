import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Plus, RefreshCw, Eye } from 'lucide-react';
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

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['my-orders', statusFilter],
    queryFn: () => client.get(`/api/orders${statusFilter ? `?status=${statusFilter}` : ''}`).then(r => r.data),
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
          <h1 className="text-2xl font-semibold text-ink-primary">My Orders</h1>
          <p className="text-sm text-ink-secondary mt-1">Track status of orders you have submitted.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button onClick={() => navigate('/orders/new')} className="flex items-center gap-1.5 px-3.5 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors shadow-sm">
            <Plus className="w-4 h-4" /> New Order
          </button>
        </div>
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
      ) : orders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-lg border border-slate-200 shadow-sm">
          <p className="text-ink-secondary mb-4">No orders found.</p>
          <button onClick={() => navigate('/orders/new')} className="px-4 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover">
            Create Your First Order
          </button>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Total</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Payment</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-ink-secondary uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {orders.map(order => (
                <tr key={order.id} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-3 text-sm font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</td>
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
                  <td className="px-4 py-3 text-right">
                    <Link to={`/orders/${order.id}`} className="inline-flex items-center gap-1 text-xs text-getmeds-blue hover:text-getmeds-blue-dark font-semibold">
                      <Eye className="w-3.5 h-3.5" /> View
                    </Link>
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
