import React, { useState } from 'react';
import { Loader2, X, Hourglass } from 'lucide-react';

/**
 * Management / Admin put a draft on hold because an item is out of stock. Oct 12, 2026.
 *
 * The alternative to cancelling: nothing is cancelled and no refund starts, the payment stays on
 * record, and the order carries on when the stock is back ("Stock is back" on the order, for the
 * MedRep as well). A reminder goes out every 3 days.
 */
const StockHoldModal = ({ order, onClose, onConfirm, saving }) => {
  const [reason, setReason] = useState('');
  const [item, setItem] = useState('');
  const ready = reason.trim().length > 0 && !saving;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-16">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary flex items-center gap-2"><Hourglass className="w-4 h-4 text-amber-600" />Wait for stock?</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="text-ink-secondary hover:text-ink-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 text-[13px]">
          <p className="text-ink-secondary">
            The order is <strong className="text-ink-primary">not cancelled</strong> and no refund starts. It stays a draft with its payment on
            record, marked <em>Waiting for stock</em>. The MedRep is told, and you are reminded every 3 days. When the stock is back,
            press <strong className="text-ink-primary">Stock is back</strong> to send it for approval.
          </p>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">Item out of stock (optional)</span>
            <input
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
              maxLength={200}
              placeholder="e.g. HYDROXYGET"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">Reason</span>
            <textarea
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
              rows={3}
              maxLength={500}
              placeholder="e.g. Out of stock until the next delivery"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={saving}
              autoFocus
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 bg-white text-sm font-medium text-ink-secondary">
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => onConfirm(reason.trim(), item.trim())}
            className="px-4 py-2 rounded-md bg-amber-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Hourglass className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Wait for stock'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default StockHoldModal;
