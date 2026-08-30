import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle, Clock, RefreshCw, FileText, Banknote, ExternalLink } from 'lucide-react';
import client from '../../api/client';

// Read-only. Finance verification happens IN ZOHO now, not in this app:
//   1. MedRep submits an order here -> it syncs to Zoho as a Sales Order.
//   2. Finance confirms the Sales Order in Zoho.
//   3. Finance converts it to an Invoice in Zoho ("invoice_drafted" below).
//   4. Finance records the Customer Payment against that Invoice in Zoho.
// Each of those Zoho-side actions calls back to this app's webhook and
// updates the order automatically — this page just shows where things
// stand. There is nothing to click here; go to Zoho to act on an order.
const FinanceQueuePage = () => {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['finance-queue'],
    queryFn: () => client.get('/api/finance/queue').then(r => r.data),
    refetchInterval: 30000
  });
  const orders = data?.data?.orders || [];

  const waitingHours = (order) => {
    if (!order.submitted_at) return '—';
    const h = (Date.now() - new Date(order.submitted_at).getTime()) / 3600000;
    return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
  };

  const stageInfo = (status) => status === 'invoice_drafted'
    ? { label: 'Invoice drafted in Zoho', hint: 'Waiting for Finance to record the Customer Payment in Zoho.', icon: FileText, className: 'bg-indigo-50 text-indigo-700 border-indigo-300' }
    : { label: 'Sales Order confirmed', hint: 'Waiting for Finance to convert the Sales Order to an Invoice in Zoho.', icon: Banknote, className: 'bg-state-warning-light text-amber-950 border-state-warning' };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Zoho Finance Status</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Direct patient orders waiting on Finance in Zoho. This list is read-only — confirm the Sales Order,
            convert it to an Invoice, and record the Customer Payment in Zoho itself; this page updates
            automatically once that happens.
          </p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-center gap-2">
          <Clock className="w-4 h-4 text-state-warning" />
          <h2 className="text-sm font-semibold text-ink-primary">Awaiting Finance Action in Zoho ({orders.length})</h2>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary">
            <CheckCircle className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
            <p className="text-sm">No orders currently waiting on Finance</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map(order => {
              const stage = stageInfo(order.status);
              const Icon = stage.icon;
              return (
                <li key={order.id} className="p-4">
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</p>
                      <p className="text-sm text-ink-primary mt-0.5 font-medium truncate">{order.customer_name}</p>
                      <p className="text-xs text-ink-secondary">{order.medrep_name}</p>
                      {order.zoho_so_number && (
                        <p className="text-xs text-ink-secondary mt-1">
                          Zoho SO: <span className="font-mono">{order.zoho_so_number}</span>
                          {order.zoho_invoice_number && <> · Invoice: <span className="font-mono">{order.zoho_invoice_number}</span></>}
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
        <p>Act on these orders in Zoho Inventory (confirm the Sales Order) and Zoho Books (convert to Invoice,
          record the Customer Payment). This page is a mirror of what Zoho reports — nothing here changes an
          order's status directly.</p>
      </div>
    </div>
  );
};

export default FinanceQueuePage;
