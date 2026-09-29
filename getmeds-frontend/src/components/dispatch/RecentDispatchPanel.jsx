import React, { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { FilePlus2, ShieldCheck, CalendarCheck2, PackageCheck, Printer, CheckCircle2, PauseCircle, PlayCircle, ChevronLeft, ChevronRight, AlertTriangle, Search, X } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { formatPHT } from '../../utils/dateUtils';
import DeliveryActions, { deliveryActionFlags, printDeliverySlip } from './DeliveryActions';
import RxBadge from './RxBadge';
import MoreInfoMenu from './MoreInfoMenu';

/**
 * Sep 15, 2026: what is coming Dispatch's way, newest first.
 *
 *   New draft SOs          just created in Zoho, waiting on Finance — a
 *                          heads-up, nothing to do yet
 *   Confirmed by Finance   verified and not shipped — print the address and
 *                          confirm the delivery
 *
 * Sep 28, 2026: each row shows only what decides the next click — the order,
 * who it is for, the one thing to check (an address, a hold reason) and the
 * button. Everything else that used to sit on the row all the time (SO
 * numbers, raw timestamps, a stage label, an all-clear badge nobody has to
 * act on) moved into that row's "⋮" — see MoreInfoMenu.jsx. Nothing about
 * what these lists show or what their buttons do changed, only where the
 * secondary detail lives.
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

// Sep 29, 2026: divisions that fall under Pharmacy verification.
// An order in one of these divisions with rx_state !== 'verified' / 'not_required'
// gets a ⚠️ warning on the Dispatch board so Dispatch knows not to ship it yet.
const PHARMACY_DIVISIONS = new Set(['HOS', 'TeleSales', 'TeleSales Anesthesia', 'B&B', 'STC', 'URO', 'B2C', 'MD Telesales']);
const rxUnverified = (o) =>
  PHARMACY_DIVISIONS.has(o.division) && o.rx_state !== 'verified' && o.rx_state !== 'not_required';

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

// Sep 28, 2026: "Showing 1–15 of 42", Previous / Next — same pattern as the
// Dispatch queue's own pager (pages/dispatch/DispatchQueuePage.jsx).
const Pager = ({ pagination, onPage }) => {
  if (!pagination || pagination.total <= pagination.limit) return null;
  const { page, pages, total, limit } = pagination;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const btn = 'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-primary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-slate-200 bg-surface">
      <p className="text-xs text-ink-secondary">
        Showing <span className="font-semibold text-ink-primary">{from.toLocaleString()}–{to.toLocaleString()}</span> of{' '}
        <span className="font-semibold text-ink-primary">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="w-3.5 h-3.5" /> Previous
        </button>
        <span className="text-xs text-ink-secondary tabular-nums">Page {page} of {pages.toLocaleString()}</span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

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

// Sep 28, 2026: a Dispatch hold, as a small tag beside the order id instead of
// a full sentence taking its own row — same idea as RxBadge's `compact`. The
// reason still shows in full, on hover and in the row's "⋮".
const HoldTag = ({ hold }) =>
  hold ? (
    <span
      className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full border border-amber-300 bg-amber-50 text-amber-900 shrink-0 align-middle"
      title={`On hold by Dispatch — ${hold.reason}${hold.by ? ` (${hold.by})` : ''}`}
    >
      <PauseCircle className="w-3 h-3" />
    </span>
  ) : null;

// Sep 28, 2026: an action as an icon, not a phrase — Cater/Hold/Print/Confirm
// used to be four (or more) full-width text buttons stacked under every row;
// the label still exists, it is just the hover title now instead of always
// printed. Same click handlers, same disabled/eligibility rules throughout —
// only how the button reads changed.
const IconButton = ({ icon: Icon, title, onClick, disabled, tone = 'default' }) => {
  const TONES = {
    default: 'border-slate-300 bg-white text-ink-primary hover:bg-surface',
    primary: 'border-transparent bg-getmeds-blue text-white hover:bg-getmeds-blue-dark',
    amber: 'border-amber-300 bg-white text-amber-900 hover:bg-amber-50'
  };
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md border shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${TONES[tone]}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
};

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
  // Sep 28, 2026: Confirmed Orders (was "Confirmed Today") is its own page —
  // it no longer stops at today, so it only ever grows. Reset to page 1
  // whenever a filter changes underneath it, same as every other paged list
  // on this page (DispatchQueuePage.jsx's own `page`).
  const [confirmedPage, setConfirmedPage] = useState(1);
  const [confirmedSearchInput, setConfirmedSearchInput] = useState('');
  const [confirmedSearch, setConfirmedSearch] = useState('');
  // Debounce the search input 350 ms before sending the query.
  useEffect(() => {
    const t = setTimeout(() => setConfirmedSearch(confirmedSearchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [confirmedSearchInput]);
  // Reset to page 1 whenever any filter changes.
  useEffect(() => { setConfirmedPage(1); }, [warehouse, period, confirmedSearch]);
  const { data, isLoading } = useQuery({
    queryKey: ['dispatch-recent', warehouse, period, confirmedPage, confirmedSearch],
    enabled: !heldView,
    queryFn: () =>
      client
        .get('/api/dispatch/recent', { params: { warehouse: warehouse || undefined, period: period || undefined, confirmedPage, ...(confirmedSearch ? { confirmedSearch } : {}) } })
        .then((r) => r.data?.data),
    placeholderData: keepPreviousData,
    refetchInterval: 30000
  });
  const drafts = data?.new_draft_sos || [];
  const confirmed = data?.finance_confirmed || [];
  const catered = data?.catered_orders || [];
  const confirmedOrders = data?.confirmed_orders || [];
  const confirmedPagination = data?.confirmed_orders_pagination || null;
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
                    <p className="text-sm font-mono font-semibold text-getmeds-blue">{o.getmeds_order_id}<WarehouseTag order={o} /></p>
                    <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                  </Opener>
                  <div className="flex items-start gap-1 shrink-0">
                    <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                    <MoreInfoMenu
                      title={o.getmeds_order_id}
                      items={[
                        { label: 'MedRep', value: o.medrep_name },
                        { label: 'Stage', value: STAGE_LABEL[o.status] || String(o.status).replace(/_/g, ' ') }
                      ]}
                    />
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
    {/* Sep 28, 2026: a 3-column board — New draft SOs, Confirmed by Finance,
        Catered Orders side by side, in the order an order actually moves
        through them, instead of the third stage sitting apart as a full-width
        table below. Same three lists, same data, same actions; only the
        layout and (for Catered Orders) the row style changed to match. */}
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
              <li key={o.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <Opener order={o} onOpen={onOpen}>
                  <p className="text-sm font-mono font-semibold text-getmeds-blue">{o.getmeds_order_id}<WarehouseTag order={o} /></p>
                  <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                </Opener>
                <div className="flex items-center gap-1 shrink-0">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                    <p className="text-[11px] text-amber-800 font-semibold mt-0.5">Waiting {timeAgo(o.created_at)}</p>
                  </div>
                  <MoreInfoMenu
                    title={o.getmeds_order_id}
                    items={[
                      { label: 'SO number', value: o.zoho_so_number },
                      { label: 'MedRep', value: o.medrep_name },
                      { label: 'Prescription', value: o.rx_badge?.label }
                    ]}
                  />
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
            {confirmed.map((o) => {
              // Sep 28, 2026: the same eligibility rules DeliveryActions itself
              // renders from (DeliveryActions.jsx), read here to draw this
              // card's own icon-only layout — nothing about who can do what
              // changed, only how it is drawn.
              const { dispatchHold, canCater, canHoldOrder, canLiftHold } =
                deliveryActionFlags(o, user, { onCater, onHoldOrder, onLiftHold });
              const busy = confirmingId === o.id;
              return (
                <li key={o.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex justify-between gap-3">
                    <Opener order={o} onOpen={onOpen}>
                      <p className="text-sm font-mono font-semibold text-getmeds-blue">
                        {o.getmeds_order_id}<WarehouseTag order={o} />
                        {/* Sep 29, 2026: ⚠️ for pharmacy-channel orders not yet
                            verified — appears whenever rx_state is not 'verified'
                            or 'not_required', so Dispatch knows not to ship yet. */}
                        {rxUnverified(o) && (
                          <span
                            title="⚠️ Prescription Business — Rx not yet verified by Pharmacy. Do not ship until cleared."
                            className="inline-flex items-center ml-1.5 align-middle text-amber-500"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </span>
                        )}
                        {/* Sep 28, 2026: a tag, not a banner — the full wording
                            ("Finance Confirmed — Rx Rejected, waiting for
                            replacement") is now the tag's hover title, and
                            repeated in full in the "⋮" below. Hidden while on
                            hold — that is the one thing blocking it, and the
                            only status this card shows then. */}
                        {o.rx_badge && !dispatchHold && <RxBadge badge={o.rx_badge} compact />}
                        <HoldTag hold={dispatchHold} />
                      </p>
                      <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                      <p className="text-xs text-ink-secondary truncate" title={o.delivery_address || ''}>
                        {o.delivery_address || <span className="text-red-700 font-semibold">No delivery address</span>}
                      </p>
                    </Opener>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                      <div className="flex items-center gap-1">
                        {dispatchHold ? (
                          canLiftHold && <IconButton icon={PlayCircle} title="Lift hold" onClick={() => onLiftHold(o)} disabled={busy} tone="amber" />
                        ) : (
                          <>
                            {canCater && <IconButton icon={PackageCheck} title="Cater this order" onClick={() => onCater(o)} disabled={busy} />}
                            {canHoldOrder && (
                              <IconButton
                                icon={PauseCircle}
                                title="Hold order (e.g. an item is out of stock) — it stays here, and the MedRep and Management are told"
                                onClick={() => onHoldOrder(o)}
                                disabled={busy}
                                tone="amber"
                              />
                            )}
                          </>
                        )}
                        <MoreInfoMenu
                          title={o.getmeds_order_id}
                          items={[
                            { label: 'Stage', value: STAGE_LABEL[o.status] || o.status },
                            { label: 'Finance confirmed', value: timeAgo(o.finance_confirmed_at || o.updated_at) },
                            { label: 'Prescription', value: o.rx_badge?.label },
                            { label: 'Hold reason', value: dispatchHold?.reason },
                            { label: 'Held by', value: dispatchHold ? `${dispatchHold.by}, ${formatPHT(dispatchHold.at, 'short-datetime')}` : null }
                          ]}
                        />
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Sep 28, 2026: Stage 2 of the flow (Confirmed by Finance → Catered
          Orders → Confirmed Orders below), now the third column of the board
          instead of a full-width table below it. Same compact-card style as
          Confirmed by Finance, plus who's catering it and Take over / Release. */}
      <Card
        icon={PackageCheck}
        title="Catered Orders"
        hint="Claimed and being fulfilled. Print the address, check it, then confirm the delivery."
        count={catered.length}
      >
        {isLoading ? loading : catered.length === 0 ? <Empty text="Nobody is catering an order right now." /> : (
          <ul className="divide-y divide-slate-100">
            {catered.map((o) => {
              const { cateredByMe, canRelease, canCater: canTakeOver, canHoldOrder, canConfirm } =
                deliveryActionFlags(o, user, { onCater, onReleaseCater, onHoldOrder, onConfirm });
              const busy = confirmingId === o.id;
              return (
                <li key={o.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex justify-between gap-3">
                    <Opener order={o} onOpen={onOpen}>
                      <p className="text-sm font-mono font-semibold text-getmeds-blue">
                        {o.getmeds_order_id}<WarehouseTag order={o} />
                        {rxUnverified(o) && (
                          <span
                            title="⚠️ Prescription Business — Rx not yet verified by Pharmacy. Do not ship until cleared."
                            className="inline-flex items-center ml-1.5 align-middle text-amber-500"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </span>
                        )}
                        {o.rx_badge && <RxBadge badge={o.rx_badge} compact />}
                      </p>
                      <p className="text-sm text-ink-primary font-medium truncate">{o.customer_name}</p>
                      <p className="text-xs text-ink-secondary truncate" title={o.delivery_address || ''}>
                        {o.delivery_address || <span className="text-red-700 font-semibold">No delivery address</span>}
                      </p>
                    </Opener>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <p className="text-sm font-semibold text-ink-primary">{peso(o.total_amount)}</p>
                      <div className="flex items-center gap-1">
                        <IconButton icon={Printer} title="Print address" onClick={() => printDeliverySlip(o.id)} />
                        {canConfirm && (
                          <IconButton
                            icon={CheckCircle2}
                            title={o.rx_blocking ? 'Confirm for delivery — the prescription has to be verified by the pharmacist first' : 'Confirm for delivery'}
                            onClick={() => onConfirm(o)}
                            disabled={busy || o.rx_blocking}
                            tone="primary"
                          />
                        )}
                        {canHoldOrder && (
                          <IconButton
                            icon={PauseCircle}
                            title="Hold order (e.g. an item is out of stock) — it stays here, and the MedRep and Management are told"
                            onClick={() => onHoldOrder(o)}
                            disabled={busy}
                            tone="amber"
                          />
                        )}
                        <MoreInfoMenu
                          title={o.getmeds_order_id}
                          items={[
                            { label: 'Receiver', value: o.intake_receiver },
                            { label: 'Catering since', value: o.catered?.at ? timeAgo(o.catered.at) : null },
                            { label: 'Prescription', value: o.rx_badge?.label }
                          ]}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-ink-secondary">Catered by <span className="font-semibold text-ink-primary">{cateredByMe ? 'You' : o.catered?.by}</span></span>
                    {canRelease && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onReleaseCater(o)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 bg-white text-[11px] font-semibold text-ink-secondary hover:bg-surface disabled:opacity-50"
                      >
                        Release
                      </button>
                    )}
                    {canTakeOver && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onCater(o)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-getmeds-blue bg-white text-[11px] font-semibold text-getmeds-blue hover:bg-getmeds-blue/5 disabled:opacity-50"
                      >
                        Take over
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>

    {/* Sep 28, 2026: every order ANY Dispatch account has confirmed for
        delivery — "Confirmed Today" read as one dispatcher's own log because
        it silently combined "only today" with a viewer who happened to always
        be the one who'd just confirmed it in testing; neither was ever an
        intentional filter. Now: every confirmation, from every dispatcher,
        bound to the same Warehouse / Time filters at the top of the page
        (Time: Today narrows it the same way it narrows the two lists above),
        and paged since without the today-only cutoff it only grows. */}
    <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-surface">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-2">
              <CalendarCheck2 className="w-4 h-4 text-getmeds-blue" />
              Confirmed Orders
              <span className={`min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums ${confirmedPagination?.total ? 'bg-getmeds-blue text-white' : 'bg-slate-100 text-ink-secondary'}`}>
                {confirmedPagination?.total ?? confirmedOrders.length}
              </span>
              {confirmedSearch && confirmedPagination && (
                <span className="text-xs font-normal text-ink-secondary">
                  — {confirmedPagination.total.toLocaleString()} matching
                </span>
              )}
            </h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              {today
                ? 'Confirmed for delivery today, across the whole Dispatch team — newest first.'
                : 'Confirmed for delivery, across the whole Dispatch team — newest first.'}
            </p>
          </div>
          <div className="relative shrink-0 mt-0.5">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-secondary pointer-events-none" />
            <input
              type="text"
              value={confirmedSearchInput}
              onChange={(e) => setConfirmedSearchInput(e.target.value)}
              placeholder="Search orders…"
              className="pl-8 pr-7 py-1.5 text-xs rounded-full border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-getmeds-blue/30 focus:border-getmeds-blue w-44"
            />
            {confirmedSearchInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setConfirmedSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-secondary hover:text-ink-primary"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      {isLoading ? loading : confirmedOrders.length === 0 ? (
        <Empty text={today ? 'Nothing confirmed for delivery yet today.' : 'Nothing confirmed for delivery yet.'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Order</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Confirmed by</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-ink-secondary uppercase">Tracking</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-ink-secondary uppercase">Total</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {confirmedOrders.map((o) => (
                <tr key={o.id} className="hover:bg-surface">
                  <td className="px-4 py-2.5 align-top">
                    <Opener order={o} onOpen={onOpen}>
                      <p className="text-sm font-mono font-semibold text-getmeds-blue group-hover:underline">{o.getmeds_order_id}<WarehouseTag order={o} /></p>
                    </Opener>
                  </td>
                  <td className="px-4 py-2.5 align-top text-sm text-ink-primary font-medium">{o.customer_name}</td>
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
                  <td className="px-2 py-2.5 align-top text-right">
                    <MoreInfoMenu
                      title={o.getmeds_order_id}
                      items={[
                        { label: 'Receiver', value: o.intake_receiver },
                        { label: 'Address', value: o.delivery_address },
                        { label: 'Prescription', value: o.rx_badge?.label }
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager pagination={confirmedPagination} onPage={setConfirmedPage} />
    </div>
    </div>
  );
};

export default RecentDispatchPanel;
