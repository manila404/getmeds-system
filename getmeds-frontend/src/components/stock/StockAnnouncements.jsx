import React from 'react';
import { useQuery } from '@tanstack/react-query';
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

/** The dashboard banner. Renders nothing when there is nothing open. */
const StockAnnouncementsBanner = () => {
  const { data = [] } = useStockAnnouncements();
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
