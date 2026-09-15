import React, { useState } from 'react';
import Modal from '../ui/Modal';
import { TRACKING_HOLD_REASONS } from './HoldTrackingModal';

/**
 * Sep 15, 2026: confirm an order for delivery, and in the same step say where
 * the tracking number stands — added now, or not ready yet (with the reason,
 * e.g. "Waiting for waybill").
 *
 *   mode 'confirm'   the address check, then the tracking choice. The choice
 *                    is skipped when the order already has a tracking number
 *                    or a hold (re-confirming after an address change).
 *   mode 'tracking'  just the tracking number, for an order confirmed earlier
 *                    whose number has now arrived.
 *
 * Record-only, like everything on this page: the tracking number is saved on
 * the order and sent to the MedRep; nothing changes in Zoho.
 */

const OTHER = '__other__';
const inputClass =
  'w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue';

const DeliveryConfirmModal = ({ order, mode = 'confirm', onClose, onSubmit, saving }) => {
  const hasTracking = Boolean(order.tracking_number || order.entered_tracking || order.tracking_hold);
  const askTracking = mode === 'tracking' || !hasTracking;
  const [choice, setChoice] = useState('add'); // 'add' | 'hold'
  // Updating (Sep 15, 2026): starts from the number Dispatch entered before.
  const entered = mode === 'tracking' ? order.entered_tracking : null;
  const [courier, setCourier] = useState(entered?.courier || order.courier || order.intake_delivery_method || '');
  const [trackingNumber, setTrackingNumber] = useState(entered?.tracking_number || '');
  const [reason, setReason] = useState(TRACKING_HOLD_REASONS[0]);
  const [otherReason, setOtherReason] = useState('');
  const [note, setNote] = useState('');

  const holdReason = reason === OTHER ? otherReason.trim() : reason;
  const adding = mode === 'tracking' || choice === 'add';
  const ready = !askTracking || (adding ? courier.trim() && trackingNumber.trim() : holdReason);
  const contact = order.intake_contact_no || order.contact_number;

  const submit = () => {
    if (!ready) return;
    if (!askTracking) return onSubmit({});
    if (adding) return onSubmit({ tracking: { courier: courier.trim(), tracking_number: trackingNumber.trim() } });
    return onSubmit({ hold: { reason: holdReason, note: note.trim() } });
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={
        mode === 'tracking'
          ? `${entered ? 'Update' : 'Add'} tracking number — ${order.getmeds_order_id}`
          : `Confirm ${order.getmeds_order_id} for delivery?`
      }
    >
      {mode === 'confirm' && (
        <div className="rounded-lg border border-slate-200 bg-surface px-3 py-2.5 text-sm">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary">Deliver to</p>
          <p className="font-semibold text-ink-primary">{order.customer_name}</p>
          <p className="text-ink-primary">{order.delivery_address || <span className="text-red-700">No delivery address</span>}</p>
          {(order.intake_receiver || contact) && (
            <p className="text-ink-secondary text-[13px] mt-0.5">
              {order.intake_receiver && <>Receiver: {order.intake_receiver}</>}
              {order.intake_receiver && contact && ' · '}
              {contact}
            </p>
          )}
          <p className="text-[12px] text-ink-secondary mt-1.5">Check this against the printed slip first.</p>
        </div>
      )}

      {askTracking && (
        <div className="mt-3">
          {mode === 'confirm' && (
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1.5">Tracking number</p>
          )}
          {mode === 'confirm' && (
            <label className="flex items-center gap-2 text-sm text-ink-primary">
              <input type="radio" name="tracking-choice" checked={choice === 'add'} onChange={() => setChoice('add')} />
              Add it now
            </label>
          )}
          {adding && (
            <div className={`grid grid-cols-2 gap-2 ${mode === 'confirm' ? 'ml-6 mt-1.5 mb-2' : ''}`}>
              <label className="text-[11px] font-semibold text-ink-secondary">
                Courier
                <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="e.g. LBC Express" maxLength={100} className={`mt-0.5 ${inputClass}`} />
              </label>
              <label className="text-[11px] font-semibold text-ink-secondary">
                Tracking number
                <input
                  autoFocus
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  maxLength={100}
                  className={`mt-0.5 font-mono ${inputClass}`}
                />
              </label>
            </div>
          )}

          {mode === 'confirm' && (
            <label className="flex items-center gap-2 text-sm text-ink-primary">
              <input type="radio" name="tracking-choice" checked={choice === 'hold'} onChange={() => setChoice('hold')} />
              Not ready yet
            </label>
          )}
          {mode === 'confirm' && choice === 'hold' && (
            <div className="ml-6 mt-1.5 space-y-2">
              <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass}>
                {TRACKING_HOLD_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                <option value={OTHER}>Other…</option>
              </select>
              {reason === OTHER && (
                <input value={otherReason} onChange={(e) => setOtherReason(e.target.value)} maxLength={200} placeholder="Type the reason" className={inputClass} />
              )}
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional), e.g. LBC says tomorrow" className={inputClass} />
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[12px] text-ink-secondary">
        {mode === 'tracking'
          ? 'Saved on the order and sent to the MedRep. The shipment in Zoho is still made in Zoho.'
          : 'This records your confirmation and tells the MedRep about the tracking. It does not change the order or Zoho.'}
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !ready}
          onClick={submit}
          className="px-3 py-1.5 text-sm font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
        >
          {saving ? 'Saving…' : mode === 'tracking' ? 'Save tracking number' : 'Confirm for delivery'}
        </button>
      </div>
    </Modal>
  );
};

export default DeliveryConfirmModal;
