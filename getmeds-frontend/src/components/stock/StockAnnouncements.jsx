import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
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

/** The open announcements; refreshed every minute. */
export const useStockAnnouncements = () =>
  useQuery({
    queryKey: ['stock-announcements'],
    queryFn: () => client.get('/api/stock-announcements').then((r) => r.data?.data?.announcements || []),
    refetchInterval: 60000,
    staleTime: 30000
  });

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
 * Sep 24, 2026: the compact side-panel form, for the Management dashboard. The
 * full-width banner put stock news above everything else, but it's rarely
 * something an admin must act on — so here it's a quiet card that shows the
 * three newest and folds the rest behind a toggle, instead of claiming up to
 * 288px of the page's prime position.
 */
const PANEL_PREVIEW = 3;
const StockAnnouncementsPanel = () => {
  const { data = [] } = useStockAnnouncements();
  const [expanded, setExpanded] = useState(false);
  if (!data.length) return null;

  const shown = expanded ? data : data.slice(0, PANEL_PREVIEW);
  const hidden = data.length - shown.length;
  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <Megaphone className="w-4 h-4 text-getmeds-blue" />
        <h2 className="text-sm font-semibold text-ink-primary">Stock from Dispatch</h2>
        <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">{data.length}</span>
      </div>
      <div className="space-y-2 p-3 max-h-96 overflow-y-auto">
        {shown.map((a) => <StockAnnouncementLine key={a.id} a={a} />)}
      </div>
      {(hidden > 0 || expanded) && data.length > PANEL_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-slate-100 px-4 py-2 text-xs font-semibold text-getmeds-blue hover:bg-surface rounded-b-xl"
        >
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </section>
  );
};

/** The dashboard banner. Renders nothing when there is nothing open. */
const StockAnnouncementsBanner = ({ variant = 'banner' }) => {
  const { data = [] } = useStockAnnouncements();
  if (variant === 'panel') return <StockAnnouncementsPanel />;
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
