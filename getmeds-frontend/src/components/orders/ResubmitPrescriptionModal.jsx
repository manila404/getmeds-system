import React, { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import AttachFileField from './AttachFileField';

/**
 * Sep 26, 2026: answer Pharmacy's rejection of the prescription.
 *
 * Goes to PHARMACY only. Finance's confirmation is not reset and Finance is not
 * told: Pharmacy and Finance are separate tracks (a Finance hold has its own
 * "Re-submit to Finance"). A replacement file is optional; the note is required and
 * is what the pharmacist reads next to the prescription.
 */
const ResubmitPrescriptionModal = ({ order, onClose, onSubmit, saving }) => {
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const rejection = order.rx?.rejection;

  return (
    <Modal isOpen onClose={onClose} title={`Re-submit the prescription for ${order.getmeds_order_id}`}>
      {rejection && (
        <p className="text-[13px] text-red-900 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
          <span className="font-semibold">Pharmacy rejected it:</span> {rejection.reason || 'No reason given.'}
        </p>
      )}
      <p className="text-[13px] text-ink-secondary mb-3">
        This goes back to Pharmacy for review. It does not change anything with Finance.
      </p>

      <label className="block">
        <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">What has changed</span>
        <textarea
          autoFocus
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={490}
          placeholder="e.g. New prescription with the quantity attached"
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
        />
      </label>

      <div className="mt-3">
        <AttachFileField
          file={file}
          fileType="prescription"
          hideType
          onFileChange={(f, error) => { if (error) toast.error(error); else setFile(f); }}
          onTypeChange={() => {}}
          disabled={saving}
          label="Replacement prescription (optional)"
        />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !note.trim()}
          onClick={() => onSubmit({ note: note.trim(), file })}
          className="px-3 py-1.5 text-sm font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
        >
          {saving ? 'Sending…' : 'Re-submit to Pharmacy'}
        </button>
      </div>
    </Modal>
  );
};

export default ResubmitPrescriptionModal;
