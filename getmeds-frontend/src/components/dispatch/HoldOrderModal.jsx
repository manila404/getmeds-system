import React, { useState } from 'react';
import Modal from '../ui/Modal';

/**
 * Sep 15, 2026: Dispatch puts an order on hold, with the reason.
 *
 * A flag, not the On Hold status: the order stays where it is in Dispatch
 * (it can still be prepared), and the MedRep, whoever raised it and
 * Management are told so someone fixes it — usually the items, when one is
 * out of stock. Nothing changes in Zoho.
 */
const REASONS = [
  'Item out of stock — please update the items',
  'Not enough stock for the quantity — please update the items',
  'Wrong item or quantity — please check the order',
  'Delivery address or receiver needs checking'
];
const OTHER = '__other__';

const HoldOrderModal = ({ order, onClose, onSave, saving }) => {
  const [choice, setChoice] = useState(REASONS[0]);
  const [other, setOther] = useState('');
  const [detail, setDetail] = useState('');
  const base = choice === OTHER ? other.trim() : choice;
  const reason = [base, detail.trim()].filter(Boolean).join(' — ');
  const inputClass =
    'w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue';

  return (
    <Modal isOpen onClose={onClose} title={`Put ${order.getmeds_order_id} on hold`}>
      <p className="text-[13px] text-ink-secondary mb-3">
        The order stays in Dispatch — you can still prepare it. The MedRep and Management are told why, so the items or
        details get fixed. Lift the hold once it is sorted. Nothing changes in Zoho.
      </p>
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Reason</legend>
        {REASONS.map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm text-ink-primary">
            <input type="radio" name="hold-order-reason" checked={choice === r} onChange={() => setChoice(r)} />
            {r}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm text-ink-primary">
          <input type="radio" name="hold-order-reason" checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
          Other
        </label>
        {choice === OTHER && (
          <input autoFocus value={other} onChange={(e) => setOther(e.target.value)} maxLength={300} placeholder="Type the reason" className={`ml-6 w-[calc(100%-1.5rem)] ${inputClass}`} />
        )}
      </fieldset>
      <label className="block mt-3">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Which item / details (optional)</span>
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          maxLength={190}
          placeholder="e.g. PacliGet 260 — only 5 left; CarboGet 450 available instead"
          className={inputClass}
        />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !base}
          onClick={() => onSave(reason)}
          className="px-3 py-1.5 text-sm font-semibold bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Put on hold'}
        </button>
      </div>
    </Modal>
  );
};

export default HoldOrderModal;
