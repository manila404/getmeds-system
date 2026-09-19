import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, BarChart3, Calendar, Loader2, AlertCircle } from 'lucide-react';
import client from '../../api/client';
import PaginationFooter from './PaginationFooter';

const todayStr = () => new Date().toISOString().slice(0, 10);

const ORIGINS = [
  { key: 'all', label: 'All orders' },
  { key: 'getmeds', label: 'Raised in GetMeds' },
  { key: 'zoho', label: 'Imported from Zoho' },
];

const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

/**
 * "Create a report tab so the finance can see these details" — a Sales by
 * Salesperson report, shaped after Zoho's own (screenshot: Name, Invoice
 * Count, Invoice Sales... for a date range, with a Total row).
 *
 * Sep 19, 2026. This is NOT that report byte-for-byte. Zoho's version is
 * built from Invoices and Credit Notes, and this app tracks neither as its
 * own record — only a Zoho invoice NUMBER on the order, no amount, no tax,
 * no credit notes at all. So this shows what this app actually has: order
 * count and order total, grouped by the same `salesperson` string Zoho's
 * report groups by. Close enough to sanity-check against, not a reason to
 * stop opening Zoho's own report for the real figures.
 */
const SalesBySalespersonPanel = ({ onClose }) => {
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [origin, setOrigin] = useState('all');
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [dateFrom, dateTo, origin]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['finance-sales-by-salesperson', dateFrom, dateTo, origin, page],
    queryFn: () =>
      client
        .get('/api/finance/reports/sales-by-salesperson', { params: { date_from: dateFrom, date_to: dateTo, origin, page } })
        .then(r => r.data),
  });

  const rows = data?.data?.rows || [];
  const total = data?.data?.total || { order_count: 0, order_total: 0 };
  const pagination = data?.data?.pagination || null;
  const isToday = dateFrom === todayStr() && dateTo === todayStr();
  const goToToday = () => { setDateFrom(todayStr()); setDateTo(todayStr()); };

  return (
    <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-getmeds-blue" /> Sales by Salesperson
          </h2>
          <p className="text-xs text-ink-secondary mt-0.5">Orders grouped by salesperson, for the range below.</p>
        </div>
        <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary shrink-0" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-2.5 bg-state-warning-light border-b border-state-warning/30 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-900" />
        <p className="text-[12px] text-amber-950">
          Built from GetMeds' own orders — order count and order total. It won't match Zoho's own "Sales by
          Salesperson" figures exactly: Zoho's report is Invoice and Credit Note amounts, which this app doesn't
          track separately from the order itself.
        </p>
      </div>

      <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          From
          <input
            type="date"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          To
          <input
            type="date"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
          />
        </label>
        {!isToday && (
          <button
            type="button"
            onClick={goToToday}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark border border-getmeds-blue/30 rounded hover:bg-getmeds-blue/5"
          >
            <Calendar className="w-3 h-3" /> Today
          </button>
        )}
        <select
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue bg-white"
        >
          {ORIGINS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {isFetching && !isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-secondary" />}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-getmeds-blue" /></div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-ink-secondary">
          <p className="text-sm">No orders in this range.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-ink-secondary uppercase border-b border-slate-200">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5 text-right">Order Count</th>
                <th className="px-4 py-2.5 text-right">Order Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="px-4 py-2.5 text-ink-primary">{r.name}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-ink-secondary">{r.order_count}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold text-getmeds-blue">{peso(r.order_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-semibold">
                <td className="px-4 py-2.5 text-ink-primary">Total</td>
                <td className="px-4 py-2.5 text-right font-mono text-ink-primary">{total.order_count}</td>
                <td className="px-4 py-2.5 text-right font-mono text-ink-primary">{peso(total.order_total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <PaginationFooter pagination={pagination} onPageChange={setPage} isFetching={isFetching} itemLabel="salespersons" />
    </div>
  );
};

export default SalesBySalespersonPanel;
