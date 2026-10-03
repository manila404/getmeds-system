import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, TrendingUp, Loader2, AlertCircle } from 'lucide-react';
import client from '../../api/client';

const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

// Manila is UTC+8, no DST.
const manilaTodayStr = () =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

function DailyChart({ daily }) {
  if (!daily || daily.length === 0) {
    return (
      <p className="text-[12px] text-ink-secondary text-center py-6">
        No confirmed orders this month yet.
      </p>
    );
  }
  const today = manilaTodayStr();
  const max = Math.max(...daily.map((d) => d.total), 1);
  const CHART_H = 72;
  const BAR_GAP = 3;
  const totalBars = daily.length;
  // viewBox width is fixed at 400; bars fill it.
  const barW = Math.max(4, Math.floor((400 - (totalBars - 1) * BAR_GAP) / totalBars));
  const totalW = totalBars * barW + (totalBars - 1) * BAR_GAP;

  return (
    <svg
      viewBox={`0 0 ${totalW} ${CHART_H + 4}`}
      className="w-full"
      style={{ height: CHART_H + 4 }}
      role="img"
      aria-label="Daily sales bar chart"
    >
      {daily.map((d, i) => {
        const barH = Math.max(3, (d.total / max) * CHART_H);
        const x = i * (barW + BAR_GAP);
        const y = CHART_H - barH + 2;
        const isToday = d.day === today;
        return (
          <rect
            key={d.day}
            x={x}
            y={y}
            width={barW}
            height={barH}
            rx={2}
            fill={isToday ? '#0284c7' : '#93c5fd'}
          >
            <title>
              {d.day}: {peso(d.total)} · {d.count} {d.count === 1 ? 'order' : 'orders'}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

/**
 * Sales Summary panel — current-month total, today's total, and a daily
 * trend chart. Mounts as one of the three toggled panels in FinanceQueuePage.
 *
 * Sep 30, 2026. Source: FINANCE_VERIFIED events, GetMeds-raised orders only.
 */
const SalesSummaryPanel = ({ onClose, embedded = false }) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['finance-sales-summary'],
    queryFn: () => client.get('/api/finance/sales-summary').then((r) => r.data),
    refetchInterval: 120_000, // was 60_000 (Oct 3, 2026: lighter polling)
    staleTime: 30_000,
  });

  const summary = data?.data;
  const monthLabel = summary?.month?.from
    ? new Date(summary.month.from + 'T12:00:00Z').toLocaleString('en-PH', {
        month: 'long',
        year: 'numeric',
      })
    : '—';

  return (
    <div className={embedded ? 'space-y-3' : 'bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4'}>
      {/* Header — hidden in embedded mode; the page title acts as the label */}
      {!embedded && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-getmeds-blue" />
            <h2 className="text-sm font-semibold text-ink-primary">Sales Summary</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-ink-secondary hover:text-ink-primary hover:bg-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-ink-secondary" />
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 py-6 text-state-error text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          Could not load sales data. Try refreshing.
        </div>
      ) : (
        <>
          {/* Month + Today tiles */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-getmeds-blue/5 border border-getmeds-blue/15 rounded-xl p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-getmeds-blue leading-tight mb-1">
                {monthLabel}
              </p>
              <p className="text-2xl font-bold text-ink-primary tabular-nums">
                {peso(summary?.month?.total)}
              </p>
              <p className="text-[11px] text-ink-secondary mt-0.5">
                {summary?.month?.count ?? 0} confirmed {summary?.month?.count === 1 ? 'order' : 'orders'}
              </p>
            </div>
            <div className="bg-pharmacy-green/5 border border-pharmacy-green/20 rounded-xl p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-pharmacy-green-dark leading-tight mb-1">
                Today
              </p>
              <p className="text-2xl font-bold text-ink-primary tabular-nums">
                {peso(summary?.today?.total)}
              </p>
              <p className="text-[11px] text-ink-secondary mt-0.5">
                {summary?.today?.count ?? 0} confirmed {summary?.today?.count === 1 ? 'order' : 'orders'}
              </p>
            </div>
          </div>

          {/* Daily trend chart — omitted in embedded (compact) mode */}
          {!embedded && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-2">
                Daily trend — {monthLabel}
              </p>
              <DailyChart daily={summary?.daily} />
              <p className="text-[10px] text-ink-secondary/50 mt-1.5">
                Hover a bar for the day's total. Today is in dark blue.
              </p>
            </div>
          )}

          {!embedded && (
            <p className="text-[10px] text-ink-secondary/40 border-t border-slate-100 pt-3">
              GetMeds-raised orders only · Counted on Finance confirmation date
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default SalesSummaryPanel;
