import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle, Clock, RefreshCw, PackageCheck, Truck, ExternalLink, Receipt, MapPin } from 'lucide-react';
import client from '../../api/client';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import OrderDetailsModal from '../../components/finance/OrderDetailsModal';
import RecentDispatchPanel from '../../components/dispatch/RecentDispatchPanel';
import DeliveryActions, { CONFIRMABLE_STATUSES } from '../../components/dispatch/DeliveryActions';

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

const DispatchQueuePage = () => {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['dispatch-queue'],
    queryFn: () => client.get('/api/dispatch/queue').then(r => r.data),
    refetchInterval: 30000
  });
  const orders = data?.data?.orders || [];
  const workflowV2 = Boolean(data?.data?.workflow_v2);
  const stepStatuses = data?.data?.steps || {};

  const [stepKey, setStepKey] = useState('needs_invoice');
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
  const confirmDelivery = useMutation({
    mutationFn: (id) => client.post(`/api/dispatch/orders/${id}/confirm-delivery`).then((r) => r.data?.data),
    onSuccess: (res) => {
      toast.success(res.message);
      // The open receipt shows the new confirmation straight away.
      setViewing((v) => (v && v.id === res.id
        ? { ...v, delivery_confirmed_by: res.delivery_confirmed_by, delivery_confirmed_at: res.delivery_confirmed_at, delivery_address_changed: false }
        : v));
      qc.invalidateQueries({ queryKey: ['dispatch-queue'] });
      qc.invalidateQueries({ queryKey: ['dispatch-recent'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not confirm the delivery.', { duration: 8000 })
  });
  const confirmingId = confirmDelivery.isPending ? confirmDelivery.variables : null;
  const deliveryActions = (order) =>
    CONFIRMABLE_STATUSES.includes(order.status) || order.delivery_confirmed_at ? (
      <DeliveryActions order={order} onConfirm={setConfirmFor} busy={confirmingId === order.id} />
    ) : null;

  const recentAndDialog = (
    <>
      <RecentDispatchPanel onConfirm={setConfirmFor} confirmingId={confirmingId} onOpen={setViewing} />
      {/* Before the ConfirmDialog, so that dialog opens on top of it. */}
      {viewing && (
        <OrderDetailsModal
          orderId={viewing.id}
          onClose={() => setViewing(null)}
          footer={<DeliveryActions order={viewing} onConfirm={setConfirmFor} busy={confirmingId === viewing.id} />}
        />
      )}
      <ConfirmDialog
        isOpen={!!confirmFor}
        onClose={() => setConfirmFor(null)}
        onConfirm={() => confirmFor && confirmDelivery.mutate(confirmFor.id)}
        title={`Confirm ${confirmFor?.getmeds_order_id || ''} for delivery?`}
        message={
          confirmFor
            ? `Deliver to ${confirmFor.customer_name}: ${confirmFor.delivery_address || '(no address)'}` +
              (confirmFor.intake_receiver ? ` — receiver ${confirmFor.intake_receiver}` : '') +
              (confirmFor.intake_contact_no || confirmFor.contact_number ? `, ${confirmFor.intake_contact_no || confirmFor.contact_number}` : '') +
              '. Check this against the printed slip first. This records your confirmation; it does not change the order or Zoho.'
            : ''
        }
        confirmText="Confirm for delivery"
        variant="info"
      />
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
        <p className="text-sm text-ink-primary mt-0.5 font-medium truncate">{order.customer_name}</p>
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
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold text-ink-primary">{peso(order.total_amount)}</p>
        <p className="text-xs text-ink-secondary font-medium mt-0.5">Waiting {waitingHours(order)}</p>
      </div>
    </div>
  );

  // ─── Switch on: Dispatch works here ─────────────────────────────────────
  if (workflowV2) {
    const inStep = (key) => orders.filter((o) => (stepStatuses[key] || []).includes(o.status));
    const current = STEPS.find((s) => s.key === stepKey) || STEPS[0];
    const rows = inStep(current.key);
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
            const count = inStep(s.key).length;
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
            <h2 className="text-sm font-semibold text-ink-primary">{current.label} ({rows.length})</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{current.hint}</p>
          </div>
          {isLoading ? spinner : rows.length === 0 ? (
            <div className="text-center py-12 text-ink-secondary">
              <CheckCircle className="w-10 h-10 mx-auto mb-2 text-pharmacy-green" />
              <p className="text-sm">Nothing at this step</p>
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
      {header}
      {recentAndDialog}

      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-center gap-2">
          <Clock className="w-4 h-4 text-state-warning" />
          <h2 className="text-sm font-semibold text-ink-primary">Awaiting Dispatch Action in Zoho ({orders.length})</h2>
        </div>

        {isLoading ? spinner : orders.length === 0 ? (
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
                  {orderSummary(order)}
                  <div className="mt-2">{deliveryActions(order)}</div>
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
