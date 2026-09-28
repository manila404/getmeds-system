import React from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';

const PANEL_WIDTH = 256; // w-64

/**
 * Sep 28, 2026: the "⋮" that hides everything that is not needed to decide
 * the next step — an SO number, who raised it, a raw timestamp, an all-clear
 * badge nobody has to act on. Dispatch cards had grown to seven stacked rows
 * of this per order; this is where it goes instead, one click away rather
 * than always on screen.
 *
 * Pure display — nothing here changes what data exists or what any button
 * does, only where it is shown. `items` is `[{ label, value }]`; falsy
 * `value`s are dropped, and the button itself does not render when there is
 * nothing left to show. `title` (usually the order id) heads the popover, so
 * it never reads as a floating, unlabelled list of facts.
 *
 * Positioning (a fixed-position panel via a portal, placed from the button's
 * own bounding box) is shared with FilterDropdown — see useAnchoredPopover.
 */
const MoreInfoMenu = ({ items = [], label = 'More info', title }) => {
  const rows = items.filter((i) => i && i.value !== null && i.value !== undefined && i.value !== '');
  const { open, setOpen, pos, anchorRef, panelRef } = useAnchoredPopover({ width: PANEL_WIDTH, align: 'right' });

  if (!rows.length) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={label}
        aria-label={label}
        aria-expanded={open}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-secondary hover:bg-surface hover:text-ink-primary shrink-0"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH }}
          className="z-50 rounded-md border border-slate-200 bg-white shadow-lg p-3 space-y-1.5"
        >
          {/* Sep 28, 2026: which order this popover is about — it can open far
              from the row it belongs to (the panel scrolls under it), so it
              says so instead of leaving a floating, unlabelled list of facts. */}
          {title && (
            <p className="text-xs font-mono font-semibold text-getmeds-blue pb-1.5 mb-1.5 border-b border-slate-100">
              {title}
            </p>
          )}
          {rows.map((row, i) => (
            <div key={i} className="flex items-start justify-between gap-3 text-xs">
              <span className="text-ink-secondary shrink-0">{row.label}</span>
              <span className="text-ink-primary font-medium text-right">{row.value}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
};

export default MoreInfoMenu;
