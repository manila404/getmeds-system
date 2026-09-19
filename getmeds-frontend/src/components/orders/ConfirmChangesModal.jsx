import React from 'react';

/**
 * Sep 19, 2026: "when i clicked, it gone" — a scare over the Salesperson
 * picker's own UX (fixed separately in ZohoSalespersonCombo) surfaced a
 * real gap: Save Changes on Order Details/Items wrote straight through with
 * no review step, on an order that may already be a real Zoho Sales Order.
 * This is that review step — a plain list of field-by-field changes, shown
 * before the request goes out, for both Details and Items saves.
 */
const ConfirmChangesModal = ({ title, warning, changes, onCancel, onConfirm, confirming }) => (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
    <div className="bg-white rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4 border border-slate-200">
      <div className="pb-3 border-b border-slate-100">
        <h3 className="text-lg font-bold text-ink-primary">Confirm changes</h3>
        <p className="text-xs text-ink-secondary">{title}</p>
      </div>

      {warning && (
        <p className="rounded-md bg-state-warning-light border border-state-warning/30 px-3 py-2 text-xs text-amber-950">
          {warning}
        </p>
      )}

      <div className="max-h-80 overflow-y-auto thin-scroll divide-y divide-slate-100 border border-slate-200 rounded-lg">
        {changes.map((c, i) => (
          <div key={i} className="px-3 py-2">
            <p className="text-xs font-semibold text-ink-primary">{c.label}</p>
            <div className="flex items-start gap-2 mt-0.5 text-[12px]">
              <span className="flex-1 min-w-0 text-red-700 line-through break-words">{c.before || '—'}</span>
              <span className="text-ink-secondary shrink-0">→</span>
              <span className="flex-1 min-w-0 text-pharmacy-green-dark font-medium break-words">{c.after || '—'}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="px-4 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="px-5 py-2 bg-getmeds-blue text-white rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {confirming ? 'Saving…' : 'Confirm & Save'}
        </button>
      </div>
    </div>
  </div>
);

export default ConfirmChangesModal;
