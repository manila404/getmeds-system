import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';

const PANEL_WIDTH = 288;

// Sep 28, 2026: the same colour a selected pill used to carry, now carried by
// the dropdown's trigger instead — so picking "Today" or "On hold" still
// reads at a glance, without a row of pills to hold that colour.
const TONES = {
  default: 'border-slate-300 bg-white text-ink-primary hover:bg-surface',
  blue: 'border-getmeds-blue bg-getmeds-blue/10 text-getmeds-blue-dark hover:bg-getmeds-blue/15',
  green: 'border-pharmacy-green bg-pharmacy-green/10 text-pharmacy-green-dark hover:bg-pharmacy-green/15',
  amber: 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
};

/**
 * Sep 28, 2026: a proper dropdown for a filter, in place of a native
 * `<select>` (whose options render with the browser's own bare list — no room
 * for a hint under a label, no colour on the trigger) or a long row of pills.
 * One click opens a panel of options, each with its label and an optional
 * hint underneath; the selected one carries a check. Same `value`/`onChange`
 * contract a `<select>` would have — the caller decides what the values mean.
 *
 * `options`: `[{ value, label, hint?, tone? }]`. The trigger takes the
 * selected option's own `tone` (one of TONES, default `'default'`).
 */
const FilterDropdown = ({ label, value, options, onChange }) => {
  const { open, setOpen, pos, anchorRef, panelRef } = useAnchoredPopover({ width: PANEL_WIDTH, align: 'left' });
  const selected = options.find((o) => o.value === value) || options[0];
  const tone = selected?.tone || 'default';

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-md border text-sm font-semibold ${TONES[tone]}`}
      >
        {label && <span className="font-normal text-ink-secondary">{label}:</span>}
        {selected?.label}
        <ChevronDown className={`w-3.5 h-3.5 text-current opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-label={label}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH }}
          className="z-50 rounded-md border border-slate-200 bg-white shadow-lg py-1 max-h-80 overflow-y-auto"
        >
          {options.map((o) => {
            const isSelected = o.value === value;
            return (
              <button
                key={o.value || '(empty)'}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-surface ${isSelected ? 'bg-getmeds-blue/5' : ''}`}
              >
                <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isSelected ? 'text-getmeds-blue' : 'text-transparent'}`} />
                <span className="min-w-0">
                  <span className={`block text-sm font-medium ${isSelected ? 'text-getmeds-blue-dark' : 'text-ink-primary'}`}>{o.label}</span>
                  {o.hint && <span className="block text-xs text-ink-secondary mt-0.5">{o.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
};

export default FilterDropdown;
