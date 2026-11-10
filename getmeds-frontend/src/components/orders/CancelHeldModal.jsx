import React, { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import client from '../../api/client';

export const CANCEL_HELD_REASONS = [
  'Customer backed out / decided not to proceed',
  'Unable to secure required payment / terms refusal',
  'Prescription / Guarantee Letter cannot be provided',
  'Item unavailable / out of stock'
];
const OTHER = '__other__';

/**
 * Nov 10, 2026: MedRep / Team Lead / Management cancels and archives
 * an order currently on hold or in exception when it cannot proceed.
 */
const CancelHeldModal = ({ order, onClose, onSuccess }) => {
  const [choice, setChoice] = useState(CANCEL_HELD_REASONS[0]);
  const [otherReason, setOtherReason] = useState('');
  const [notes, setNotes] = useState('');
  const [needsRefund, setNeedsRefund] = useState(false);
  const [saving, setSaving] = useState(false);

  const baseReason = choice === OTHER ? otherReason.trim() : choice;
  const finalReason = [baseReason, notes.trim()].filter(Boolean).join(' — ');

  const handleCancelHeld = async (e) => {
    e.preventDefault();
    if (!baseReason) {
      toast.error('Please specify the reason for cancellation.');
      return;
    }

    setSaving(true);
    try {
      const res = await client.post(`/api/orders/${order.id}/cancel-held`, {
        reason: finalReason,
        needs_refund: needsRefund
      });

      toast.success(res.data?.data?.message || `Order ${order.getmeds_order_id} cancelled & archived.`);
      if (onSuccess) onSuccess(res.data);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Could not cancel this order');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Cancel & Archive ${order.getmeds_order_id}`}>
      <form onSubmit={handleCancelHeld} className="space-y-4">
        {order.exception_reason && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950">
            <strong className="block font-semibold">Current Hold Reason:</strong>
            <span>{order.exception_reason}</span>
          </div>
        )}

        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-900 flex items-start gap-2.5">
          <span className="text-base">⚠️</span>
          <div>
            <strong className="block font-semibold">Cancel & Archive Order</strong>
            <span>If this order cannot proceed, archiving it moves it to <strong>Cancelled</strong>, stops it from blocking active team queues, and preserves the audit record.</span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1.5">
            Reason for Cancellation *
          </label>
          <div className="space-y-2">
            {CANCEL_HELD_REASONS.map((r) => (
              <label
                key={r}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                  choice === r ? 'border-red-400 bg-red-50/60 font-medium text-red-950' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="cancel-held-reason"
                  checked={choice === r}
                  onChange={() => setChoice(r)}
                  className="mt-0.5 text-red-600 focus:ring-red-500"
                />
                <span>{r}</span>
              </label>
            ))}
            <label
              className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                choice === OTHER ? 'border-red-400 bg-red-50/60 font-medium text-red-950' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
              }`}
            >
              <input
                type="radio"
                name="cancel-held-reason"
                checked={choice === OTHER}
                onChange={() => setChoice(OTHER)}
                className="mt-0.5 text-red-600 focus:ring-red-500"
              />
              <span>Other (type reason)</span>
            </label>
            {choice === OTHER && (
              <input
                autoFocus
                required
                value={otherReason}
                onChange={(e) => setOtherReason(e.target.value)}
                maxLength={300}
                placeholder="e.g. Customer deferred treatment to next year"
                className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 mt-1"
              />
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1.5">
            Is a refund required? *
          </label>
          <div className="space-y-2">
            <label
              className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                !needsRefund
                  ? 'border-emerald-500 bg-emerald-50/70 font-medium text-emerald-950 ring-1 ring-emerald-500'
                  : 'border-slate-200 hover:bg-slate-50 text-slate-700'
              }`}
            >
              <input
                type="radio"
                name="cancel-held-needs-refund"
                checked={!needsRefund}
                onChange={() => setNeedsRefund(false)}
                className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
              />
              <div>
                <span className="font-semibold block text-slate-900">No refund needed</span>
                <span className="text-[11px] text-slate-500 block mt-0.5">
                  No money was collected, transaction was voided, or customer backed out before paying. Finance will not be tasked with a refund.
                </span>
              </div>
            </label>

            <label
              className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                needsRefund
                  ? 'border-amber-500 bg-amber-50/70 font-medium text-amber-950 ring-1 ring-amber-500'
                  : 'border-slate-200 hover:bg-slate-50 text-slate-700'
              }`}
            >
              <input
                type="radio"
                name="cancel-held-needs-refund"
                checked={needsRefund}
                onChange={() => setNeedsRefund(true)}
                className="mt-0.5 text-amber-600 focus:ring-amber-500"
              />
              <div>
                <span className="font-semibold block text-slate-900">Yes, refund is required</span>
                <span className="text-[11px] text-slate-500 block mt-0.5">
                  Customer already paid money that must be returned. Finance will be alerted to arrange and process the refund.
                </span>
              </div>
            </label>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded"
          >
            Keep on Hold
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-xs font-semibold bg-red-600 text-white rounded hover:bg-red-700 flex items-center gap-1.5 disabled:opacity-50"
          >
            <span>🚫</span> {saving ? 'Cancelling…' : 'Confirm Cancel & Archive'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default CancelHeldModal;
