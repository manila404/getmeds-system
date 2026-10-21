/**
 * KPI Scorecard — try-out (Oct 21, 2026): NZSD and HRR per Zoho salesperson, read from the copy
 * of Zoho's invoices (GET /api/kpi-scorecard/nzsd and /hrr; backend services/kpiScorecardService.js).
 * Admin only. Routed only when VITE_KPI_SCORECARD=true; the backend needs GETMEDS_KPI_SCORECARD=true.
 *
 * Rules for this first version (Aaron, Oct 21): NZSD counts the invoice's creation day, Mon–Fri,
 * no holidays yet; HRR counts all customers until hospitals are tagged.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import client from '../../api/client';

const manilaMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
const shift = (m, by) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return d.toISOString().slice(0, 7); };
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const peso = (n) => `₱${Math.round(Number(n) || 0).toLocaleString('en-PH')}`;
const DIVISIONS = ['', 'HOS', 'STC', 'B&B', 'URO', 'B2B', 'B2C', 'BID', 'CLIDP', 'TeleSales', 'MT'];

const tone = (pts, max) => (pts >= max * 0.8 ? 'bg-state-success-light text-pharmacy-green-700' : pts > 0 ? 'bg-state-warning-light text-amber-700' : 'bg-state-error-light text-red-700');
const Pts = ({ pts, max }) => <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${tone(pts, max)}`}>{pts} pts</span>;
const Card = ({ title, value, sub, warn }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{title}</p>
    <p className={`mt-1 text-2xl font-bold tabular-nums ${warn ? 'text-red-700' : 'text-ink-primary'}`}>{value}</p>
    {sub && <p className="mt-0.5 text-xs text-ink-secondary">{sub}</p>}
  </div>
);
const Th = ({ children, right }) => <th className={`px-3 py-2 text-[11px] uppercase tracking-wide text-ink-secondary ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
const Td = ({ children, right, strong }) => <td className={`px-3 py-2 ${right ? 'text-right tabular-nums' : ''} ${strong ? 'font-semibold text-ink-primary' : ''}`}>{children}</td>;
const Bar = ({ v, ok }) => (
  <div className="h-1.5 w-28 rounded-full bg-slate-100"><div className={`h-1.5 rounded-full ${ok ? 'bg-pharmacy-green' : 'bg-state-warning'}`} style={{ width: `${Math.min(100, v || 0)}%` }} /></div>
);

function useScorecard(kind, month, prefix) {
  return useQuery({
    queryKey: ['kpi-scorecard', kind, month, prefix],
    queryFn: () => client.get(`/api/kpi-scorecard/${kind}`, { params: { month, prefix: prefix || undefined } }).then((r) => r.data.data),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

const Nzsd = ({ d }) => {
  const people = d.people;
  const avg = people.length ? Math.round(people.reduce((a, p) => a + (p.nzsd_pct || 0), 0) / people.length * 10) / 10 : 0;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Card title="Working days" value={d.working_days.length} sub={`Mon–Fri${d.partial ? ', so far' : ''}; no holidays yet`} />
        <Card title="Average NZSD" value={`${avg}%`} sub={`${people.length} salespersons`} />
        <Card title="Zero-sales days" value={people.reduce((a, p) => a + p.zero_days.length, 0)} sub="across everyone" warn />
        <Card title="Below 70%" value={people.filter((p) => (p.nzsd_pct || 0) < 70).length} sub="0 points" />
      </div>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 900 }}>
          <thead className="border-b border-slate-200"><tr><Th>Salesperson</Th><Th>Working days</Th><Th right>Zero days</Th><Th right>NZSD</Th><Th right>Points</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {people.map((p) => {
              const sold = new Set(p.sold_days);
              return (
                <tr key={p.salesperson}>
                  <Td strong>{p.salesperson}</Td>
                  <Td>
                    <div className="flex gap-[3px]">
                      {d.working_days.map((day) => (
                        <span key={day} title={`${day}${sold.has(day) ? ' · invoiced' : ' · zero sales'}`}
                          className={`block h-4 w-4 rounded ${sold.has(day) ? 'bg-pharmacy-green' : 'bg-red-400'}`} />
                      ))}
                    </div>
                  </Td>
                  <Td right>{p.zero_days.length}</Td>
                  <Td right>{p.nzsd_pct == null ? '—' : `${p.nzsd_pct}%`}</Td>
                  <Td right><Pts pts={p.points} max={15} /></Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-secondary">Each square is a working day: green = at least one invoice created that day, red = zero sales. Weekend invoices count as sales but weekends are not scored.</p>
    </>
  );
};

const Hrr = ({ d }) => (
  <>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      <Card title="HRR, everyone" value={d.total.hrr_pct == null ? '—' : `${d.total.hrr_pct}%`} sub={`${d.total.kept} of ${d.total.last_month_customers} customers kept`} />
      <Card title={`Customers in ${monthLabel(d.previous_month).split(' ')[0]}`} value={d.total.last_month_customers} sub="invoiced last month" />
      <Card title="Lapsed" value={d.total.last_month_customers - d.total.kept} sub="no invoice yet this month" warn />
      <Card title="At 85% or more" value={`${d.people.filter((p) => (p.hrr_pct || 0) >= 85).length} of ${d.people.length}`} sub="salespersons on target" />
    </div>
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
      <div className="xl:col-span-3 rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 640 }}>
          <thead className="border-b border-slate-200"><tr><Th>Salesperson</Th><Th right>Last month</Th><Th right>Kept</Th><Th right>Lapsed</Th><Th>Retention</Th><Th right>HRR</Th><Th right>Points</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {d.people.map((p) => (
              <tr key={p.salesperson}>
                <Td strong>{p.salesperson}</Td><Td right>{p.last_month_customers}</Td><Td right>{p.kept}</Td><Td right>{p.lapsed}</Td>
                <Td><Bar v={p.hrr_pct} ok={(p.hrr_pct || 0) >= 85} /></Td>
                <Td right>{p.hrr_pct == null ? '—' : `${p.hrr_pct}%`}</Td><Td right><Pts pts={p.points} max={15} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="xl:col-span-2 rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <p className="px-3 pt-3 text-sm font-semibold text-ink-primary">Lapsed customers to call <span className="font-normal text-ink-secondary">· biggest first</span></p>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200"><tr><Th>Salesperson</Th><Th>Customer</Th><Th right>Last month</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {d.lapsed.slice(0, 40).map((l) => (
              <tr key={`${l.salesperson}|${l.customer}`}><Td>{l.salesperson}</Td><Td>{l.customer}</Td><Td right>{peso(l.last_month_sales)}</Td></tr>
            ))}
          </tbody>
        </table>
        {d.lapsed.length > 40 && <p className="px-3 py-2 text-xs text-ink-secondary">and {d.lapsed.length - 40} more</p>}
      </div>
    </div>
    <p className="mt-2 text-xs text-ink-secondary">All customers count until hospitals are tagged on the customer record; the playbook's HRR is hospitals only.</p>
  </>
);

const KpiScorecardPage = () => {
  const [tab, setTab] = useState('nzsd');
  const [month, setMonth] = useState(manilaMonth());
  const [prefix, setPrefix] = useState('HOS');
  const { data, isLoading, isError, error, refetch, isFetching } = useScorecard(tab, month, prefix);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">KPI Scorecard <span className="ml-1 align-middle rounded-full bg-state-warning-light px-2 py-0.5 text-xs font-semibold text-amber-800">Try-out</span></h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-secondary">Hospital CHC playbook KPIs per Zoho salesperson, read from the copy of Zoho&apos;s invoices. IST is on Sales Performance; DSO comes later.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setMonth(shift(month, -1))} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">‹</button>
          <span className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm">{monthLabel(month)}</span>
          <button type="button" disabled={month >= manilaMonth()} onClick={() => setMonth(shift(month, 1))} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-40">›</button>
          <select value={prefix} onChange={(e) => setPrefix(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" aria-label="Division">
            {DIVISIONS.map((p) => <option key={p} value={p}>{p ? `Division: ${p}` : 'All divisions'}</option>)}
          </select>
          <button type="button" onClick={() => refetch()} disabled={isFetching} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        {[['nzsd', 'NZSD · No Zero Sales Days', '15 pts'], ['hrr', 'HRR · Retention', '15 pts']].map(([k, label, pts]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${tab === k ? 'border-getmeds-blue bg-getmeds-blue text-white' : 'border-slate-300 bg-white text-ink-secondary'}`}>
            {label} <span className="opacity-75">· {pts}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        {isLoading ? <p className="flex items-center gap-2 text-sm text-ink-secondary"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
          : isError ? <p className="text-sm text-red-700">{error?.response?.data?.error?.message || 'Could not load the KPIs.'}</p>
            : !data?.available ? <p className="rounded-lg border border-amber-200 bg-state-warning-light p-3 text-sm text-amber-800">{data?.reason}</p>
              : (
                <>
                  <p className="mb-3 text-xs text-ink-secondary">From the invoice copy · as of {data.as_of ? new Date(data.as_of).toLocaleString('en-PH') : '—'}</p>
                  {tab === 'nzsd' ? <Nzsd d={data} /> : <Hrr d={data} />}
                </>
              )}
      </div>
    </div>
  );
};

export default KpiScorecardPage;
