import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Megaphone, ArrowRight } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';

/**
 * Dispatch's stock announcements (Sep 15, 2026) — the open ones, as a banner
 * on the MedRep and Management dashboards, and as warnings on the order form.
 * Posted and resolved from the Dispatch page (StockAnnouncementsManager).
 */

export const STOCK_KINDS = {
  out_of_stock: { label: 'Out of stock', icon: '⛔', className: 'border-red-200 bg-red-50 text-red-900' },
  low_stock: { label: 'Low stock', icon: '⚠️', className: 'border-amber-300 bg-amber-50 text-amber-900' },
  back_in_stock: { label: 'Back in stock', icon: '✅', className: 'border-green-200 bg-green-50 text-green-900' },
  stock_update: { label: 'Stock update', icon: '📦', className: 'border-getmeds-blue/30 bg-getmeds-blue/5 text-getmeds-blue-dark' }
};

// One fetch, shared: every hook below queries this same key, so two
// components reading different slices of the response (the list, the unseen
// count) still cost one network request between them, not one each.
const ANNOUNCEMENTS_KEY = ['stock-announcements'];
const fetchAnnouncements = () => client.get('/api/stock-announcements').then((r) => r.data?.data || {});

/**
 * The open announcements; refreshed every minute. Unchanged shape — `.data`
 * is still the plain array every existing caller already destructures as
 * `{ data = [] }`.
 */
export const useStockAnnouncements = (enabled = true) =>
  useQuery({
    queryKey: ANNOUNCEMENTS_KEY,
    queryFn: fetchAnnouncements,
    select: (res) => res.announcements || [],
    enabled,
    refetchInterval: 60000,
    staleTime: 30000
  });

/**
 * Sep 28, 2026: how many of the open announcements THIS person has not
 * acknowledged yet (server-computed from users.stock_announcements_seen_at —
 * see stockAnnouncements.controller.js). Drives the post-login popup and the
 * Announcements sidebar link's badge.
 */
export const useUnseenAnnouncementsCount = (enabled = true) => {
  const { data } = useQuery({
    queryKey: ANNOUNCEMENTS_KEY,
    queryFn: fetchAnnouncements,
    select: (res) => res.unseen_count || 0,
    enabled,
    refetchInterval: 60000,
    staleTime: 30000
  });
  return data || 0;
};

/** "I've seen these" — clears the unseen count for the caller's own account. */
export const useMarkAnnouncementsSeen = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post('/api/stock-announcements/seen'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY })
  });
};

/** One announcement as a line: icon, type, product, message, who and when. */
export const StockAnnouncementLine = ({ a, right = null }) => {
  const k = STOCK_KINDS[a.kind] || STOCK_KINDS.stock_update;
  return (
    <div className={`flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2 ${k.className}`}>
      <div className="min-w-0 text-sm">
        <span className="mr-1">{k.icon}</span>
        <span className="text-[11px] font-bold uppercase tracking-wide">{k.label}</span>{' '}
        <span className="font-semibold">{a.product_name || 'Product'}</span>
        {a.sku && <span className="ml-1 text-xs opacity-70 font-mono">{a.sku}</span>}
        {a.message && <p className="text-[13px] mt-0.5">{a.message}</p>}
        <p className="text-[11px] opacity-75 mt-0.5">
          — {a.created_by_name || 'Dispatch'} (Dispatch), {formatPHT(a.created_at, 'short-datetime')}
        </p>
      </div>
      {right}
    </div>
  );
};

/**
 * Sep 28, 2026: a small link, not a list — the third surface this can live on
 * (after the post-login popup and the dedicated /announcements page). Sep 24's
 * panel (3 newest + "Show more") was already a step down from the full-width
 * banner, but it still repeated every open item on every dashboard visit. This
 * says how many are open, and how many the viewer has not acknowledged yet,
 * and leaves reading them to the page built for that — see AnnouncementsPage.
 */
const StockAnnouncementsLink = () => {
  const { data = [] } = useStockAnnouncements();
  const unseen = useUnseenAnnouncementsCount();
  if (!data.length) return null;
  return (
    <Link
      to="/announcements"
      className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-sm transition-colors ${
        unseen > 0
          ? 'border-getmeds-blue/30 bg-getmeds-blue/5 hover:bg-getmeds-blue/10'
          : 'border-slate-200 bg-white hover:bg-surface'
      }`}
    >
      <Megaphone className={`w-4 h-4 shrink-0 ${unseen > 0 ? 'text-getmeds-blue' : 'text-ink-secondary'}`} />
      <span className="flex-1 min-w-0">
        {unseen > 0 ? (
          <span className="font-semibold text-getmeds-blue-dark">
            {unseen} new stock announcement{unseen === 1 ? '' : 's'} from Dispatch
          </span>
        ) : (
          <span className="text-ink-secondary">
            {data.length} open stock announcement{data.length === 1 ? '' : 's'} — you're caught up
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs font-semibold text-getmeds-blue flex items-center gap-1">
        View all <ArrowRight className="w-3.5 h-3.5" />
      </span>
    </Link>
  );
};

/**
 * The dashboard's own stock-announcements surface. `variant="link"` (the
 * current default everywhere) is the compact link above; `variant="banner"`
 * is the original full, always-expanded list, kept for anything that still
 * wants it. Renders nothing when there is nothing open.
 */
const StockAnnouncementsBanner = ({ variant = 'link' }) => {
  const { data = [] } = useStockAnnouncements();
  if (variant === 'link') return <StockAnnouncementsLink />;
  if (!data.length) return null;
  return (
    <div className="bg-white shadow rounded-lg border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-ink-primary mb-2">📢 Stock announcements from Dispatch ({data.length})</h2>
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {data.map((a) => <StockAnnouncementLine key={a.id} a={a} />)}
      </div>
    </div>
  );
};

export default StockAnnouncementsBanner;
