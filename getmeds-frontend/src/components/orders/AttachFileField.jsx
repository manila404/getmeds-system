import React, { useRef } from 'react';
import { Paperclip, X } from 'lucide-react';
import { ATTACHMENT_TYPES } from '../../constants/attachmentTypes';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_ACCEPT } from '../../utils/attachmentUpload';
import { onPasteImage } from '../../hooks/usePasteImage';

/**
 * Sep 18, 2026: pick a file (and what it is — Proof of Payment, GL,
 * Prescription, Valid ID, Other) to go along with a resubmit — so the
 * MedRep doesn't have to leave the dialog and go find the Attachments tab.
 * Doesn't upload anything itself; the caller does that (with the reason)
 * when the form is submitted.
 */
const AttachFileField = ({ file, fileType, onFileChange, onTypeChange, disabled, label = 'Attach a file (optional)' }) => {
  const inputRef = useRef(null);

  const acceptFile = (f) => {
    if (!f || disabled) return;
    if (f.size > ATTACHMENT_MAX_BYTES) {
      onFileChange(null, `That file is too large — the limit is ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    onFileChange(f);
  };
  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    acceptFile(f);
  };
  // Sep 18, 2026: click the button, then paste (Ctrl+V) a copied image —
  // scoped to this button's own focus (usePasteImage.js's header note), not
  // the whole window, since a resubmit dialog can be open on top of the
  // Payment tab's own upload panel at the same time.
  const handlePaste = onPasteImage(acceptFile);

  return (
    <div>
      <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">{label}</span>
      {file ? (
        <div className="flex items-center gap-2 border border-slate-300 rounded px-2.5 py-2 bg-surface">
          <Paperclip className="w-3.5 h-3.5 text-ink-secondary shrink-0" />
          <span className="text-sm text-ink-primary truncate flex-1">{file.name}</span>
          <button
            type="button"
            onClick={() => onFileChange(null)}
            disabled={disabled}
            className="text-ink-secondary hover:text-red-700 disabled:opacity-50"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={fileType}
            onChange={(e) => onTypeChange(e.target.value)}
            disabled={disabled}
            className="text-sm border border-slate-300 rounded px-2 py-1.5 bg-white text-ink-primary disabled:opacity-50"
          >
            {ATTACHMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <input ref={inputRef} type="file" accept={ATTACHMENT_ACCEPT} onChange={pick} className="hidden" disabled={disabled} />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onPaste={handlePaste}
            disabled={disabled}
            title="Choose a file, or click here then paste a copied image with Ctrl+V"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-300 bg-white text-ink-secondary text-xs font-semibold hover:bg-surface disabled:opacity-50"
          >
            <Paperclip className="w-3.5 h-3.5" /> Choose file
          </button>
        </div>
      )}
    </div>
  );
};

export default AttachFileField;
