import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle, Clock, RefreshCw, PackageCheck, Truck, ExternalLink } from 'lucide-react';
import client from '../../api/client';

// Read-only. Picking, packing, dispatch and tracking status now come FROM
// Zoho, not from a button clicked in this app:
//   1. Order reaches "Ready for Dispatch" -> Pharmacy picks & packs it and
//      creates a Package in Zoho Inventory ("picking_packing" below).
//   2. Pharmacy creates a Shipment in Zoho Inventory with courier + tracking
//      number -> order becomes "dispatched" and, once tracking is present,
//      auto-completes.
// Each of those Zoho-side actions calls back to this app's webhook and
// updates the order automatically — this page just shows where things
// stand. There is nothing to click here; go to Zoho to act on an order.
const DispatchQueuePage = () => {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['dispatch-queue'],
    queryFn: () => client.get('/api/dispatch/queue').then(r => r.data),
    refetchInterval: 30000
  });
  const orders = data?.data?.orders || [];

  const waitingHours = (order) => {
    if (!order.updated_at) return '—';
    const h = (Date.now() - new Date(order.updated_at).getTime()) / 3600000;
    return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
  };

  const stageInfo = (order) => {
    if (order.status === 'dispatched') {
      return {
        label: 'Dispatched from Zoho',
        hint: 'Shipment created in Zoho — tracking details pending. This order completes automatically once Zoho has a tracking number.',
        icon: Truck,
        className: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/30'
      };
    }
    if (order.status === 'picking_packing') {
      return {
        label: 'Package created in Zoho',
        hint: 'Items picked & packed. Waiting for Pharmacy to create a Shipment (courier + tracking) in Zoho Inventory.',
        icon: PackageCheck,
        className: 'bg-indigo-50 text-indigo-700 border-indigo-300'
      };
    }
    return {
      label: 'Ready for dispatch',
      hint: 'Waiting for Pharmacy to create a Package in Zoho Inventory (picking & packing).',
      icon: Clock,
      className: 'bg-state-warning-light text-amber-950 border-state-warning'
    };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink-primary">Zoho Dispatch Status</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Orders waiting on Pharmacy/Dispatch in Zoho. This list is read-only — create the Package and Shipment
            in Zoho Inventory itself; this page updates automatically once that happens.
          </p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-center gap-2">
          <Clock className="w-4 h-4 text-state-warning" />
          <h2 className="text-sm font-semibold text-ink-primary">Awaiting Dispatch Action in Zoho ({orders.length})</h2>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary">
            <CheckCircle className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
            <p className="text-sm">No orders currently waiting on dispatch</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map(order => {
              const stage = stageInfo(order);
              const Icon = stage.icon;
              return (
                <li key={order.id} className="p-4">
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</p>
                      <p className="text-sm text-ink-primary mt-0.5 font-medium truncate">{order.customer_name}</p>
                      <p className="text-xs text-ink-secondary">{order.medrep_name}</p>
                      {(order.courier || order.tracking_number) && (
                        <p className="text-xs text-ink-secondary mt-1">
                          {order.courier && <>Courier: <span className="font-medium">{order.courier}</span></>}
                          {order.tracking_number && <> · Tracking: <span className="font-mono">{order.tracking_number}</span></>}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</p>
                      <p className="text-xs text-ink-secondary font-medium mt-0.5">Waiting {waitingHours(order)}</p>
                    </div>
                  </div>
                  <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${stage.className}`}>
                    <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold">{stage.label}</p>
                      <p className="opacity-90 mt-0.5">{stage.hint}</p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-start gap-2 text-xs text-ink-secondary bg-surface border border-slate-200 rounded-lg p-3">
        <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <p>Act on these orders in Zoho Inventory — create the Package once items are picked & packed, then create
          the Shipment with courier and tracking number. This page is a mirror of what Zoho reports — nothing
          here changes an order's status directly.</p>
      </div>
    </div>
  );
};

export default DispatchQueuePage;
