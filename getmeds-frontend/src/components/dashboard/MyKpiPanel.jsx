import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Target } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useKpiStatus } from '../../hooks/useKpiStatus';

/**
 * My Own KPI and My Team KPI — Oct 6, 2026 (sales structure, Aaron sheet 12.13).
 *
 * My Own KPI: the orders this person owns, so an order a Leader entered for a MedRep counts
 * on the MedRep's own KPI. My Team KPI (anyone with people under them): the person plus
 * everyone below them in the Team Lead chain, or just the My Team tab that is open
 * (`teamGroup`). Same numbers as the Admin Sales KPIs page (one calculation on the server).
 *
 * Shows nothing unless KPIs are switched on (GETMEDS_KPI_PAGE). Loads when the page opens;
 * no automatic refresh.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => (Number(n) || 0).toLocaleString('en-PH');
const manilaMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
const shiftMonth = (m, by) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

function Bar({ pct }) {
  if (pct === null || pct === undefined) return <p className="text-xs text-ink-secondary mt-2">No target set for this month</p>;
  const tone = pct >= 100 ? 'bg-pharmacy-green' : pct >= 70 ? 'bg-getmeds-blue' : 'bg-state-warning';
  return (
    <div className="mt-2">
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
      <p className="text-xs text-ink-secondary mt-1"><b className="text-ink-primary">{pct}%</b> of target</p>
    </div>
  );
}

function KpiBlock({ title, sub, k, extra }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink-primary">{title}</p>
        {sub && <p className="text-xs text-ink-secondary">{sub}</p>}
      </div>
      <div className="mt-2 flex items-end gap-2 flex-wrap">
        <p className="text-2xl font-bold text-ink-primary tabular-nums">{peso(k.booked_php)}</p>
        <p className="text-xs text-ink-secondary mb-1">booked{k.target_php ? ` of ${peso(k.target_php)} target` : ''}</p>
      </div>
      <Bar pct={k.pct_of_target} />
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-center">
        {[['Booked orders', int(k.booked_orders)], ['New customers', int(k.new_customers)], ['Orders raised', int(k.orders)], ['Orders held', int(k.orders_held)]].map(([t, v]) => (
          <div key={t} className="rounded-lg bg-slate-50 py-2">
            <dd className="text-base font-semibold text-ink-primary tabular-nums">{v}</dd>
            <dt className="text-[11px] text-ink-secondary">{t}</dt>
          </div>
        ))}
      </dl>
      {extra}
    </div>
  );
}

const MyKpiPanel = ({ teamGroup = '' }) => {
  const { user } = useAuth();
  const status = useKpiStatus(user?.role, user?.id);
  const [month, setMonth] = useState(manilaMonth());
  const { data, isLoading, isError } = useQuery({
    queryKey: ['kpi-me', user?.id, month, teamGroup], // per person: logout does not clear the page's memory
    queryFn: () => client.get('/api/kpi/me', { params: { month, ...(teamGroup ? { team_group: teamGroup } : {}) } }).then((r) => r.data?.data),
    enabled: status.canViewOwn,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  if (!status.canViewOwn) return null;
  const thisMonth = data?.currentMonth || manilaMonth();

  return (
    <section aria-label="My KPIs" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-primary inline-flex items-center gap-2"><Target className="w-4 h-4 text-getmeds-blue" />My KPIs</h2>
        <div className="flex items-center gap-2 text-xs">
          <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className="p-1 rounded-md border border-slate-300 bg-white"><ChevronLeft className="w-4 h-4" /></button>
          <span className={`px-2.5 py-1 rounded-full font-semibold border ${data?.partial ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-slate-50 text-ink-secondary border-slate-300'}`}>
            {monthLabel(month)} · {data?.partial ? 'so far' : 'final'}
          </span>
          <button type="button" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))} className="p-1 rounded-md border border-slate-300 bg-white disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-secondary">Loading your KPIs…</p>
      ) : isError || !data ? (
        <p className="text-sm text-ink-secondary">Your KPIs could not be loaded right now.</p>
      ) : (
        <div className={`grid gap-3 ${data.team ? 'md:grid-cols-2' : ''}`}>
          <KpiBlock title="My Own KPI" sub="orders that are yours" k={data.own}
            extra={data.own.entered_for_others_php ? (
              <p className="text-xs text-ink-secondary mt-3">You also entered <b className="text-ink-primary">{peso(data.own.entered_for_others_php)}</b> for others (counted on their KPI).</p>
            ) : null} />
          {data.team && (
            <KpiBlock title={data.team.label === 'My team' ? 'My Team KPI' : `My Team KPI · ${data.team.label}`}
              sub={`${int(data.team.people)} people · ${int(data.team.people_with_target)} with a target`} k={data.team} />
          )}
        </div>
      )}
    </section>
  );
};

export default MyKpiPanel;
