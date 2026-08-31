import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { 
  AlertTriangle, 
  XCircle, 
  PauseCircle, 
  RefreshCw, 
  Eye, 
  CheckCircle, 
  ArrowRight,
  Filter
} from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import client from '../../api/client';
import OrderStatusBadge from '../../components/ui/OrderStatusBadge';

const ExceptionHubPage = () => {
  const qc = useQueryClient();
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [resolutionStatus, setResolutionStatus] = useState('validating');
  const [resolutionNotes, setResolutionNotes] = useState('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['exception-orders'],
    queryFn: () => client.get('/api/orders?limit=100').then(r => r.data),
    refetchInterval: 20000
  });

  const allOrders = data?.data?.orders || [];

  // Filter only orders with exception / on_hold / cancelled status
  const exceptionOrders = allOrders.filter(o => ['on_hold', 'exception', 'cancelled'].includes(o.status));

  const resolveMutation = useMutation({
    mutationFn: ({ id, status, reason }) => client.patch(`/api/orders/${id}/exception`, { status, reason }).then(r => r.data),
    onSuccess: () => {
      toast.success('Order status updated successfully ✅');
      qc.invalidateQueries({ queryKey: ['exception-orders'] });
      qc.invalidateQueries({ queryKey: ['management-summary'] });
      setSelectedOrder(null);
      setResolutionNotes('');
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Failed to update order status')
  });

  const handleResolveSubmit = (e) => {
    e.preventDefault();
    if (!selectedOrder) return;
    resolveMutation.mutate({
      id: selectedOrder.id,
      status: resolutionStatus,
      reason: resolutionNotes || 'Resolved by management in Exception Hub'
    });
  };

  const onHoldCount = exceptionOrders.filter(o => o.status === 'on_hold').length;
  const criticalExceptionCount = exceptionOrders.filter(o => o.status === 'exception').length;
  const cancelledCount = exceptionOrders.filter(o => o.status === 'cancelled').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Exception & Hold Resolution Hub</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Centralized management hub for all escalated, held, and cancelled workflow items.
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
            to="/management"
            className="flex items-center gap-1.5 px-4 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:bg-getmeds-blue-hover transition-colors shadow-sm"
          >
            Global Dashboard
          </Link>
        </div>
      </div>

      {/* KPI Severity Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase text-state-warning tracking-wider">Orders On Hold</p>
            <PauseCircle className="w-5 h-5 text-state-warning" />
          </div>
          <p className="text-3xl font-bold text-ink-primary mt-2">{onHoldCount}</p>
          <p className="text-xs text-ink-secondary mt-1">Awaiting compliance / inventory check</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase text-state-error tracking-wider">Critical Exceptions</p>
            <AlertTriangle className="w-5 h-5 text-state-error" />
          </div>
          <p className="text-3xl font-bold text-state-error mt-2">{criticalExceptionCount}</p>
          <p className="text-xs text-ink-secondary mt-1">Requires supervisor override or audit</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase text-ink-secondary tracking-wider">Cancelled Orders</p>
            <XCircle className="w-5 h-5 text-ink-secondary" />
          </div>
          <p className="text-3xl font-bold text-ink-primary mt-2">{cancelledCount}</p>
          <p className="text-xs text-ink-secondary mt-1">Terminated or refunded transactions</p>
        </div>
      </div>

      {/* Exception Orders List */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-surface flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-state-error" />
            <h2 className="text-sm font-bold text-ink-primary">
              Flagged Orders ({exceptionOrders.length})
            </h2>
          </div>
          <span className="text-xs text-ink-secondary">Real-time status updates</span>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
          </div>
        ) : exceptionOrders.length === 0 ? (
          <div className="text-center py-16 text-ink-secondary">
            <CheckCircle className="w-12 h-12 mx-auto mb-3 text-pharmacy-green" />
            <p className="text-base font-semibold text-ink-primary">No Active Exceptions</p>
            <p className="text-xs text-ink-secondary mt-1">All orders are moving normally through the pipeline.</p>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">MedRep</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Flagged State</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Reason / Note</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Total</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-ink-secondary uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {exceptionOrders.map(order => (
                <tr key={order.id} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-3 text-xs font-mono font-bold text-getmeds-blue">
                    {order.getmeds_order_id}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm font-semibold text-ink-primary">{order.customer_name}</p>
                    <p className="text-xs text-ink-secondary capitalize">{order.customer_type} Account</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">{order.medrep_name}</td>
                  <td className="px-4 py-3">
                    <OrderStatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-primary max-w-xs">
                    {order.exception_reason ? (
                      <span className="bg-state-error-light px-2 py-0.5 rounded text-red-950 font-medium border border-state-error/20 inline-block">
                        {order.exception_reason}
                      </span>
                    ) : (
                      <span className="text-ink-secondary/60">No explicit note recorded</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm font-bold text-ink-primary">
                    ₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => {
                          setSelectedOrder(order);
                          setResolutionStatus(order.customer_type === 'direct' ? 'waiting_for_payment' : 'ready_for_dispatch');
                        }}
                        className="px-2.5 py-1 bg-getmeds-blue text-white rounded text-xs font-semibold hover:bg-getmeds-blue-hover shadow-sm"
                      >
                        Resolve / Release
                      </button>
                      <Link
                        to={`/orders/${order.id}`}
                        className="p-1.5 text-ink-secondary hover:text-ink-primary"
                        title="View Full Order"
                      >
                        <Eye className="w-4 h-4" />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Resolution Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-slate-200">
            <div className="flex items-start justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="text-lg font-bold text-ink-primary">
                  Resolve Order {selectedOrder.getmeds_order_id}
                </h3>
                <p className="text-xs text-ink-secondary">{selectedOrder.customer_name}</p>
              </div>
              <OrderStatusBadge status={selectedOrder.status} />
            </div>

            <form onSubmit={handleResolveSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-ink-primary uppercase mb-1">
                  Target Next Status *
                </label>
                <select
                  value={resolutionStatus}
                  onChange={e => setResolutionStatus(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
                  required
                >
                  <option value="validating">Validating / Resubmit</option>
                  <option value="waiting_for_payment">Waiting for Payment (Direct Patient)</option>
                  <option value="ready_for_dispatch">Ready for Dispatch (Credit Account)</option>
                  <option value="cancelled">Cancel Order Permanently</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-primary uppercase mb-1">
                  Resolution Reason / Action Audit *
                </label>
                <textarea
                  value={resolutionNotes}
                  onChange={e => setResolutionNotes(e.target.value)}
                  placeholder="Explain why this order is being released or re-routed..."
                  rows={3}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedOrder(null)}
                  className="px-4 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resolveMutation.isPending}
                  className="px-5 py-2 bg-pharmacy-green text-white rounded-md text-sm font-semibold hover:bg-pharmacy-green-hover shadow-sm disabled:opacity-50"
                >
                  {resolveMutation.isPending ? 'Updating...' : 'Save & Update Status'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExceptionHubPage;
