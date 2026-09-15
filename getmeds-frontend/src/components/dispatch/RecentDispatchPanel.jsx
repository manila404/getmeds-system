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
  picking_packing: 'Packed',
  dispatched: 'Dispatched',
  tracking_shared: 'Tracking shared',
  on_hold: 'On Hold'
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

// Which of the three warehouses the order belongs to (by its division).
const WarehouseTag = ({ order }) =>
  order.warehouse ? (
    <span className="ml-1.5 align-middle text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-ink-secondary">
      {order.warehouse.label}
    </span>
  ) : null;

const RecentDispatchPanel = ({
  onConfirm, onHold, onAddTracking, onCater, onReleaseCater, onHoldOrder, onLiftHold, confirmingId, onOpen,
  warehouse = '', period = ''
}) => {
  // Sep 15, 2026: filtered by the warehouse picked at the top of the page, and
  // by "Today" — every draft SO created today and every order Finance
  // confirmed today, not just the latest 20. "On hold" swaps both lists for
  // every held order (Dispatch's flag, or On Hold by Finance / Management).
  const today = period === 'today';
  const heldView = period === 'on_hold';
  const held = useQuery({
    queryKey: ['dispatch-on-hold', warehouse],
    queryFn: () => client.get('/api/dispatch/on-hold', { params: { warehouse: warehouse || undefined } }).then((r) => r.data?.data?.orders || []),
    enabled: heldView,
    refetchInterval: 30000
  });
  const { data, isLoading } = useQuery({
    queryKey: ['dispatch-recent', warehouse, period],
    enabled: !heldView,
    queryFn: () =>
      client
        .get('/api/dispatch/recent', { params: { warehouse: warehouse || undefined, period: period || undefined } })
        .then((r) => r.data?.data),
    refetchInterval: 30000
  });
  const drafts = data?.new_draft_sos || [];
  const confirmed = data?.finance_confirmed || [];
  const loading = <p className="text-sm text-ink-secondary text-center py-8">Loading…</p>;

  if (heldView) {
    const rows = held.data || [];
    return (
      <Card
        icon={ShieldCheck}
        title="On hold"
        hint="Orders Dispatch flagged, and orders Finance or Management put On Hold — who held each one and why. Dispatch can still prepare them."
        count={rows.length}
      >
        {held.isLoading ? loading : rows.length === 0 ? <Empty text="No order is on hold." /> : (
          <ul className="divide-y divide-slate-100">
            {rows.map((o) => (
              <li key={o.id} className="px-4 py-3 space-y-2">
                <div className="flex justify-between gap-3">
                  <Opener order={o} onOpen={onOpen}>
                    <p className="text-sm font-mono font-semibold text-getmeds-blue">
                      {o.getmeds_order_id}
                      <span className="ml-2 font-sans text-[11px] text-getmeds-blue/80 group-hover:underline">View receipt</span>
                    </p>
                    <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}<WarehouseTag order={o} /></p>
                    <p className="text-xs text-ink-secondary">{o.medrep_name}</p>
                  </Opener>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                    <p className="text-[11px] font-semibold text-ink-secondary">{STAGE_LABEL[o.status] || String(o.status).replace(/_/g, ' ')}</p>
                  </div>
                </div>
                {o.status_hold && (
                  <p className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-900">
                    <span className="font-bold uppercase tracking-wide">On Hold</span>
                    {o.status_hold.by ? ` by ${o.status_hold.by}` : ''}
                    {o.status_hold.at ? ` · ${timeAgo(o.status_hold.at)}` : ''}
                    {o.status_hold.reason ? <> — <span className="font-semibold">{o.status_hold.reason}</span></> : ''}
                  </p>
                )}
                <DeliveryActions
                  order={o}
                  onConfirm={onConfirm}
                  onHold={onHold}
                  onAddTracking={onAddTracking}
                  onCater={onCater}
                  onReleaseCater={onReleaseCater}
                  onHoldOrder={onHoldOrder}
                  onLiftHold={onLiftHold}
                  busy={confirmingId === o.id}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card
        icon={FilePlus2}
        title="New draft SOs"
        hint={
          today
            ? 'Every draft SO created today, waiting on Finance. Nothing to do yet — a heads-up of what is coming.'
            : 'Just created in Zoho and waiting on Finance. Nothing to do yet — a heads-up of what is coming.'
        }
        count={drafts.length}
      >
        {isLoading ? loading : drafts.length === 0 ? <Empty text={today ? 'No draft Sales Orders created today.' : 'No new draft Sales Orders.'} /> : (
          <ul className="divide-y divide-slate-100">
            {drafts.map((o) => (
              <li key={o.id} className="px-4 py-3 flex justify-between gap-3">
                <Opener order={o} onOpen={onOpen}>
                  <p className="text-sm font-mono font-semibold text-getmeds-blue">
                    {o.getmeds_order_id}
                    <span className="ml-2 font-sans text-[11px] text-getmeds-blue/80 group-hover:underline">View receipt</span>
                  </p>
                  <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}<WarehouseTag order={o} /></p>
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
        hint={
          today
            ? 'Every order Finance confirmed today that has not shipped yet — today\'s orders to fulfill.'
            : 'Verified and not shipped yet. Print the address, check it, then confirm the delivery.'
        }
        count={confirmed.length}
      >
        {isLoading ? loading : confirmed.length === 0 ? <Empty text={today ? 'Finance has not confirmed any order today yet.' : 'Nothing confirmed by Finance is waiting.'} /> : (
          <ul className="divide-y divide-slate-100">
            {confirmed.map((o) => (
              <li key={o.id} className="px-4 py-3 space-y-2">
                <div className="flex justify-between gap-3">
                  <Opener order={o} onOpen={onOpen}>
                    <p className="text-sm font-mono font-semibold text-getmeds-blue">
                      {o.getmeds_order_id}
                      <span className="ml-2 font-sans text-[11px] text-getmeds-blue/80 group-hover:underline">View receipt</span>
                    </p>
                    <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}<WarehouseTag order={o} /></p>
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
                <DeliveryActions order={o} onConfirm={onConfirm} onHold={onHold} onAddTracking={onAddTracking} onCater={onCater} onReleaseCater={onReleaseCater} onHoldOrder={onHoldOrder} onLiftHold={onLiftHold} busy={confirmingId === o.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};

export default RecentDispatchPanel;
