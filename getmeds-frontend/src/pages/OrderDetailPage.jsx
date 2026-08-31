import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowLeft, Package, CreditCard, Truck, Clock, CheckCircle, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { formatPHT } from '../utils/dateUtils';

const STATUS_COLORS = {
  draft: 'bg-slate-100 text-slate-700 border border-slate-300',
  submitted: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  validating: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_pending: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_created: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  waiting_for_payment: 'bg-state-warning-light text-amber-950 border border-state-warning font-semibold',
  invoice_drafted: 'bg-indigo-50 text-indigo-700 border border-indigo-300 font-semibold',
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

const EVENT_ICONS = {
  ORDER_CREATED: '📝', STATUS_CHANGE: '🔄', PAYMENT_VERIFIED: '✅',
  PAYMENT_REJECTED: '❌', ORDER_DISPATCHED: '🚚', TRACKING_ENTERED: '📍',
  ORDER_COMPLETED: '🎉', EXCEPTION_SET: '⚠️', DISPATCH_STATUS_UPDATE: '📦',
  ZOHO_PAYMENT_SYNCED: '⚡', ZOHO_SO_CONFIRMED: '📄', ZOHO_INVOICE_DRAFTED: '🧾',
  ZOHO_PAYMENT_VERIFIED: '✅', ZOHO_PACKAGE_CREATED: '📦', ZOHO_DISPATCHED: '🚚',
  ZOHO_DISPATCH_UPDATED: '🚚', ZOHO_SO_CANCELLED: '🚫', ZOHO_EVENT_RECEIVED: '🔔',
  ZOHO_SO_STATUS_CHANGED: '📄'
};

const OrderDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState('items');

  const { data, isLoading, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => client.get(`/api/orders/${id}`).then(r => r.data),
    refetchInterval: 15000
  });

  const exceptionMutation = useMutation({
    mutationFn: ({ status, reason }) => client.patch(`/api/orders/${id}/exception`, { status, reason }).then(r => r.data),
    onSuccess: () => { toast.success('Order status updated'); qc.invalidateQueries({ queryKey: ['order', id] }); },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Failed')
  });

  // Manual fallback for a missed webhook — pulls this order's current Sales
  // Order status straight from Zoho and backfills the audit trail if the
  // live webhook never reached this app (backend/ngrok wasn't running at
  // the moment it was confirmed).
  const zohoSyncMutation = useMutation({
    mutationFn: () => client.post(`/api/orders/${id}/sync-from-zoho`).then(r => r.data),
    onSuccess: (res) => {
      const action = res?.data?.action;
      if (action === 'SO_CONFIRMED_BACKFILLED') toast.success('Zoho confirmation added to the timeline.');
      else if (action === 'SO_CANCELLED_BACKFILLED') toast.success('Zoho cancellation added to the timeline.');
      else if (action === 'PACKAGE_BACKFILLED') toast.success('Zoho package (picking/packing) added to the timeline.');
      else if (action === 'DISPATCHED_BACKFILLED') toast.success('Zoho shipment & tracking added to the timeline.');
      else toast('Already up to date with Zoho.', { icon: 'ℹ️' });
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not reach Zoho')
  });

  // Manual, on-demand PUSH of a failed Zoho sync. Added Aug 30, 2026 when
  // the automatic 30s background retry loop was switched off by default
  // (see server.js) — a failed sync no longer retries itself; this button
  // is how it gets retried instead, one click at a time.
  const retryZohoSyncMutation = useMutation({
    mutationFn: () => client.post(`/api/orders/${id}/retry-zoho-sync`).then(r => r.data),
    onSuccess: (res) => {
      const outcome = res?.data?.result?.outcome;
      if (outcome === 'succeeded') toast.success('Zoho Sales Order created — sync succeeded.');
      else toast.error(`Still failing: ${res?.data?.result?.error || 'unknown error'}`);
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Retry failed')
  });

  if (isLoading) return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-getmeds-blue" /></div>;
  if (error) return <div className="text-center py-20 text-red-600">Failed to load order. <button onClick={() => navigate(-1)} className="underline">Go back</button></div>;

  const { order, items = [], payment, dispatch, events = [] } = data?.data || {};
  if (!order) return null;

  const tabs = [
    { id: 'items', label: 'Order Items', icon: Package },
    { id: 'payment', label: 'Payment', icon: CreditCard },
    { id: 'dispatch', label: 'Dispatch', icon: Truck },
    { id: 'timeline', label: 'Audit Timeline', icon: Clock },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      {/* Header */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-mono text-ink-secondary mb-1">Getmeds Order ID</p>
            <h1 className="text-2xl font-semibold font-mono text-getmeds-blue">{order.getmeds_order_id}</h1>
            <p className="text-sm text-ink-secondary mt-1">
              {order.customer_name} · <span className={`capitalize px-2 py-0.5 rounded text-xs font-medium ${order.customer_type === 'credit' ? 'bg-getmeds-blue/10 text-getmeds-blue-dark' : 'bg-state-warning-light text-amber-900 border border-state-warning/30'}`}>{order.customer_type}</span>
            </p>
            <p className="text-xs text-ink-secondary mt-1">MedRep: {order.medrep_name} · Created: {formatPHT(order.created_at)}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`px-3 py-1 rounded-full text-sm font-semibold capitalize ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-700'}`}>
              {order.status?.replace(/_/g, ' ')}
            </span>
            <p className="text-xl font-bold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</p>
          </div>
        </div>

        {/* Delivery Info */}
        <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs font-medium text-ink-secondary uppercase mb-1">Delivery Address</p>
            <p className="text-ink-primary">{order.delivery_address}</p>
            {order.delivery_notes && <p className="text-ink-secondary text-xs mt-0.5">{order.delivery_notes}</p>}
          </div>
          <div>
            <p className="text-xs font-medium text-ink-secondary uppercase mb-1">Zoho Integration</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {order.zoho_so_number ? (
                <>
                  <span className="bg-pharmacy-green/15 text-pharmacy-green-dark px-2 py-0.5 rounded font-medium">SO: {order.zoho_so_number}</span>
                  <span className={`px-2 py-0.5 rounded ${order.zoho_sync_status === 'synced' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-warning-light text-amber-900'}`}>
                    {order.zoho_sync_status}
                  </span>
                  {order.zoho_invoice_number && (
                    <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-medium">Invoice: {order.zoho_invoice_number}</span>
                  )}
                </>
              ) : <span className="text-ink-secondary">Not yet synced</span>}
              {order.zoho_sync_status === 'failed' && (
                <button
                  type="button"
                  disabled={retryZohoSyncMutation.isPending}
                  onClick={() => retryZohoSyncMutation.mutate()}
                  title="Push this order to Zoho again now — automatic background retry is off, so this is the only way to retry a failed sync"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-state-warning text-amber-900 hover:bg-state-warning-light disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${retryZohoSyncMutation.isPending ? 'animate-spin' : ''}`} />
                  {retryZohoSyncMutation.isPending ? 'Retrying...' : 'Retry Zoho Sync'}
                </button>
              )}
              {/* Aug 31, 2026: only 'cancelled' hides this now — 'completed'
                  used to as well, but that stopped being safe once
                  syncFromZoho gained an invoice backfill: an order can
                  legitimately still be sitting at 'completed' (e.g. from
                  before the premature-auto-complete bug in the dispatch
                  webhook was fixed) and still need that invoice pulled in. */}
              {order.zoho_so_id && order.status !== 'cancelled' && (
                <button
                  type="button"
                  disabled={zohoSyncMutation.isPending}
                  onClick={() => zohoSyncMutation.mutate()}
                  title="Pull this order's current status from Zoho — catches up the timeline if a webhook was missed"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${zohoSyncMutation.isPending ? 'animate-spin' : ''}`} />
                  {zohoSyncMutation.isPending ? 'Checking Zoho...' : 'Sync from Zoho'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Management actions */}
        {['management', 'admin'].includes(user?.role) && !['completed', 'cancelled'].includes(order.status) && (
          <div className="mt-4 pt-4 border-t border-gray-100 flex gap-2">
            <button
              onClick={() => { const r = prompt('Reason for hold?'); if (r) exceptionMutation.mutate({ status: 'on_hold', reason: r }); }}
              className="px-3 py-1.5 text-xs border border-state-warning text-amber-800 rounded hover:bg-state-warning-light"
            >⏸ Put on Hold</button>
            <button
              onClick={() => { const r = prompt('Exception reason?'); if (r) exceptionMutation.mutate({ status: 'exception', reason: r }); }}
              className="px-3 py-1.5 text-xs border border-state-error text-red-700 rounded hover:bg-state-error-light"
            >⚠️ Mark Exception</button>
          </div>
        )}
        {order.exception_reason && (
          <div className="mt-3 bg-state-warning-light border border-state-warning/30 rounded p-3 text-xs text-amber-950">
            <span className="font-semibold">Exception/Hold Reason:</span> {order.exception_reason}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="border-b border-slate-200 flex">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === tab.id ? 'border-getmeds-blue text-getmeds-blue font-semibold' : 'border-transparent text-ink-secondary hover:text-ink-primary'}`}
              >
                <Icon className="w-4 h-4" />{tab.label}
              </button>
            );
          })}
        </div>

        <div className="p-6">
          {/* Items Tab */}
          {activeTab === 'items' && (
            <div>
              <table className="min-w-full">
                <thead>
                  <tr className="text-left text-xs font-medium text-ink-secondary uppercase border-b border-slate-200">
                    <th className="pb-3">Product</th>
                    <th className="pb-3 text-center">Qty</th>
                    <th className="pb-3 text-right">Unit Price</th>
                    <th className="pb-3 text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map(item => (
                    <tr key={item.id}>
                      <td className="py-3">
                        <p className="text-sm font-semibold text-ink-primary">{item.product_name}</p>
                        <p className="text-xs text-ink-secondary">SKU: {item.sku} · Unit: {item.unit}</p>
                      </td>
                      <td className="py-3 text-center text-sm text-ink-primary">{item.quantity}</td>
                      <td className="py-3 text-right text-sm text-ink-secondary">₱{(item.unit_price || 0).toFixed(2)}</td>
                      <td className="py-3 text-right text-sm font-semibold text-ink-primary">₱{(item.subtotal || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-200">
                  <tr>
                    <td colSpan="3" className="pt-3 text-sm font-semibold text-ink-primary text-right">Total Amount</td>
                    <td className="pt-3 text-right text-lg font-bold text-getmeds-blue">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Payment Tab */}
          {activeTab === 'payment' && (
            <div>
              {!payment ? (
                <div className="text-center py-8 text-ink-secondary">
                  <CreditCard className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
                  <p className="text-sm">{order.customer_type === 'credit' ? 'Credit customer — no payment verification required.' : 'No payment record yet.'}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    ['Status', <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${payment.status === 'verified' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30' : payment.status === 'rejected' ? 'bg-state-error-light text-red-700 border border-state-error/30' : 'bg-state-warning-light text-amber-950 border border-state-warning/30'}`}>{payment.status}</span>],
                    ['Reference', payment.payment_reference || '—'],
                    ['Amount', payment.amount ? `₱${payment.amount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : '—'],
                    ['Method', payment.payment_method || '—'],
                    ['Payment Date', payment.payment_date || '—'],
                    ['Verified By', payment.verified_by_name || '—'],
                    ['Verified At', payment.verified_at ? formatPHT(payment.verified_at) : '—'],
                    ['Notes', payment.notes || '—'],
                  ].map(([label, val]) => (
                    <div key={label} className="bg-surface rounded p-3 border border-slate-100">
                      <p className="text-xs font-medium text-ink-secondary uppercase mb-1">{label}</p>
                      <div className="text-sm text-ink-primary font-medium">{val}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Dispatch Tab */}
          {activeTab === 'dispatch' && (
            <div>
              {!dispatch ? (
                <div className="text-center py-8 text-ink-secondary">
                  <Truck className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
                  <p className="text-sm">No dispatch record yet.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    ['Dispatch Status', <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${dispatch.status === 'dispatched' ? 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40' : 'bg-indigo-100 text-indigo-700'}`}>{dispatch.status}</span>],
                    ['Courier', dispatch.courier || '—'],
                    ['Tracking Number', dispatch.tracking_number ? <span className="font-mono font-bold text-getmeds-blue">{dispatch.tracking_number}</span> : '—'],
                    ['Dispatched At', dispatch.dispatched_at ? formatPHT(dispatch.dispatched_at) : '—'],
                    ['Notes', dispatch.dispatch_notes || '—'],
                  ].map(([label, val]) => (
                    <div key={label} className="bg-surface rounded p-3 border border-slate-100">
                      <p className="text-xs font-medium text-ink-secondary uppercase mb-1">{label}</p>
                      <div className="text-sm text-ink-primary font-medium">{val}</div>
                    </div>
                  ))}
                </div>
              )}

              {!['completed', 'cancelled'].includes(order.status) && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 bg-surface px-3 py-2 text-xs text-ink-secondary">
                  <RefreshCw className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <p>Picking, packing and shipment status come from Zoho, not from this app — create the Package
                    (picking &amp; packing) and Shipment (courier + tracking) in Zoho Inventory and this record
                    updates automatically.</p>
                </div>
              )}
            </div>
          )}

          {/* Timeline Tab */}
          {activeTab === 'timeline' && (
            <div className="space-y-3">
              {events.length === 0 ? (
                <p className="text-sm text-ink-secondary text-center py-8">No events recorded yet.</p>
              ) : (
                events.map((event, i) => (
                  <div key={event.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-8 h-8 rounded-full bg-getmeds-blue/10 flex items-center justify-center text-sm flex-shrink-0">
                        {EVENT_ICONS[event.event_type] || '📋'}
                      </div>
                      {i < events.length - 1 && <div className="w-0.5 bg-slate-200 flex-1 my-1" />}
                    </div>
                    <div className="pb-3 flex-1">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-semibold text-ink-primary">
                            {event.event_type.replace(/_/g, ' ')}
                            {event.old_status && event.new_status && (
                              <span className="ml-2 text-xs font-normal text-ink-secondary">
                                {event.old_status} → <span className={`font-semibold ${STATUS_COLORS[event.new_status] ? 'text-ink-primary' : ''}`}>{event.new_status}</span>
                              </span>
                            )}
                          </p>
                          {event.notes && <p className="text-xs text-ink-secondary mt-0.5">{event.notes}</p>}
                          <p className="text-xs text-ink-secondary mt-0.5">By: {event.actor_name || 'System'}</p>
                        </div>
                        <p className="text-xs text-ink-secondary flex-shrink-0 ml-4">
                          {event.created_at ? formatPHT(event.created_at, 'timeline') : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OrderDetailPage;
