import React, { useEffect, useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';

/**
 * Screenshots Finance attaches when it holds an order. Oct 15, 2026.
 *
 * Typically the customer's overdue balance or credit in Zoho, so the MedRep can see WHY the order
 * was held. Paste with Ctrl+V anywhere while the hold form is open, or pick files. Images only,
 * up to MAX; the files are uploaded by the caller when the hold is confirmed.
 */
export const HOLD_PROOF_MAX = 5;
const MAX_BYTES = 10 * 1024 * 1024;

const HoldProofField = ({ files, onChange, disabled }) => {
  const inputRef = useRef(null);

  const add = (incoming) => {
    const room = HOLD_PROOF_MAX - files.length;
    const ok = incoming.filter((f) => f.type.startsWith('image/') && f.size <= MAX_BYTES).slice(0, Math.max(0, room));
    if (ok.length) onChange([...files, ...ok]);
  };

  // A screenshot pasted while the hold form is open.
  useEffect(() => {
    if (disabled) return undefined;
    const onPaste = (e) => {
      const items = Array.from(e.clipboardData?.items || []).filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (!items.length) return;
      const stamp = Date.now();
      const pasted = items.map((it, i) => {
        const blob = it.getAsFile();
        const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        return new File([blob], `finance-hold-${stamp}-${i + 1}.${ext}`, { type: it.type });
      });
      e.preventDefault();
      add(pasted);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => { add(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || files.length >= HOLD_PROOF_MAX}
          onClick={() => inputRef.current && inputRef.current.click()}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-slate-400 px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:bg-surface disabled:opacity-50"
        >
          <ImagePlus className="w-3.5 h-3.5" /> Add screenshot
        </button>
        <span className="text-[11px] text-ink-secondary">
          or paste one (Ctrl+V) — shows the MedRep why it is held{files.length ? ` · ${files.length}/${HOLD_PROOF_MAX}` : ''}
        </span>
      </div>
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="relative">
              <img
                src={URL.createObjectURL(f)}
                alt={f.name}
                className="h-16 w-16 rounded-md border border-slate-200 object-cover"
                onLoad={(e) => URL.revokeObjectURL(e.currentTarget.src)}
              />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                  aria-label="Remove screenshot"
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-white border border-slate-300 p-0.5 text-slate-600 hover:text-red-600"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default HoldProofField;
