import { useEffect, useRef, useState } from 'react';

/**
 * Sep 28, 2026: the open/position/close plumbing shared by every "click a
 * small control, get a floating panel" piece on the Dispatch page —
 * MoreInfoMenu's "⋮" and FilterDropdown's warehouse/time pickers. Pulled out
 * once both needed it, so there is one place that decides where the panel
 * goes and when it closes, not two that could drift.
 *
 * Positions the panel with `position: fixed`, computed from the trigger's own
 * bounding box, so a panel opened from inside a scrolling list (every card on
 * this page scrolls inside its own `overflow-y-auto`) is never clipped by
 * that list's edge the way an absolutely-positioned child of it would be —
 * the caller still renders the panel through a portal to `document.body`.
 */
export function useAnchoredPopover({ width = 256, align = 'right' } = {}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const panelRef = useRef(null);

  const place = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const left =
      align === 'right'
        ? Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
        : Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ top: r.bottom + 4, left });
  };

  useEffect(() => {
    if (!open) return undefined;
    place();
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    // A fixed-position panel has to move (or close) when the list it belongs
    // to scrolls underneath it — the trigger itself does not move in a way
    // `mousedown` alone would catch.
    const onScrollOrResize = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { open, setOpen, pos, anchorRef, panelRef };
}
