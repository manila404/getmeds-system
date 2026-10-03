import React, { useState } from 'react';
import { Loader2, X, Ban } from 'lucide-react';

/**
 * Management / Admin cancel a DRAFT order. Oct 3, 2026.
 *
 * The reason is required: the MedRep sees it on the cancelled order. A cancelled
 * draft disappears from Finance and Management lists and counts, stays visible to
 * the MedRep as Cancelled, and is removed automatically 3 days later.
 */
const CancelDraftModal = ({ order, onClose, onConfirm, saving }) => {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-16">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary">Cancel this draft?</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="text-ink-secondary hover:text-ink-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-[13px] text-ink-secondary">
            It will no longer count in Finance or Management totals. The MedRep still sees it as <strong>Cancelled</strong> with
            your reason, and can copy it to make a new order. It is removed automatically <strong>3 days</strong> after you cancel it.
          </p>
          <div>
            <label htmlFor="cancel-reason" className="block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">
              Reason (required)
            </label>
            <textarea
              id="cancel-reason"
              autoFocus
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Duplicate of GM-20261003-0001"
              className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">
            Keep draft
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={!ok || saving}
            className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
            {saving ? 'Cancelling…' : 'Cancel draft'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CancelDraftModal;
