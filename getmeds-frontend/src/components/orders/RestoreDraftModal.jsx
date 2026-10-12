import React, { useState } from 'react';
import { Loader2, X, RotateCcw, AlertTriangle } from 'lucide-react';

/**
 * Management / Admin bring back a cancelled draft. Oct 12, 2026.
 *
 * The order goes straight back to Management approval (not to the MedRep's drafts): it was
 * already reviewed, and the case this exists for is "cancelled for lack of stock, stock is back".
 * A pending refund is closed and Finance is told. If the refund was already paid out the server
 * refuses, and this dialog says so up front rather than after the click.
 */
const RestoreDraftModal = ({ order, onClose, onConfirm, saving }) => {
  const [reason, setReason] = useState('');
  const refundPaid = order.refund_status === 'done';
  const refundPending = order.refund_status === 'pending';
  const ready = reason.trim().length > 0 && !refundPaid && !saving;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-16">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary flex items-center gap-2"><RotateCcw className="w-4 h-4 text-getmeds-blue" />Restore this order?</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="text-ink-secondary hover:text-ink-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 text-[13px]">
          {refundPaid ? (
            <div className="flex gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-red-900">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                <strong>This order cannot be restored.</strong>{' '}
                ₱{Number(order.refund_amount || 0).toLocaleString('en-PH')} was already refunded
                {order.refund_reference ? ` (ref ${order.refund_reference})` : ''}, so the customer has to pay again. Raise a new order instead.
              </span>
            </div>
          ) : (
            <>
              <p className="text-ink-secondary">
                The order goes back to <strong className="text-ink-primary">Management approval</strong> with its items, customer and payment
                proof as they were. Nothing is lost, and the cancellation stays on the timeline.
              </p>
              {refundPending && (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                  A refund is pending for this order. Restoring it <strong>closes that refund</strong> and tells Finance not to pay it out.
                </p>
              )}
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">Why is it being restored?</span>
                <textarea
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                  rows={3}
                  maxLength={500}
                  placeholder="e.g. Stock is available again"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
              </label>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 bg-white text-sm font-medium text-ink-secondary">
            {refundPaid ? 'Close' : 'Cancel'}
          </button>
          {!refundPaid && (
            <button
              type="button"
              disabled={!ready}
              onClick={() => onConfirm(reason.trim())}
              className="px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              {saving ? 'Restoring…' : 'Restore for approval'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default RestoreDraftModal;
