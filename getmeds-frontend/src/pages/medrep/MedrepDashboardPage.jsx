import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { 
  ShoppingBag, 
  Clock, 
  CheckCircle, 
  AlertCircle, 
  Plus, 
  ArrowRight, 
  RefreshCw, 
  Eye,
  TrendingUp,
  FileText
} from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import OrderStatusBadge from '../../components/ui/OrderStatusBadge';

const MedrepDashboardPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['medrep-orders'],
    queryFn: () => client.get('/api/orders?limit=100').then(r => r.data),
    refetchInterval: 30000
  });

  const orders = data?.data?.orders || [];

  // Calculate MedRep specific statistics
  const totalOrders = orders.length;
  const draftOrders = orders.filter(o => o.status === 'draft').length;
  const pendingOrders = orders.filter(o => ['submitted', 'validating', 'waiting_for_payment', 'so_pending'].includes(o.status)).length;
  const inFulfillment = orders.filter(o => ['so_created', 'payment_verified', 'ready_for_dispatch', 'picking_packing', 'dispatched'].includes(o.status)).length;
  const completedOrders = orders.filter(o => o.status === 'completed').length;
  const exceptionOrders = orders.filter(o => ['on_hold', 'exception', 'cancelled'].includes(o.status)).length;
  const totalRevenue = orders
    .filter(o => o.status !== 'cancelled')
    .reduce((sum, o) => sum + Number(o.total_amount || 0), 0);

  const recentOrders = orders.slice(0, 5);

  const statCards = [
    {
      title: 'Total Submissions',
      value: totalOrders,
      sub: `₱${totalRevenue.toLocaleString('en-PH', { minimumFractionDigits: 2 })} volume`,
      icon: ShoppingBag,
      color: 'bg-getmeds-blue/15 text-getmeds-blue',
    },
    {
      title: 'Pending & Validation',
      value: pendingOrders,
      sub: `${draftOrders} draft orders`,
      icon: Clock,
      color: 'bg-state-warning-light text-state-warning',
    },
    {
      title: 'In Fulfillment',
      value: inFulfillment,
      sub: 'Processing & Courier',
      icon: TrendingUp,
      color: 'bg-indigo-100 text-indigo-700',
    },
    {
      title: 'Completed Orders',
      value: completedOrders,
      sub: 'Successfully Delivered',
      icon: CheckCircle,
      color: 'bg-pharmacy-green/15 text-pharmacy-green',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">MedRep Overview</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Welcome back, <span className="font-semibold text-ink-primary">{user?.name}</span>. Here is your current order pipeline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => refetch()} 
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary transition-colors shadow-sm"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button 
            onClick={() => navigate('/orders/new')} 
            className="flex items-center gap-1.5 px-4 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors shadow-md shadow-getmeds-blue/20"
          >
            <Plus className="w-4 h-4" /> Create New Order
          </button>
        </div>
      </div>

      {/* Exception Banner if any orders need attention */}
      {exceptionOrders > 0 && (
        <div className="bg-state-error-light border border-state-error/30 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-state-error flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-950">
                You have {exceptionOrders} order{exceptionOrders > 1 ? 's' : ''} on hold or flagged with an exception
              </p>
              <p className="text-xs text-red-800 mt-0.5">
                Check order notes or contact management to resolve holds quickly.
              </p>
            </div>
          </div>
          <Link
            to="/orders"
            className="text-xs font-semibold text-state-error hover:underline flex items-center gap-1 ml-4 flex-shrink-0"
          >
            View flagged orders <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      )}

      {/* KPI Cards */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((card, idx) => {
            const Icon = card.icon;
            return (
              <div key={idx} className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold uppercase text-ink-secondary tracking-wider">
                    {card.title}
                  </span>
                  <div className={`p-2 rounded-lg ${card.color}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                </div>
                <p className="text-3xl font-bold text-ink-primary">{card.value}</p>
                <p className="text-xs text-ink-secondary mt-1">{card.sub}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Quick Action & Recent Orders Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Quick Actions */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-base font-bold text-ink-primary mb-2">Quick Actions</h2>
            <p className="text-xs text-ink-secondary mb-4 leading-relaxed">
              Quickly create orders, calculate totals for direct patients or institutional credit clients, and track delivery progress in real time.
            </p>

            <div className="space-y-2.5">
              <Link
                to="/orders/new"
                className="flex items-center justify-between p-3 rounded-lg bg-getmeds-blue/10 border border-getmeds-blue/30 text-getmeds-blue-dark font-semibold text-xs hover:bg-getmeds-blue/15 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Plus className="w-4 h-4 text-getmeds-blue" />
                  New Order Entry
                </span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
              <Link
                to="/orders"
                className="flex items-center justify-between p-3 rounded-lg bg-surface border border-slate-200 text-ink-primary font-medium text-xs hover:bg-slate-100 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-ink-secondary" />
                  View All My Submissions
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-ink-secondary" />
              </Link>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-ink-secondary">
            <span className="font-semibold text-ink-primary">Need urgent order assistance?</span>
            <p className="mt-0.5">Direct patient payments are cleared by Finance within 1-2 hours of proof upload.</p>
          </div>
        </div>

        {/* Right: Recent Orders Table */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-surface">
            <h2 className="text-sm font-bold text-ink-primary">Recent Orders</h2>
            <Link to="/orders" className="text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark flex items-center gap-1">
              View All <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {recentOrders.length === 0 ? (
            <div className="text-center py-12 text-ink-secondary text-sm">
              No orders submitted yet. Click "Create New Order" to begin!
            </div>
          ) : (
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-white">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Total</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-ink-secondary uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentOrders.map(order => (
                  <tr key={order.id} className="hover:bg-surface transition-colors">
                    <td className="px-4 py-3 text-xs font-mono font-bold text-getmeds-blue">
                      {order.getmeds_order_id}
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-ink-primary">
                      {order.customer_name}
                      <span className="block text-[11px] text-ink-secondary capitalize">{order.customer_type}</span>
                    </td>
                    <td className="px-4 py-3">
                      <OrderStatusBadge status={order.status} />
                    </td>
                    <td className="px-4 py-3 text-xs font-bold text-ink-primary">
                      ₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/orders/${order.id}`}
                        className="inline-flex items-center gap-1 text-xs text-getmeds-blue hover:text-getmeds-blue-dark font-semibold"
                      >
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
    </div>
  );
};

export default MedrepDashboardPage;
