import React from 'react';

const statusStyles = {
  // Neutral / Draft (Slate)
  draft: 'bg-slate-100 text-slate-700 border border-slate-300',
  DRAFT: 'bg-slate-100 text-slate-700 border border-slate-300',

  // Pending / Warning (Amber)
  submitted: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  validating: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_pending: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  waiting_for_payment: 'bg-state-warning-light text-amber-950 border border-state-warning font-semibold',
  PENDING: 'bg-state-warning-light text-amber-900 border border-state-warning/30',

  // Invoice drafted in Zoho, payment not yet recorded (Indigo)
  invoice_drafted: 'bg-indigo-50 text-indigo-700 border border-indigo-300 font-semibold',

  // Brand Blue & Pharmacy Green
  so_created: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  payment_verified: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30 font-semibold',
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
