import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, ShieldCheck, CalendarCheck2, PackageCheck, Printer, CheckCircle2, PauseCircle } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import DeliveryActions, { CONFIRMABLE_STATUSES, printDeliverySlip } from './DeliveryActions';
import RxBadge from './RxBadge';

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
  const catered = data?.catered_orders || [];
  const confirmedToday = data?.confirmed_today || [];
  const { user } = useAuth();
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
    <div className="space-y-4">
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
                  {o.rx_badge && <div className="mt-1"><RxBadge badge={o.rx_badge} /></div>}
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
                {/* Sep 25, 2026: what is holding it up, when it carries a prescription.
                    Sep 28, 2026: not while Dispatch itself has it on hold — that is
                    the one thing blocking it, and the only banner this card shows. */}
                {o.rx_badge && !o.dispatch_hold && <div><RxBadge badge={o.rx_badge} /></div>}
                <DeliveryActions
                  order={o} onConfirm={onConfirm} onHold={onHold} onAddTracking={onAddTracking} onCater={onCater}
                  onReleaseCater={onReleaseCater} onHoldOrder={onHoldOrder} onLiftHold={onLiftHold} busy={confirmingId === o.id}
                  compact
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>

    {/* Sep 28, 2026: what a Dispatch person has claimed and is actively
        fulfilling — Stage 2 of the flow (Confirmed by Finance → Catered
        Orders → Confirmed Today). Pressing "Cater this order" moves it out of
        the panel above and into here; pressing "Confirm for delivery" moves it
        on again, into the table below. */}
    <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-surface">
        <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-2">
          <PackageCheck className="w-4 h-4 text-getmeds-blue" />
          Catered Orders
          <span className={`min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums ${catered.length ? 'bg-getmeds-blue text-white' : 'bg-slate-100 text-ink-secondary'}`}>
            {catered.length}
          </span>
        </h2>
        <p className="text-xs text-ink-secondary mt-0.5">Claimed and being fulfilled. Print the address, check it, then confirm the delivery.</p>
      </div>
      {isLoading ? loading : catered.length === 0 ? (
        <Empty text="Nobody is catering an order right now." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Order</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Receiver / Address</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Catered by</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-ink-secondary uppercase">Total</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {catered.map((o) => {
                const role = String(user?.role || '').toLowerCase();
                const cateredByMe = Boolean(o.catered) && String(o.catered.by_id) === String(user?.id);
                const canRelease = cateredByMe || ['management', 'admin'].includes(role);
                const canTakeOver = ['dispatch', 'admin'].includes(role) && !cateredByMe;
                const canHoldOrder = CONFIRMABLE_STATUSES.includes(o.status);
                return (
                  <tr key={o.id} className="hover:bg-surface">
                    <td className="px-4 py-2.5 align-top">
                      <Opener order={o} onOpen={onOpen}>
                        <p className="text-sm font-mono font-semibold text-getmeds-blue group-hover:underline">
                          {o.getmeds_order_id}<WarehouseTag order={o} />
                        </p>
                      </Opener>
                      {o.rx_badge && <div className="mt-1"><RxBadge badge={o.rx_badge} /></div>}
                    </td>
                    <td className="px-4 py-2.5 align-top text-sm text-ink-primary font-medium">{o.customer_name}</td>
                    <td className="px-4 py-2.5 align-top text-xs text-ink-secondary max-w-xs">
                      {o.intake_receiver && <p className="text-ink-primary font-medium">{o.intake_receiver}</p>}
                      <p className="truncate" title={o.delivery_address || ''}>
                        {o.delivery_address || <span className="text-red-700 font-semibold">No delivery address</span>}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 align-top text-xs text-ink-secondary">
                      <p className="text-sm text-ink-primary font-medium">{cateredByMe ? 'You' : o.catered?.by}</p>
                      {o.catered?.at && <p>{timeAgo(o.catered.at)}</p>}
                      {canRelease && (
                        <button
                          type="button"
                          disabled={confirmingId === o.id}
                          onClick={() => onReleaseCater(o)}
                          className="mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 bg-white text-[11px] font-semibold text-ink-secondary hover:bg-surface disabled:opacity-50"
                        >
                          Release
                        </button>
                      )}
                      {canTakeOver && (
                        <button
                          type="button"
                          disabled={confirmingId === o.id}
                          onClick={() => onCater(o)}
                          className="mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-getmeds-blue bg-white text-[11px] font-semibold text-getmeds-blue hover:bg-getmeds-blue/5 disabled:opacity-50"
                        >
                          Take over
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top text-right text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => printDeliverySlip(o.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 bg-white text-[11px] font-semibold text-ink-primary hover:bg-surface"
                        >
                          <Printer className="w-3 h-3" />
                          Print address
                        </button>
                        <button
                          type="button"
                          disabled={confirmingId === o.id || o.rx_blocking}
                          onClick={() => onConfirm(o)}
                          title={o.rx_blocking ? 'The prescription has to be verified by the pharmacist first.' : undefined}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-getmeds-blue text-white text-[11px] font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Confirm for delivery
                        </button>
                        {canHoldOrder && (
                          <button
                            type="button"
                            disabled={confirmingId === o.id}
                            onClick={() => onHoldOrder(o)}
                            title="Flag it on hold (e.g. an item is out of stock) — it stays here, and the MedRep and Management are told"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-300 bg-white text-[11px] font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-50"
                          >
                            <PauseCircle className="w-3 h-3" />
                            Hold order
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>

    {/* Sep 28, 2026: every order Dispatch itself confirmed for delivery today
        ("Confirm for delivery" on a receipt) — a running log of today's work,
        full-width below the two lists above. Filtered by the same warehouse
        pill; always "today" regardless of the Any time / Today toggle. */}
    <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-surface">
        <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-2">
          <CalendarCheck2 className="w-4 h-4 text-getmeds-blue" />
          Confirmed Today
          <span className={`min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums ${confirmedToday.length ? 'bg-getmeds-blue text-white' : 'bg-slate-100 text-ink-secondary'}`}>
            {confirmedToday.length}
          </span>
        </h2>
        <p className="text-xs text-ink-secondary mt-0.5">Orders confirmed for delivery today, newest first.</p>
      </div>
      {isLoading ? loading : confirmedToday.length === 0 ? (
        <Empty text="Nothing confirmed for delivery yet today." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Order</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Receiver / Address</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Confirmed by</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Tracking</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-ink-secondary uppercase">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {confirmedToday.map((o) => (
                <tr key={o.id} className="hover:bg-surface">
                  <td className="px-4 py-2.5 align-top">
                    <Opener order={o} onOpen={onOpen}>
                      <p className="text-sm font-mono font-semibold text-getmeds-blue group-hover:underline">{o.getmeds_order_id}</p>
                      {o.rx_badge && <div className="mt-1"><RxBadge badge={o.rx_badge} /></div>}
                    </Opener>
                  </td>
                  <td className="px-4 py-2.5 align-top text-sm text-ink-primary font-medium">
                    {o.customer_name}<WarehouseTag order={o} />
                  </td>
                  <td className="px-4 py-2.5 align-top text-xs text-ink-secondary max-w-xs">
                    {o.intake_receiver && <p className="text-ink-primary font-medium">{o.intake_receiver}</p>}
                    <p className="truncate" title={o.delivery_address || ''}>
                      {o.delivery_address || <span className="text-red-700 font-semibold">No delivery address</span>}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 align-top text-xs text-ink-secondary">
                    <p className="text-sm text-ink-primary font-medium">{o.delivery_confirmed_by || '—'}</p>
                    {o.delivery_confirmed_at && <p>{timeAgo(o.delivery_confirmed_at)}</p>}
                  </td>
                  <td className="px-4 py-2.5 align-top text-xs text-ink-secondary">
                    {/* Sep 28, 2026: whichever tracking number the order actually
                        has — Zoho's own once it ships, or the one Dispatch typed
                        in ahead of that (entered_tracking) — same precedence the
                        card badge uses (DeliveryActions.jsx). Card and table used
                        to disagree because this only checked Zoho's. */}
                    {o.tracking_number
                      ? <span className="font-mono text-ink-primary">{o.entered_tracking?.courier ? `${o.entered_tracking.courier} · ` : ''}{o.tracking_number}</span>
                      : o.entered_tracking
                        ? <span className="font-mono text-ink-primary">{o.entered_tracking.courier} · {o.entered_tracking.tracking_number}</span>
                        : o.tracking_hold
                          ? <span className="text-amber-800 font-semibold">On hold — {o.tracking_hold.reason || 'no reason given'}</span>
                          : <span>Awaiting tracking</span>}
                  </td>
                  <td className="px-4 py-2.5 align-top text-right text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </div>
  );
};

export default RecentDispatchPanel;
