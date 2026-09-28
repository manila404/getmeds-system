import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Megaphone, X, ArrowRight } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useStockAnnouncements, useUnseenAnnouncementsCount, useMarkAnnouncementsSeen, StockAnnouncementLine } from './StockAnnouncements';

// Sep 28, 2026: only the roles StockAnnouncements has ever targeted (the
// MedRep and Management dashboards) — Dispatch posts these, Finance and Admin
// never see them anywhere else, so a popup for either would be new noise
// rather than surfacing something they already look for.
const AUDIENCE = ['medrep', 'management'];
const PREVIEW = 3;

/**
 * Sep 28, 2026: the one moment this app interrupts someone about stock —
 * right after they sign in, and only when there is something they have not
 * acknowledged yet. Mounted once in Layout.jsx, so it fires wherever they land
 * after login, not per-page.
 *
 * Deliberately NOT "every login": a popup that fires every session teaches
 * people to close it without reading. This fires once per browser tab (a
 * ref-free `sessionStorage` flag) AND only while `unseen_count` is above
 * zero — dismissing marks everything seen server-side, so it will not show
 * again until Dispatch posts something new after that.
 */
const AnnouncementsPopup = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const role = String(user?.role || '').toLowerCase();
  const enabled = AUDIENCE.includes(role);

  const { data: announcements = [] } = useStockAnnouncements(enabled);
  const unseen = useUnseenAnnouncementsCount(enabled);
  const markSeen = useMarkAnnouncementsSeen();

  // Shown at most once per tab session, even if the query refetches in the
  // background while it's open or just after it closes.
  const [dismissedThisSession, setDismissedThisSession] = useState(
    () => sessionStorage.getItem('announcements-popup-shown') === '1'
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || dismissedThisSession) return;
    if (unseen > 0) {
      setOpen(true);
      sessionStorage.setItem('announcements-popup-shown', '1');
      setDismissedThisSession(true);
    }
    // Fires once, the first time `unseen` is known to be > 0 this session —
    // not on every count change, which would reopen it while someone is
    // reading the page behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, unseen > 0]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    markSeen.mutate();
  };

  const shown = announcements.slice(0, PREVIEW);
  const hidden = announcements.length - shown.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Megaphone className="w-5 h-5 text-getmeds-blue shrink-0" />
            <div>
              <h2 className="text-base font-bold text-ink-primary">
                {unseen} new stock announcement{unseen === 1 ? '' : 's'}
              </h2>
              <p className="text-xs text-ink-secondary mt-0.5">From Dispatch, since you last checked.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 p-1.5 -mr-1.5 -mt-1 rounded-md text-ink-secondary hover:bg-surface hover:text-ink-primary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-2 max-h-72 overflow-y-auto">
          {shown.map((a) => <StockAnnouncementLine key={a.id} a={a} />)}
          {hidden > 0 && <p className="text-xs text-ink-secondary text-center pt-1">and {hidden} more…</p>}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between">
          <button type="button" onClick={close} className="px-4 py-2 rounded-md text-sm font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary">
            Got it
          </button>
          <button
            type="button"
            onClick={() => { close(); navigate('/announcements'); }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold hover:bg-getmeds-blue-hover"
          >
            View all
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AnnouncementsPopup;
