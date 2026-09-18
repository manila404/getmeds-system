import React from 'react';
import { Paperclip, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';

/**
 * Sep 18, 2026: a pause before a file actually uploads.
 *
 * Both places this is used upload the instant a file was picked, dropped, or
 * (now) pasted — no second look, no way back if it was the wrong screenshot.
 * That was fine while attaching was purely additive, but a proof-of-payment
 * upload also REOPENS a Finance hold the moment it lands (see
 * financeHoldService.js's "any attachment reopens a Finance hold" note) and a
 * dispatch proof pushes straight to the Zoho Sales Order and notifies the
 * MedRep — both real, hard-to-undo side effects from one accidental click, and
 * clipboard paste makes picking the wrong image easier, not harder (an old
 * screenshot sitting in the clipboard from something else entirely).
 */
const prettySize = (bytes) => {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const UploadConfirmModal = ({ files, title, asLabel, note, onCancel, onConfirm, confirming }) => (
  <Modal isOpen onClose={onCancel} title={title || 'Upload this file?'}>
    <div className="space-y-3">
      <div className="space-y-1.5">
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-slate-200 bg-surface px-2.5 py-2 text-sm">
            <Paperclip className="w-3.5 h-3.5 text-ink-secondary shrink-0" />
            <span className="text-ink-primary truncate flex-1">{f.name}</span>
            <span className="text-ink-secondary text-xs shrink-0">{prettySize(f.size)}</span>
          </div>
        ))}
      </div>

      {asLabel && (
        <p className="text-[13px] text-ink-secondary">
          Attaching as <span className="font-semibold text-ink-primary">{asLabel}</span>.
        </p>
      )}

      {note && (
        <p className="flex items-start gap-2 text-[12px] text-amber-950 bg-state-warning-light border border-state-warning/30 rounded px-2.5 py-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{note}</span>
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="px-3 py-1.5 text-sm font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
        >
          {confirming ? 'Uploading…' : `Upload ${files.length > 1 ? `${files.length} files` : ''}`.trim()}
        </button>
      </div>
    </div>
  </Modal>
);

export default UploadConfirmModal;
