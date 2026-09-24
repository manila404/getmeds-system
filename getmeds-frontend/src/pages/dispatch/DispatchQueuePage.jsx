import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle, RefreshCw, PackageCheck, Truck, ExternalLink, Receipt, MapPin, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import client from '../../api/client';
import DeliveryConfirmModal from '../../components/dispatch/DeliveryConfirmModal';
import OrderDetailsModal from '../../components/finance/OrderDetailsModal';
import RecentDispatchPanel from '../../components/dispatch/RecentDispatchPanel';
import DeliveryActions, { CONFIRMABLE_STATUSES, DISPATCH_PROOF_STATUSES } from '../../components/dispatch/DeliveryActions';
import HoldTrackingModal from '../../components/dispatch/HoldTrackingModal';
import HoldOrderModal from '../../components/dispatch/HoldOrderModal';
import { DISPATCH_WAREHOUSES } from '../../constants/dispatchWarehouses';
import StockAnnouncementsManager from '../../components/stock/StockAnnouncementsManager';

/**
 * Sep 12, 2026: two versions of this page, chosen by the server.
 *
 * With GETMEDS_WORKFLOW_V2 on (the queue response says `workflow_v2: true`)
 * Dispatch works here: create and send the invoice, mark packed, ship, mark
 * delivered. Each button makes the matching change in Zoho — see the backend's
 * services/workflowV2Service.js — so nobody has to open Zoho Inventory.
 *
 * With it off, this is the read-only mirror it has been since Aug 31: the work
 * happens in Zoho and this page follows along. Nothing in that version changed.
 */

// The four steps, in the order the parcel goes through them. Which statuses
// fall in each comes from the server (`steps` in the queue response), so the
// grouping cannot drift from the query that selects the rows.
const STEPS = [
  {
    key: 'needs_invoice',
    label: 'Needs invoice',
    icon: Receipt,
    hint: 'Finance confirmed these. Create the invoice from the Sales Order and send it to the customer.',
  },
  {
    key: 'ready_to_pack',
    label: 'Ready to pack',
    icon: PackageCheck,
    hint: 'Invoice sent. Pick and pack the whole order, then mark it packed — that creates the package in Zoho.',
  },
  {
    key: 'ready_to_ship',
    label: 'Ready to ship',
    icon: Truck,
    hint: 'Packed. Enter the courier and tracking number to ship — that creates the shipment in Zoho and sends the MedRep the tracking number.',
  },
  {
    key: 'awaiting_delivery',
    label: 'Awaiting delivery',
    icon: MapPin,
    hint: 'On the road. Mark it delivered once the courier confirms.',
  },
];

