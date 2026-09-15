import React, { useState } from 'react';
import Modal from '../ui/Modal';

/**
 * Sep 15, 2026: put an order's tracking number on hold, with the reason.
 *
 * Confirmed for delivery, but the number is not there yet. The reason is
 * recorded on the order's timeline and the MedRep is told, so nobody chases a
 * tracking number that does not exist yet. Nothing changes in Zoho.
 */

export const TRACKING_HOLD_REASONS = [
  'Waiting for waybill',
  'Waiting for courier pickup',
  'Courier not yet assigned'
];
const OTHER = '__other__';

const HoldTrackingModal = ({ order, onClose, onSave, saving }) => {
  const [choice, setChoice] = useState(TRACKING_HOLD_REASONS[0]);
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const reason = choice === OTHER ? other.trim() : choice;

  return (
    <Modal isOpen onClose={onClose} title={`Hold tracking number — ${order.getmeds_order_id}`}>
      <p className="text-[13px] text-ink-secondary mb-3">
        The delivery is confirmed, but the tracking number is not ready. The MedRep is told why, and it shows on the
        order's timeline. Lift the hold with <strong>Tracking ready</strong>; it also lifts by itself once the order has a
        tracking number.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Reason</legend>
        {TRACKING_HOLD_REASONS.map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm text-ink-primary">
            <input type="radio" name="hold-reason" checked={choice === r} onChange={() => setChoice(r)} />
            {r}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm text-ink-primary">
          <input type="radio" name="hold-reason" checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
          Other
        </label>
        {choice === OTHER && (
          <input
            autoFocus
            value={other}
            onChange={(e) => setOther(e.target.value)}
            maxLength={200}
            placeholder="Type the reason"
            className="ml-6 w-[calc(100%-1.5rem)] border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
          />
        )}
      </fieldset>

      <label className="block mt-3">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Note (optional)</span>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="e.g. LBC said the waybill comes tomorrow morning"
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
        />
      </label>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !reason}
          onClick={() => onSave({ reason, note: note.trim() })}
          className="px-3 py-1.5 text-sm font-semibold bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Put tracking on hold'}
        </button>
      </div>
    </Modal>
  );
};

export default HoldTrackingModal;
