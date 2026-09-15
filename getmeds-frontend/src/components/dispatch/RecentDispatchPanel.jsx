import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, ShieldCheck } from 'lucide-react';
import client from '../../api/client';
import DeliveryActions from './DeliveryActions';

/**
 * Sep 15, 2026: what is coming Dispatch's way, newest first.
 *
 *   New draft SOs          just created in Zoho, waiting on Finance — a
 *                          heads-up, nothing to do yet
 *   Confirmed by Finance   verified and not shipped — print the address and
 *                          confirm the delivery
 */

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

const timeAgo = (iso) => {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const STAGE_LABEL = {
  ready_for_draft_invoice: 'Needs invoice',
  ready_for_invoice_sent: 'Invoice not sent yet',
  ready_for_dispatch: 'Ready for dispatch',
  picking_packing: 'Packed'
};

const Card = ({ icon: Icon, title, hint, count, children }) => (
  <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden flex flex-col">
    <div className="px-4 py-3 border-b border-slate-200 bg-surface">
      <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-2">
        <Icon className="w-4 h-4 text-getmeds-blue" />
        {title}
        <span className={`min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums ${count ? 'bg-getmeds-blue text-white' : 'bg-slate-100 text-ink-secondary'}`}>{count}</span>
      </h2>
      <p className="text-xs text-ink-secondary mt-0.5">{hint}</p>
    </div>
    <div className="max-h-[26rem] overflow-y-auto">{children}</div>
  </div>
);

const Empty = ({ text }) => <p className="text-sm text-ink-secondary text-center py-8">{text}</p>;

// Clicking an order opens its receipt (see DispatchQueuePage's `viewing`).
const Opener = ({ order, onOpen, children }) => (
  <div
    role="button"
    tabIndex={0}
    title="View the receipt"
    onClick={() => onOpen(order)}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(order); } }}
    className="min-w-0 cursor-pointer group"
  >
    {children}
  </div>
);

const RecentDispatchPanel = ({ onConfirm, onHold, onAddTracking, confirmingId, onOpen }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['dispatch-recent'],
    queryFn: () => client.get('/api/dispatch/recent').then((r) => r.data?.data),
    refetchInterval: 30000
  });
  const drafts = data?.new_draft_sos || [];
  const confirmed = data?.finance_confirmed || [];
  const loading = <p className="text-sm text-ink-secondary text-center py-8">Loading…</p>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card
        icon={FilePlus2}
        title="New draft SOs"
        hint="Just created in Zoho and waiting on Finance. Nothing to do yet — a heads-up of what is coming."
        count={drafts.length}
      >
        {isLoading ? loading : drafts.length === 0 ? <Empty text="No new draft Sales Orders." /> : (
          <ul className="divide-y divide-slate-100">
            {drafts.map((o) => (
              <li key={o.id} className="px-4 py-3 flex justify-between gap-3">
                <Opener order={o} onOpen={onOpen}>
                  <p className="text-sm font-mono font-semibold text-getmeds-blue">
                    {o.getmeds_order_id}
                    <span className="ml-2 font-sans text-[11px] text-getmeds-blue/80 group-hover:underline">View receipt</span>
                  </p>
                  <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                  <p className="text-xs text-ink-secondary">
                    {o.zoho_so_number && <>SO <span className="font-mono">{o.zoho_so_number}</span> · </>}
                    {o.medrep_name}
                  </p>
                </Opener>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                  <p className="text-xs text-ink-secondary">{timeAgo(o.created_at)}</p>
                  <p className="text-[11px] text-amber-800 font-semibold mt-0.5">Waiting on Finance</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        icon={ShieldCheck}
        title="Confirmed by Finance"
        hint="Verified and not shipped yet. Print the address, check it, then confirm the delivery."
        count={confirmed.length}
      >
        {isLoading ? loading : confirmed.length === 0 ? <Empty text="Nothing confirmed by Finance is waiting." /> : (
          <ul className="divide-y divide-slate-100">
            {confirmed.map((o) => (
              <li key={o.id} className="px-4 py-3 space-y-2">
                <div className="flex justify-between gap-3">
                  <Opener order={o} onOpen={onOpen}>
                    <p className="text-sm font-mono font-semibold text-getmeds-blue">
                      {o.getmeds_order_id}
                      <span className="ml-2 font-sans text-[11px] text-getmeds-blue/80 group-hover:underline">View receipt</span>
                    </p>
                    <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                    <p className="text-xs text-ink-secondary truncate" title={o.delivery_address || ''}>
                      {o.delivery_address || <span className="text-red-700 font-semibold">No delivery address</span>}
                    </p>
                  </Opener>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                    <p className="text-[11px] font-semibold text-ink-secondary">{STAGE_LABEL[o.status] || o.status}</p>
                    <p className="text-xs text-ink-secondary">
                      Finance {timeAgo(o.finance_confirmed_at || o.updated_at)}
                    </p>
                  </div>
                </div>
                <DeliveryActions order={o} onConfirm={onConfirm} onHold={onHold} onAddTracking={onAddTracking} busy={confirmingId === o.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};

export default RecentDispatchPanel;
