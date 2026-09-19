import React, { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import AttachFileField from './AttachFileField';
import { stageLabel } from './ResumeOrderModal';

/**
 * Sep 15, 2026: send an order Finance put on hold back to Finance, saying why.
 *
 * The reason is picked or typed, and goes on the order's timeline and into
 * Finance's notification — so Finance reads "Proof of payment uploaded"
 * rather than having to work out what changed.
 *
 * Sep 19, 2026: widened to a hold or exception Management put on too, not
 * only Finance's — orders.controller.js's resubmit() now resolves those back
 * to wherever the trail says the order was before the hold (same default
 * "Resume order" uses), which is not always Finance. `order.resume_to`
 * carries that destination when the backend already knows it, so the copy
 * here names it instead of assuming.
 */

export const RESUBMIT_REASONS = [
  'Proof of payment uploaded',
  'Customer has settled the overdue balance',
  'Missing document attached',
  'Order details corrected'
];
const OTHER = '__other__';

const ResubmitHoldModal = ({ order, onClose, onSubmit, saving }) => {
  const [choice, setChoice] = useState(RESUBMIT_REASONS[0]);
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState('payment_proof');
  const base = choice === OTHER ? other.trim() : choice;
  const reason = [base, note.trim()].filter(Boolean).join(' — ');

  const onFileChange = (f, error) => {
    if (error) { toast.error(error); return; }
    setFile(f);
  };

  // Sep 19, 2026: where this actually goes back to — Finance specifically
  // for a Finance hold, otherwise wherever the trail says the order was
  // before Management's hold/exception (order.resume_to, from
  // orders.controller.js's statusBeforeHold).
  const destination = order.resume_to ? stageLabel(order.resume_to) : 'Finance';

  return (
    <Modal isOpen onClose={onClose} title={`Re-submit ${order.getmeds_order_id} for verification`}>
      {order.exception_reason && (
        <p className="text-[13px] text-amber-950 bg-state-warning-light border border-state-warning/30 rounded px-3 py-2 mb-3">
          <span className="font-semibold">Held for:</span> {order.exception_reason}
        </p>
      )}
      <p className="text-[13px] text-ink-secondary mb-2">
        What has been done about it? {destination} sees this with the order, and it continues there.
      </p>

      <fieldset className="space-y-1.5">
        {RESUBMIT_REASONS.map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm text-ink-primary">
            <input type="radio" name="resubmit-reason" checked={choice === r} onChange={() => setChoice(r)} />
            {r}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm text-ink-primary">
          <input type="radio" name="resubmit-reason" checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
          Other (type the reason)
        </label>
        {choice === OTHER && (
          <input
            autoFocus
            value={other}
            onChange={(e) => setOther(e.target.value)}
            maxLength={300}
            placeholder="e.g. Payment received through GCash, reference 1234"
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
          maxLength={190}
          placeholder="Anything Finance should know"
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
        />
      </label>

      <div className="mt-3">
        <AttachFileField file={file} fileType={fileType} onFileChange={onFileChange} onTypeChange={setFileType} disabled={saving} />
        <p className="mt-1 text-[11px] text-ink-secondary">
          Whatever backs this up — the deposit slip, a corrected Guarantee Letter or Prescription, an ID. {destination} sees it with the order.
        </p>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !base}
          onClick={() => onSubmit({ reason, file, fileType })}
          className="px-3 py-1.5 text-sm font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
        >
          {saving ? 'Sending…' : `Re-submit to ${destination}`}
        </button>
      </div>
    </Modal>
  );
};

export default ResubmitHoldModal;
