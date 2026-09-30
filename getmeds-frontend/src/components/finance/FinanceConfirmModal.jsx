import React, { useState } from 'react';
import { ShieldCheck, X, AlertCircle } from 'lucide-react';

/**
 * Modal that gates the Finance confirmation action behind a required checkbox.
 * Called from FinanceQueuePage when the user clicks "Confirm payment…" in the
 * details drawer — the drawer itself never confirms, it only opens this.
 *
 * Props:
 *   order      — the order row object from the queue
 *   confirming — boolean, true while the API call is in flight
 *   onClose    — called when the user dismisses without confirming
 *   onConfirm  — called (no args) when the user checks the box and confirms
 *   workflowV2 — boolean; when true Dispatch invoices next
 */
const FinanceConfirmModal = ({ order, confirming, onClose, onConfirm, workflowV2 }) => {
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState('');

  if (!order) return null;

  const peso = (n) =>
    `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <>
      {/* Backdrop — on top of the side drawer */}
      <div
        className="fixed inset-0 z-[60] bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        className="fixed z-[70] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="w-5 h-5 text-pharmacy-green shrink-0" />
            <h2 id="confirm-modal-title" className="text-base font-semibold text-ink-primary truncate">
              Confirm payment
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Order summary */}
          <div className="bg-surface border border-slate-200 rounded-lg px-4 py-3 text-sm">
            <p className="font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</p>
            <p className="text-ink-primary mt-0.5">{order.customer_name}</p>
            <p className="text-lg font-bold text-ink-primary mt-1">{peso(order.total_amount)}</p>
          </div>

          {/* What happens */}
          <div className="flex items-start gap-2 text-xs text-ink-secondary bg-getmeds-blue/5 border border-getmeds-blue/20 rounded-lg px-3 py-2.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-getmeds-blue" />
            <p>
              {workflowV2
                ? 'This confirms the customer\'s account and moves the Sales Order in Zoho from Draft to Confirmed. Dispatch invoices it next.'
                : 'This confirms the customer\'s account and moves the Sales Order in Zoho from Draft to Confirmed, releasing it to be invoiced.'}
            </p>
          </div>

          {/* Required checkbox */}
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-slate-300 text-pharmacy-green focus:ring-pharmacy-green"
            />
            <span className="text-sm text-ink-primary">
              I have checked the proof of payment (or confirmed there is none on file).
            </span>
          </label>

          {/* Optional note */}
          <div>
            <label className="block text-xs font-semibold text-ink-secondary mb-1">
              Note <span className="font-normal">(optional)</span>
            </label>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Any remarks about this confirmation…"
              className="w-full text-sm rounded-md border border-slate-200 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-pharmacy-green resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-surface flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="px-4 py-2 rounded-md border border-slate-200 text-sm font-semibold text-ink-secondary hover:bg-white hover:text-ink-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note.trim() || null)}
            disabled={!checked || confirming}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-pharmacy-green text-white text-sm font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {confirming ? (
              <>
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Confirming…
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                Confirm order
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
};

export default FinanceConfirmModal;
