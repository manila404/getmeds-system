import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ShoppingBag, Clock, Truck, CheckCircle, AlertTriangle, RefreshCw, Eye
} from 'lucide-react';
import client from '../../api/client';
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

const ManagementDashboardPage = () => {
  const [statusFilter, setStatusFilter] = useState('');

  const { data: summaryRes, isLoading: loadingStats, refetch } = useQuery({
    queryKey: ['management-summary'],
    queryFn: () => client.get('/api/management/summary').then(r => r.data),
    refetchInterval: 60000
  });
  const stats = summaryRes?.data || {};

  const { data: ordersRes, isLoading: loadingOrders } = useQuery({
    queryKey: ['management-orders', statusFilter],
    queryFn: () => client.get(`/api/management/orders${statusFilter ? `?status=${statusFilter}` : ''}`).then(r => r.data)
  });
  const orders = ordersRes?.data?.orders || [];

  const statCards = [
    { title: 'Total Orders', value: stats.total_orders || 0, icon: ShoppingBag, color: 'blue', sub: `${stats.orders_today || 0} today` },
    { title: 'Pending Payment', value: stats.pending_payment_count || 0, icon: Clock, color: 'orange', sub: 'Awaiting Finance' },
    { title: 'Ready for Dispatch', value: stats.ready_dispatch_count || 0, icon: Truck, color: 'indigo', sub: 'In queue' },
    { title: 'Completed', value: stats.completed_count || 0, icon: CheckCircle, color: 'green', sub: 'All time' },
    { title: 'Exceptions / On Hold', value: stats.exception_count || 0, icon: AlertTriangle, color: 'red', sub: 'Need attention' },
    {
      title: 'Avg Processing Time',
      value: stats.avg_processing_time_hours != null ? `${stats.avg_processing_time_hours}h` : 'N/A',
      icon: Clock, color: 'purple', sub: 'Submit → Complete'
    },
  ];

  const colorMap = {
    blue: 'bg-getmeds-blue/15 text-getmeds-blue',
    orange: 'bg-amber-100 text-amber-800',
    indigo: 'bg-indigo-100 text-indigo-800',
    green: 'bg-pharmacy-green/15 text-pharmacy-green',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
  };
  const iconColorMap = {
    blue: 'text-getmeds-blue', orange: 'text-amber-600', indigo: 'text-indigo-600',
    green: 'text-pharmacy-green', red: 'text-red-600', purple: 'text-purple-600',
  };

  const downloadCSV = () => {
    const headers = ['Order ID', 'Customer', 'MedRep', 'Status', 'Total', 'Payment', 'Created'];
    const rows = orders.map(o => [
      o.getmeds_order_id, o.customer_name, o.medrep_name, o.status,
      o.total_amount, o.payment_status || '', o.created_at
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'getmeds_orders.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const statusByStatus = stats.orders_by_status || {};
  const statusChartData = Object.entries(statusByStatus).map(([s, c]) => ({ status: s, count: c }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Management Dashboard</h1>
          <p className="text-sm text-ink-secondary mt-1">Real-time overview of all orders and KPIs.</p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      {loadingStats ? (
        <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {statCards.map((card, i) => {
            const Icon = card.icon;
            return (
              <div key={i} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
                <div className="inline-flex mb-3">
                  <Icon className={`w-7 h-7 ${iconColorMap[card.color]}`} />
                </div>
                <p className="text-2xl font-bold text-ink-primary">{card.value}</p>
                <p className="text-xs font-semibold text-ink-primary mt-0.5">{card.title}</p>
                <p className="text-xs text-ink-secondary mt-0.5">{card.sub}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Orders by status breakdown */}
      {statusChartData.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3">Orders by Status</h2>
          <div className="flex flex-wrap gap-2">
            {statusChartData.map(({ status, count }) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status === statusFilter ? '' : status)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${statusFilter === status ? 'ring-2 ring-getmeds-blue' : ''} ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-700'}`}
              >
                <span className="capitalize">{status.replace(/_/g, ' ')}</span>
                <span className="font-bold">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-primary">
            All Orders {statusFilter && <span className="ml-1 text-getmeds-blue capitalize">· {statusFilter.replace(/_/g, ' ')}</span>}
          </h2>
          <div className="flex gap-2">
            {statusFilter && (
              <button onClick={() => setStatusFilter('')} className="text-xs text-ink-secondary hover:text-ink-primary underline">Clear filter</button>
            )}
            <button onClick={downloadCSV} className="px-2.5 py-1 text-xs border border-slate-200 rounded text-ink-secondary hover:bg-surface">⬇ Export CSV</button>
          </div>
        </div>
        {loadingOrders ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary text-sm">No orders found.</div>
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">MedRep</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Total</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-ink-secondary uppercase"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {orders.map(order => (
                <tr key={order.id} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-3 text-sm font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</td>
                  <td className="px-4 py-3 text-sm font-medium text-ink-primary">{order.customer_name}</td>
                  <td className="px-4 py-3 text-sm text-ink-secondary">{order.medrep_name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-700'}`}>
                      {order.status?.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">{formatPHT(order.created_at, 'date')}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/orders/${order.id}`} className="inline-flex items-center gap-1 text-xs text-getmeds-blue hover:text-getmeds-blue-dark font-semibold">
                      <Eye className="w-3.5 h-3.5" /> View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default ManagementDashboardPage;
