import React from 'react';

const statusStyles = {
  // Neutral / Draft (Slate)
  draft: 'bg-slate-100 text-slate-700 border border-slate-300',
  DRAFT: 'bg-slate-100 text-slate-700 border border-slate-300',

  // Pending / Warning (Amber)
  submitted: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  validating: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_pending: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  ready_for_draft_invoice: 'bg-state-warning-light text-amber-950 border border-state-warning font-semibold',
  PENDING: 'bg-state-warning-light text-amber-900 border border-state-warning/30',

  // Sep 1, 2026 (8): the account check that happens before any invoice is
  // raised. Deliberately the ONLY purple in the map — this is the one stage
  // that needs a human to click something in THIS app (every other stage is
  // reported by Zoho), so it should not blend into the amber/indigo run of
  // Finance stages that follow it.
  ready_for_finance_verified: 'bg-purple-50 text-purple-800 border border-purple-300 font-semibold',

  // The two Finance stages, named for what they're waiting FOR. Amber above
  // (raise the invoice) then indigo here (issue it) — a deliberate step in
  // brightness so the two are told apart at a glance in a queue rather than
  // reading as the same colour twice.
  ready_for_invoice_sent: 'bg-indigo-50 text-indigo-700 border border-indigo-300 font-semibold',

  // Brand Blue & Pharmacy Green
  so_created: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  // Invoice issued — the warehouse's queue. Brand blue, because this is the
  // hand-off out of Finance and into fulfilment.
  ready_for_dispatch: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  picking_packing: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  dispatched: 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40 font-semibold',
  tracking_shared: 'bg-teal-50 text-teal-800 border border-teal-200',
  completed: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/40 font-semibold',
  APPROVED: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/40 font-semibold',
  PACKED: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  SHIPPED: 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40 font-semibold',
  DELIVERED: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/40 font-semibold',

  // Exception / Error (Red)
  on_hold: 'bg-state-error-light text-red-800 border border-state-error/30 font-semibold',
  exception: 'bg-state-error-light text-red-950 border border-state-error font-bold',
  cancelled: 'bg-state-error-light text-red-700 border border-state-error/30',

  // Sales Order removed in Zoho — the record is gone there, which is a
  // stronger statement than "cancelled" (that one still exists, voided).
  // Deliberately slate rather than another red: it reads as struck-off /
  // no-longer-a-record instead of blending into the error states next to it,
  // which is the whole reason it stopped sharing 'cancelled'.
  deleted: 'bg-slate-200 text-slate-600 border border-slate-400 line-through',
  REJECTED: 'bg-state-error-light text-red-950 border border-state-error font-semibold',
};

const OrderStatusBadge = ({ status }) => {
  const normalizedKey = status ? String(status).toLowerCase() : '';
  const colorClass = statusStyles[status] || statusStyles[normalizedKey] || 'bg-slate-100 text-slate-700 border border-slate-200';
  const label = status ? String(status).replace(/_/g, ' ') : 'Unknown';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize tracking-wide transition-colors ${colorClass}`}>
      {label}
    </span>
  );
};

export default OrderStatusBadge;
