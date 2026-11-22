import React from 'react';
import { ArrowRight, CheckCircle2, ClipboardCheck, FileCheck2, Truck } from 'lucide-react';
import { normalizeEntityKey } from '../../utils/printSalesOrder';

/**
 * Derive clear, action-oriented label & visual state for the automated
 * Zoho/DR/Invoice/Ship workflow button instead of a generic "Fulfill" label.
 */
export function getFulfillButtonMeta(order = {}) {
  const splits = Array.isArray(order.splits) ? order.splits : [];
  const primaryInvoiced = Boolean(order.zoho_invoice_number || order.zoho_invoice_id);
  const primaryShipped = Boolean(order.zoho_shipment_id || order.zoho_shipment_number);

  const allInvoiced = primaryInvoiced && splits.every((s) => Boolean(s.zoho_invoice_number || s.zoho_invoice_id));
  const allShipped = primaryShipped && splits.every((s) => Boolean(s.zoho_shipment_id || s.zoho_shipment_number));

  const requiresSi = order.classification?.requires_si ?? Boolean(order.requires_si);

  if (allShipped) {
    return {
      stage: 'shipped',
      label: 'Zoho Shipped',
      subtext: 'Edit tracking',
      title: 'Zoho Invoice, Package & Shipment completed — click to view DR or update Zoho tracking',
      icon: CheckCircle2
    };
  }

  if (allInvoiced) {
    return {
      stage: 'ready_to_ship',
      label: 'Package & Ship in Zoho',
      subtext: 'Next step',
      title: 'Invoice posted — click to create Zoho Package, Mode of Delivery & Shipment tracking',
      icon: Truck
    };
  }

  if (splits.length > 0 && (primaryInvoiced || splits.some((s) => Boolean(s.zoho_invoice_number || s.zoho_invoice_id)))) {
    const pendingKeys = [];
    const pKey = normalizeEntityKey(order.invoicing_from) || 'GPI';
    if (!primaryInvoiced) pendingKeys.push(pKey);
    for (const s of splits) {
      if (!s.zoho_invoice_number && !s.zoho_invoice_id) {
        pendingKeys.push(normalizeEntityKey(s.invoicing_from) || 'Split');
      }
    }
    return {
      stage: 'split_pending',
      label: `Finish ${pendingKeys.join(' & ')} · DR & Invoice`,
      subtext: 'Split SO',
      title: `Complete remaining entity workflow (${pendingKeys.join(', ')}) in Zoho & DR`,
      icon: FileCheck2
    };
  }

  if (requiresSi) {
    return {
      stage: 'start_dr_si',
      label: 'DR · Invoice & Ship',
      subtext: 'Automated',
      title: 'Start automated workflow: Pick Zoho Batches, Issue DR, Post Oojeema SI & Ship in Zoho',
      icon: FileCheck2
    };
  }

  return {
    stage: 'start_auto_inv',
    label: 'Batches · Invoice & Ship',
    subtext: 'Auto Zoho',
    title: 'Start automated workflow: Pick Zoho Batches, Create Zoho Auto-Invoice & Ship in Zoho',
    icon: ClipboardCheck
  };
}

/**
 * Primary action CTA for Dispatch's automated Batch -> DR -> Zoho Invoice -> Ship flow.
 * Designed to draw immediate eye focus as the main operational step while keeping
 * GetMeds' clean clinical/enterprise styling.
 */
const FulfillActionButton = ({ order, onClick, disabled = false, compact = false, fullWidth = false }) => {
  const meta = getFulfillButtonMeta(order);
  const Icon = meta.icon;
  const isCompleted = meta.stage === 'shipped';
  const isShipNext = meta.stage === 'ready_to_ship';

  if (isCompleted) {
    return (
      <button
        type="button"
        onClick={() => onClick?.(order)}
        disabled={disabled}
        title={meta.title}
        className={`group inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 font-semibold hover:bg-emerald-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
        } ${fullWidth ? 'w-full justify-between' : ''}`}
      >
        <span className="inline-flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
          <span>{meta.label}</span>
        </span>
        {!compact && <span className="text-[10px] font-medium text-emerald-700/90">View / Track</span>}
      </button>
    );
  }

  const toneClasses = isShipNext
    ? 'from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 shadow-teal-600/20'
    : 'from-getmeds-blue to-indigo-600 hover:from-getmeds-blue-dark hover:to-indigo-700 shadow-getmeds-blue/25';

  return (
    <button
      type="button"
      onClick={() => onClick?.(order)}
      disabled={disabled}
      title={meta.title}
      className={`group inline-flex items-center gap-2 rounded-lg bg-gradient-to-r ${toneClasses} text-white font-semibold shadow-sm ring-1 ring-inset ring-white/15 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed ${
        compact ? 'px-2.5 py-1.5 text-[11px]' : 'px-3.5 py-2 text-xs'
      } ${fullWidth ? 'w-full justify-between' : 'justify-center'}`}
    >
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-300 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-300" />
        </span>
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{meta.label}</span>
      </span>
      <span className="inline-flex items-center gap-1 shrink-0">
        {!compact && meta.subtext && (
          <span className="hidden sm:inline-block rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white/95">
            {meta.subtext}
          </span>
        )}
        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
};

export default FulfillActionButton;
