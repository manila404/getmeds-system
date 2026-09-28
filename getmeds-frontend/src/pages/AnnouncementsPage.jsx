import React, { useEffect } from 'react';
import { Megaphone, RefreshCw } from 'lucide-react';
import {
  useStockAnnouncements,
  useMarkAnnouncementsSeen,
  StockAnnouncementLine
} from '../components/stock/StockAnnouncements';

/**
 * Sep 28, 2026: the permanent home for stock announcements — reached from the
 * sidebar (or the dashboard's link, or the post-login popup's "View all").
 * Every open announcement, newest first; nothing here is scoped to "unseen"
 * only, since the whole point of a dedicated page is somewhere to check "what
 * did I miss" without it having disappeared the moment the popup closed.
 *
 * Opening this page counts as reading it: it marks everything seen on mount,
 * the same as dismissing the popup does — either one is "I've caught up".
 */
const AnnouncementsPage = () => {
  const { data = [], isLoading, refetch, isFetching } = useStockAnnouncements();
  const markSeen = useMarkAnnouncementsSeen();

  useEffect(() => {
    markSeen.mutate();
    // Once, on opening the page — not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-getmeds-blue" />
            Announcements
          </h1>
          <p className="text-sm text-ink-secondary mt-1">
            What Dispatch has said about stock — every open one, newest first. Taken down once Dispatch resolves it.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary transition-colors shadow-sm shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
        </div>
      ) : data.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200 shadow-sm">
          <Megaphone className="w-10 h-10 mx-auto mb-3 text-ink-secondary/40" />
          <p className="text-ink-secondary">Nothing open right now — you're all caught up.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.map((a) => <StockAnnouncementLine key={a.id} a={a} />)}
        </div>
      )}
    </div>
  );
};

export default AnnouncementsPage;
