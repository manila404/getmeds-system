import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { 
  Truck, 
  MapPin, 
  CheckCircle, 
  RefreshCw, 
  Eye, 
  Search, 
  Package, 
  ExternalLink 
} from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import OrderStatusBadge from '../../components/ui/OrderStatusBadge';

const DispatchHistoryPage = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [courierFilter, setCourierFilter] = useState('all');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['dispatch-history-orders'],
    queryFn: () => client.get('/api/orders?limit=100').then(r => r.data),
    refetchInterval: 30000
  });

  const allOrders = data?.data?.orders || [];

  // Filter orders that have been dispatched or completed
  const dispatchHistory = allOrders.filter(order => {
    const isDispatchedOrCompleted = ['dispatched', 'tracking_shared', 'completed'].includes(order.status) || Boolean(order.tracking_number);
    if (!isDispatchedOrCompleted) return false;

    const matchesSearch = 
      order.getmeds_order_id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.tracking_number?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.courier?.toLowerCase().includes(searchTerm.toLowerCase());

    if (!matchesSearch) return false;

    if (courierFilter !== 'all') {
      return (order.courier || '').toLowerCase() === courierFilter.toLowerCase();
    }
    return true;
  });

  const totalDispatched = allOrders.filter(o => o.status === 'dispatched' || o.status === 'tracking_shared').length;
  const totalCompleted = allOrders.filter(o => o.status === 'completed').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Dispatched & Logistics Tracking Log</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Complete trace history of all couriers, tracking numbers, and delivery fulfillments.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary transition-colors shadow-sm"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <Link
            to="/dispatch"
            className="flex items-center gap-1.5 px-4 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors shadow-sm"
          >
            <Package className="w-4 h-4" /> Go to Fulfillment Queue
          </Link>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <p className="text-xs font-semibold uppercase text-ink-secondary tracking-wider">Total Dispatched / Logged</p>
          <p className="text-2xl font-bold text-ink-primary mt-1">{dispatchHistory.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <p className="text-xs font-semibold uppercase text-getmeds-blue tracking-wider">In Transit / Out for Delivery</p>
          <p className="text-2xl font-bold text-getmeds-blue mt-1">{totalDispatched}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <p className="text-xs font-semibold uppercase text-pharmacy-green tracking-wider">Completed / Delivered</p>
          <p className="text-2xl font-bold text-pharmacy-green mt-1">{totalCompleted}</p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-ink-secondary absolute left-3 top-3" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search by order, customer, tracking..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
          />
        </div>

        <div className="flex gap-2 w-full sm:w-auto overflow-x-auto">
          {['all', 'LBC', 'J&T', 'NinjaVan', 'GrabExpress', 'Lalamove'].map(courier => (
            <button
              key={courier}
              onClick={() => setCourierFilter(courier)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                courierFilter.toLowerCase() === courier.toLowerCase()
                  ? 'bg-getmeds-blue text-white'
                  : 'bg-surface text-ink-secondary hover:text-ink-primary hover:bg-slate-200'
              }`}
            >
              {courier === 'all' ? 'All Couriers' : courier}
            </button>
          ))}
        </div>
      </div>

      {/* Dispatched Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
          </div>
        ) : dispatchHistory.length === 0 ? (
          <div className="text-center py-16 text-ink-secondary text-sm">
            No dispatched or completed orders found matching your filters.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Courier</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Tracking Number</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-ink-secondary uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {dispatchHistory.map(order => (
                <tr key={order.id} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-3 text-xs font-mono font-bold text-getmeds-blue">
                    {order.getmeds_order_id}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm font-semibold text-ink-primary">{order.customer_name}</p>
                    <p className="text-xs text-ink-secondary truncate max-w-xs">{order.delivery_address}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-100 font-semibold text-xs text-ink-primary">
                      <Truck className="w-3.5 h-3.5 text-getmeds-blue" />
                      {order.courier || 'Standard Courier'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {order.tracking_number ? (
                      <span className="font-mono font-bold text-xs text-getmeds-blue">
                        {order.tracking_number}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-secondary/60">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <OrderStatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">
                    {formatPHT(order.created_at, 'date')}
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
  );
};

export default DispatchHistoryPage;
