import React from 'react';
import { Pill } from 'lucide-react';

/**
 * Sep 25, 2026: what is holding a prescription order up, on the Dispatch board.
 *
 * The wording comes from the server (services/prescriptionService.js's rxBadge)
 * so this page, the Pharmacy queue and the tests all say the same thing; this
 * only colours it. Orders with no prescription send nothing and render nothing.
 *
 *   ok     Rx verified and Finance confirmed: clear to dispatch
 *   wait   one of the two is still pending, and it is not Dispatch's to fix yet
 *   block  Finance is done but the prescription is not: this is what is holding
 *          the order, and Confirm / Add tracking are switched off
 */
const TONES = {
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  wait: 'border-amber-300 bg-amber-50 text-amber-900',
  block: 'border-red-300 bg-red-50 text-red-900',
};

const RxBadge = ({ badge }) => {
  if (!badge) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${TONES[badge.tone] || TONES.wait}`}
      title="Prescription status"
    >
      <Pill className="w-3.5 h-3.5 shrink-0" />
      {badge.label}
    </span>
  );
};

export default RxBadge;