const peso = (n) => `₱${(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

const waitingHours = (order) => {
  if (!order.updated_at) return '—';
  const h = (Date.now() - new Date(order.updated_at).getTime()) / 3600000;
  return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
};

// What to tell the person after each button, from what the server did.
const doneMessage = (action, d = {}) => {
  const tail = `${d.adopted ? ' It was already in Zoho, so it was recorded rather than made twice.' : ''}${d.dryRun ? ' (Dry run — Zoho was not contacted.)' : ''}`;
  if (action === 'invoice') {
    return d.status === 'ready_for_dispatch'
      ? `Invoice ${d.invoiceNumber || ''} sent to the customer.${tail}`
      : `Invoice ${d.invoiceNumber || ''} created, but Zoho did not mark it sent: ${d.sendError}. Press Send invoice to try again.`;
  }
  if (action === 'pack') return `Packed${d.packageNumber ? ` — package ${d.packageNumber}` : ''}.${tail}`;
  if (action === 'ship') {
    return `Shipped. The MedRep has the tracking number.${d.status === 'completed' ? ' Already paid, so the order is now complete.' : ''}${tail}`;
  }
  return `Marked delivered.${tail}`;
};

const PAGE_SIZE = 25;

// Sep 15, 2026: "Showing 1–25 of 10,108", and Previous / Next.
const Pager = ({ pagination, onPage, fetching }) => {
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
        {fetching && <span className="ml-2">Loading…</span>}
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

const DispatchQueuePage = () => {
  const qc = useQueryClient();

  // Sep 15, 2026: the queue is paged and searchable on the server. Before,
  // it came back whole — 10,108 orders, nearly all imported from Zoho, drawn
  // in one list. Search waits for a pause in typing so each key is not a query.
  const [stepKey, setStepKey] = useState('needs_invoice');
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState('all');
  // Sep 15, 2026: everyone's, the ones I cater, or the ones nobody has yet.
  const [caterFilter, setCaterFilter] = useState('');
  // Sep 15, 2026: one of Dispatch's three warehouses, for the whole page —
  // the Recent lists and the queue alike. '' is all of them.
  const [warehouse, setWarehouse] = useState('');
  // Sep 15, 2026: "Today" — the two Recent lists show every draft SO created
  // today and every order Finance confirmed today. The queue below is unaffected.
  const [period, setPeriod] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => { setPage(1); }, [search, origin, stepKey, caterFilter, warehouse]);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['dispatch-queue', { page, search, origin, step: stepKey, cater: caterFilter, warehouse }],
    queryFn: () =>
      client
        .get('/api/dispatch/queue', {
          params: {
            page, limit: PAGE_SIZE, search: search || undefined, origin, step: stepKey,
            cater: caterFilter || undefined, warehouse: warehouse || undefined
          }
        })
        .then(r => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 30000
  });
  const orders = data?.data?.orders || [];
  const workflowV2 = Boolean(data?.data?.workflow_v2);
  const stepStatuses = data?.data?.steps || {};
  const pagination = data?.data?.pagination || null;
  const statusCounts = data?.data?.status_counts || {};
  const total = pagination?.total ?? orders.length;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-slate-200 bg-white">
      <div className="relative flex-1 min-w-[14rem]">
        <Search className="w-4 h-4 text-ink-secondary absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search order no., customer, SO no., MedRep or tracking no."
          className="w-full pl-8 pr-2 py-1.5 text-sm rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
        />
      </div>
      {!workflowV2 && (
        <select
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          className="py-1.5 px-2 text-sm rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
          title="Where the order was raised"
        >
          <option value="all">All orders</option>
          <option value="getmeds">Raised in GetMeds</option>
          <option value="zoho">Imported from Zoho</option>
        </select>
      )}
      <select
        value={caterFilter}
        onChange={(e) => setCaterFilter(e.target.value)}
        className="py-1.5 px-2 text-sm rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
        title="Who caters the order"
      >
        <option value="">Everyone's orders</option>
        <option value="mine">Catered by me</option>
        <option value="open">Not catered yet</option>
      </select>
    </div>
  );
  const pager = <Pager pagination={pagination} onPage={setPage} fetching={isFetching} />;
  // Ship needs two fields per row; kept by order id so typing in one row
  // never fills another.
  const [shipForm, setShipForm] = useState({});
  const setShipField = (id, field, value) =>
    setShipForm((f) => ({ ...f, [id]: { ...f[id], [field]: value } }));

  const act = useMutation({
    mutationFn: ({ id, action, body }) =>
      client.post(`/api/dispatch/orders/${id}/${action}`, body || {}).then(r => r.data),
    onSuccess: (res, vars) => {
      const d = res?.data || {};
      if (vars.action === 'invoice' && d.status !== 'ready_for_dispatch') toast.error(doneMessage(vars.action, d), { duration: 8000 });
      else toast.success(doneMessage(vars.action, d));
      if (vars.action === 'ship') setShipForm((f) => { const n = { ...f }; delete n[vars.id]; return n; });
      qc.invalidateQueries({ queryKey: ['dispatch-queue'] });
    },
    onError: (err) => {
      toast.error(err.response?.data?.error?.message || 'Could not do that. Refresh and check the order.', { duration: 8000 });
      // The usual cause is someone else having moved the order on — show them
      // where it is now rather than leaving the stale row up.
      qc.invalidateQueries({ queryKey: ['dispatch-queue'] });
    }
  });
  const busyOn = (id) => act.isPending && act.variables?.id === id;

  // Sep 15, 2026: "Confirmed for delivery" — records who checked the address
  // and when. Changes no status and writes nothing to Zoho.
  const [confirmFor, setConfirmFor] = useState(null);
  // Sep 15, 2026: the order whose receipt is open — clicking an order shows
  // everything needed to prepare it (items, delivery, attachments).
  const [viewing, setViewing] = useState(null);
  // Sep 15, 2026: the order whose tracking number is being put on hold, and
  // the one whose tracking number is being added (after an earlier confirm).
  const [holdFor, setHoldFor] = useState(null);
  const [trackingFor, setTrackingFor] = useState(null);

  // Every Dispatch record here answers with the order's new confirmation /
  // tracking state; the open receipt and both lists pick it up.
  const afterRecord = (res) => {
    toast.success(res.message, { duration: 7000 });
    setConfirmFor(null);
    setHoldFor(null);
    setTrackingFor(null);
    setViewing((v) => {
      if (!v || v.id !== res.id) return v;
      const next = { ...v };
      for (const key of ['delivery_confirmed_by', 'delivery_confirmed_at', 'entered_tracking', 'tracking_hold', 'catered', 'dispatch_hold']) {
        if (key in res) next[key] = res[key];
      }
      if ('delivery_confirmed_at' in res) next.delivery_address_changed = false;
      return next;
    });
    qc.invalidateQueries({ queryKey: ['dispatch-queue'] });
    qc.invalidateQueries({ queryKey: ['dispatch-recent'] });
    qc.invalidateQueries({ queryKey: ['my-orders'] });
    qc.invalidateQueries({ queryKey: ['dispatch-on-hold'] });
  };
  const recordError = (err) =>
    toast.error(err.response?.data?.error?.message || 'Could not save that. Refresh and check the order.', { duration: 8000 });

  // Confirm for delivery, with the tracking number added now or put on hold.
  const confirmDelivery = useMutation({
    mutationFn: ({ id, ...body }) => client.post(`/api/dispatch/orders/${id}/confirm-delivery`, body).then((r) => r.data?.data),
    onSuccess: afterRecord,
    onError: recordError
  });
  const holdTracking = useMutation({
    mutationFn: ({ id, reason, note }) =>
      client.post(`/api/dispatch/orders/${id}/tracking-hold`, { reason, note }).then((r) => r.data?.data),
    onSuccess: afterRecord,
    onError: recordError
  });
  const addTracking = useMutation({
    mutationFn: ({ id, tracking }) => client.post(`/api/dispatch/orders/${id}/tracking`, tracking).then((r) => r.data?.data),
    onSuccess: afterRecord,
    onError: recordError
  });

  // Sep 15, 2026: Dispatch's hold on an order — a flag; it keeps its place.
  const [holdOrderFor, setHoldOrderFor] = useState(null);
  const holdOrder = useMutation({
    mutationFn: ({ id, reason }) => client.post(`/api/dispatch/orders/${id}/hold`, { reason }).then((r) => r.data?.data),
    onSuccess: (res) => {
      setHoldOrderFor(null);
      afterRecord(res);
    },
    onError: recordError
  });
  const liftHold = useMutation({
    mutationFn: ({ id }) => client.post(`/api/dispatch/orders/${id}/hold/lift`).then((r) => r.data?.data),
    onSuccess: afterRecord,
    onError: recordError
  });

  // Sep 15, 2026: cater an order (take it on), or release it for anyone.
  const caterOrder = useMutation({
    mutationFn: ({ id }) => client.post(`/api/dispatch/orders/${id}/cater`).then((r) => r.data?.data),
    onSuccess: afterRecord,
    onError: recordError
  });
  const releaseCater = useMutation({
    mutationFn: ({ id }) => client.post(`/api/dispatch/orders/${id}/cater/release`).then((r) => r.data?.data),
    onSuccess: afterRecord,
    onError: recordError
  });

  // Sep 15, 2026: the receipt's footer acts on the order as it is NOW. `viewing`
  // is the row it was opened from, which can be minutes old — GM-20260915-0028
  // had moved to "tracking shared" and the footer still offered what its old
  // status allowed. The receipt already fetches the order; this reads the same
  // cached request (same key as components/finance/OrderDetailsModal.jsx).
  const viewingDetail = useQuery({
    queryKey: ['finance-order-detail', viewing?.id],
    queryFn: () => client.get(`/api/orders/${viewing.id}`).then((r) => r.data),
    enabled: Boolean(viewing?.id)
  });
  const freshStatus = viewingDetail.data?.data?.order?.status;
  const viewingNow = viewing && freshStatus ? { ...viewing, status: freshStatus } : viewing;

  const pendingId = (m) => (m.isPending ? m.variables?.id : null);
  const confirmingId =
    pendingId(confirmDelivery) ?? pendingId(holdTracking) ?? pendingId(addTracking) ??
    pendingId(caterOrder) ?? pendingId(releaseCater) ?? pendingId(holdOrder) ?? pendingId(liftHold);
  const onCater = (o) => caterOrder.mutate({ id: o.id });
  const onReleaseCater = (o) => releaseCater.mutate({ id: o.id });
  const actionProps = (order) => ({
    order,
    onConfirm: setConfirmFor,
    onHold: setHoldFor,
    onAddTracking: setTrackingFor,
    onCater,
    onReleaseCater,
    onHoldOrder: setHoldOrderFor,
    onLiftHold: (o) => liftHold.mutate({ id: o.id }),
    busy: confirmingId === order.id
  });
  const deliveryActions = (order) =>
    CONFIRMABLE_STATUSES.includes(order.status) || DISPATCH_PROOF_STATUSES.includes(order.status) ||
    order.delivery_confirmed_at || order.tracking_hold ? (
      <DeliveryActions {...actionProps(order)} />
    ) : null;

  const recentAndDialog = (
    <>
      {/* Sep 15, 2026: Dispatch announces stock to MedReps and Management. */}
      <StockAnnouncementsManager />
      {/* Sep 15, 2026: the warehouse filter — sorted by the order's Division
          on the server (services/dispatchWarehouses.js). */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Warehouse">
        {DISPATCH_WAREHOUSES.map((w) => {
          const selected = w.key === warehouse;
          return (
            <button
              key={w.key || 'all'}
              type="button"
              role="tab"
              aria-selected={selected}
              title={w.hint || ''}
              onClick={() => setWarehouse(w.key)}
              className={`px-3 py-1.5 rounded-full border text-sm font-semibold ${
                selected
                  ? 'border-getmeds-blue bg-getmeds-blue text-white'
                  : 'border-slate-200 bg-white text-ink-secondary hover:bg-surface hover:text-ink-primary'
              }`}
            >
              {w.label}
            </button>
          );
        })}
        <span className="mx-1 w-px self-stretch bg-slate-200" aria-hidden="true" />
        {[['', 'Any time'], ['today', 'Today'], ['on_hold', '⏸ On hold']].map(([key, label]) => (
          <button
            key={key || 'any'}
            type="button"
            aria-pressed={period === key}
            title={key === 'today' ? "Every draft SO created today and every order Finance confirmed today" : 'The latest 20 in each list'}
            onClick={() => setPeriod(key)}
            className={`px-3 py-1.5 rounded-full border text-sm font-semibold ${
              period === key
                ? 'border-pharmacy-green bg-pharmacy-green text-white'
                : 'border-slate-200 bg-white text-ink-secondary hover:bg-surface hover:text-ink-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <RecentDispatchPanel
        warehouse={warehouse}
        period={period}
        onConfirm={setConfirmFor}
        onHold={setHoldFor}
        onAddTracking={setTrackingFor}
        onCater={onCater}
        onReleaseCater={onReleaseCater}
        onHoldOrder={setHoldOrderFor}
        onLiftHold={(o) => liftHold.mutate({ id: o.id })}
        confirmingId={confirmingId}
        onOpen={setViewing}
      />
      {/* Before the dialogs below, so they open on top of it. */}
      {viewing && (
        <OrderDetailsModal
          orderId={viewing.id}
          onClose={() => setViewing(null)}
          footer={<DeliveryActions {...actionProps(viewingNow)} />}
        />
      )}
      {confirmFor && (
        <DeliveryConfirmModal
          order={confirmFor}
          mode="confirm"
          onClose={() => setConfirmFor(null)}
          onSubmit={(body) => confirmDelivery.mutate({ id: confirmFor.id, ...body })}
          saving={confirmDelivery.isPending}
        />
      )}
      {trackingFor && (
        <DeliveryConfirmModal
          order={trackingFor}
          mode="tracking"
          onClose={() => setTrackingFor(null)}
          onSubmit={({ tracking }) => addTracking.mutate({ id: trackingFor.id, tracking })}
          saving={addTracking.isPending}
        />
      )}
      {holdFor && (
        <HoldTrackingModal
          order={holdFor}
          onClose={() => setHoldFor(null)}
          onSave={({ reason, note }) => holdTracking.mutate({ id: holdFor.id, reason, note })}
          saving={holdTracking.isPending}
        />
      )}
      {holdOrderFor && (
        <HoldOrderModal
          order={holdOrderFor}
          onClose={() => setHoldOrderFor(null)}
          onSave={(reason) => holdOrder.mutate({ id: holdOrderFor.id, reason })}
          saving={holdOrder.isPending}
        />
      )}
    </>
  );

  const header = (
    <div className="flex items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-ink-primary">{workflowV2 ? 'Dispatch' : 'Zoho Dispatch Status'}</h1>
        <p className="text-sm text-ink-secondary mt-1">
          {workflowV2
            ? 'Invoice, pack, ship and deliver from here. Each step updates Zoho for you.'
            : 'Orders waiting on Pharmacy/Dispatch in Zoho. This list is read-only — create the Package and Shipment in Zoho Inventory itself; this page updates automatically once that happens.'}
        </p>
      </div>
      <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0">
        <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
      </button>
    </div>
  );

  const spinner = <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>;

  const orderSummary = (order) => (
    <div className="flex justify-between items-start gap-4">
      <div
        role="button"
        tabIndex={0}
        title="View the receipt"
        onClick={() => setViewing(order)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewing(order); } }}
        className="min-w-0 cursor-pointer group"
      >
        <p className="text-sm font-mono font-semibold text-getmeds-blue">
          {order.getmeds_order_id}
          <span className="ml-2 font-sans text-[11px] font-semibold text-getmeds-blue/80 group-hover:underline">View receipt</span>
        </p>
        <p className="text-sm text-ink-primary mt-0.5 font-medium truncate">
          {order.customer_name}
          {order.warehouse && (
            <span className="ml-1.5 align-middle text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-ink-secondary">
              {order.warehouse.label}
            </span>
          )}
        </p>
        <p className="text-xs text-ink-secondary">{order.medrep_name}</p>
        {(order.zoho_so_number || order.zoho_invoice_number || order.zoho_package_number) && (
          <p className="text-xs text-ink-secondary mt-1">
            {order.zoho_so_number && <>SO <span className="font-mono">{order.zoho_so_number}</span></>}
            {order.zoho_invoice_number && <> · Invoice <span className="font-mono">{order.zoho_invoice_number}</span></>}
            {order.zoho_package_number && <> · Package <span className="font-mono">{order.zoho_package_number}</span></>}
          </p>
        )}
        {(order.courier || order.tracking_number) && (
          <p className="text-xs text-ink-secondary mt-1">
            {order.courier && <>Courier: <span className="font-medium">{order.courier}</span></>}
            {order.tracking_number && <> · Tracking: <span className="font-mono">{order.tracking_number}</span></>}
          </p>
        )}
        {/* Sep 22, 2026: split-invoicing orders — one tracking number entered
            here still goes to every Sales Order (workflowV2Service.
            pushDispatchActionToSplits), so nothing changes about what Dispatch
            does. This just explains why the receipt then shows two Zoho
            package/shipment confirmations instead of one. */}
        {Number(order.split_count) > 0 && (
          <p className="text-xs font-semibold text-indigo-700 mt-1">
            Split order — also billed to {order.split_entities}. One tracking number covers both.
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold text-ink-primary">{peso(order.total_amount)}</p>
        <p className="text-xs text-ink-secondary font-medium mt-0.5">Waiting {waitingHours(order)}</p>
      </div>
    </div>
  );

  // ─── Switch on: Dispatch works here ─────────────────────────────────────
  if (workflowV2) {
    // The server returns only the chosen step's page; the tab counts come
    // from its per-status totals.
    const stepCount = (key) => (stepStatuses[key] || []).reduce((n, s) => n + (Number(statusCounts[s]) || 0), 0);
    const current = STEPS.find((s) => s.key === stepKey) || STEPS[0];
    const rows = orders;
    const primary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-pharmacy-green text-white text-xs font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed';

    const actionFor = (order) => {
      const busy = busyOn(order.id);
      if (current.key === 'needs_invoice') {
        const onlySend = order.status === 'ready_for_invoice_sent';
        return (
          <button type="button" disabled={busy} className={primary} onClick={() => act.mutate({ id: order.id, action: 'invoice' })}>
            <Receipt className="w-3.5 h-3.5" />
            {busy ? 'Working…' : onlySend ? 'Send invoice' : 'Create & send invoice'}
          </button>
        );
      }
      if (current.key === 'ready_to_pack') {
        return (
          <button type="button" disabled={busy} className={primary} onClick={() => act.mutate({ id: order.id, action: 'pack' })}>
            <PackageCheck className="w-3.5 h-3.5" />
            {busy ? 'Working…' : 'Mark packed'}
          </button>
        );
      }
      if (current.key === 'ready_to_ship') {
        const f = shipForm[order.id] || {};
        const ready = (f.courier || '').trim() && (f.tracking || '').trim();
        return (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) act.mutate({ id: order.id, action: 'ship', body: { courier: f.courier.trim(), trackingNumber: f.tracking.trim() } });
            }}
          >
            <label className="text-xs text-ink-secondary" htmlFor={`courier-${order.id}`}>
              Courier
              <input
                id={`courier-${order.id}`}
                value={f.courier || ''}
                onChange={(e) => setShipField(order.id, 'courier', e.target.value)}
                placeholder="e.g. LBC"
                className="mt-0.5 block w-32 text-sm rounded-md border border-slate-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
              />
            </label>
            <label className="text-xs text-ink-secondary" htmlFor={`tracking-${order.id}`}>
              Tracking number
              <input
                id={`tracking-${order.id}`}
                value={f.tracking || ''}
                onChange={(e) => setShipField(order.id, 'tracking', e.target.value)}
                className="mt-0.5 block w-44 text-sm font-mono rounded-md border border-slate-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
              />
            </label>
            <button type="submit" disabled={busy || !ready} className={primary}>
              <Truck className="w-3.5 h-3.5" />
              {busy ? 'Working…' : 'Ship'}
            </button>
          </form>
        );
      }
      return (
        <button type="button" disabled={busy} className={primary} onClick={() => act.mutate({ id: order.id, action: 'deliver' })}>
          <CheckCircle className="w-3.5 h-3.5" />
          {busy ? 'Working…' : 'Mark delivered'}
        </button>
      );
    };

    return (
      <div className="space-y-6">
        {header}
        {recentAndDialog}

        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Dispatch steps">
          {STEPS.map((s) => {
            const Icon = s.icon;
            const count = stepCount(s.key);
            const selected = s.key === current.key;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setStepKey(s.key)}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-semibold ${selected ? 'border-getmeds-blue bg-getmeds-blue/10 text-getmeds-blue-dark' : 'border-slate-200 bg-white text-ink-secondary hover:bg-surface hover:text-ink-primary'}`}
              >
                <Icon className="w-4 h-4" />
                {s.label}
                <span className={`min-w-[1.5rem] rounded-full px-1.5 text-xs tabular-nums ${count ? 'bg-getmeds-blue text-white' : 'bg-slate-100 text-ink-secondary'}`}>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
          <div className="px-4 py-3 border-b border-slate-200 bg-surface">
            <h2 className="text-sm font-semibold text-ink-primary">{current.label} ({total.toLocaleString()})</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{current.hint}</p>
          </div>
          {toolbar}
          {isLoading ? spinner : rows.length === 0 ? (
            <div className="text-center py-12 text-ink-secondary">
              <CheckCircle className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
              <p className="text-sm">{search ? `Nothing at this step matches "${search}"` : 'Nothing at this step'}</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((order) => (
                <li key={order.id} className="p-4 space-y-3">
                  {orderSummary(order)}
                  {order.status === 'completed' && (
                    <p className="text-xs text-ink-secondary">Shipped and paid — the order is complete; only the delivery is left to record.</p>
                  )}
                  {deliveryActions(order)}
                  <div>{actionFor(order)}</div>
                </li>
              ))}
            </ul>
          )}
          {pager}
        </div>

        <div className="flex items-start gap-2 text-xs text-ink-secondary bg-surface border border-slate-200 rounded-lg p-3">
          <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <p>Each button updates Zoho for you — there is no need to repeat the step in Zoho Inventory. If someone
            already did a step in Zoho, the button records what they made instead of making a second one.
            Payments are still recorded by Finance in Zoho Books.</p>
        </div>
      </div>
    );
  }

  // ─── Switch off: the read-only mirror of Zoho ───────────────────────────
  // Picking, packing, dispatch and tracking status come FROM Zoho:
  //   1. Order reaches "Ready for Dispatch" -> Pharmacy picks & packs it and
  //      creates a Package in Zoho Inventory ("picking_packing" below).
  //   2. Pharmacy creates a Shipment in Zoho Inventory with courier + tracking
  //      number -> order becomes "dispatched" and, once tracking is present,
  //      auto-completes.
  // Each of those Zoho-side actions calls back to this app's webhook and
  // updates the order automatically — this view just shows where things stand.
  // Sep 24, 2026: the "Awaiting Dispatch Action in Zoho" list that used to sit
  // under the two panels — every order waiting on a Package or Shipment, 5,000+
  // rows, mostly Zoho-imported history, with its own search box, origin and
  // owner filters, a pager and a footnote — was removed at the product owner's
  // request to clean up the page. What's left is the two panels above, which
  // are the actionable part: new draft Sales Orders, and orders Finance has
  // confirmed and Dispatch now has to deliver.
  return (
    <div className="space-y-6">
      {header}
      {recentAndDialog}
    </div>
  );
};

export default DispatchQueuePage;
