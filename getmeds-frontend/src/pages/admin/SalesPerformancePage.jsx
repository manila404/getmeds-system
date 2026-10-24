import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import client from '../../api/client';

/**
 * Sales Performance: the sales team's own sheet as a page (Aaron sheet 13.6.6, Oct 20, 2026).
 *
 * One row per Zoho salesperson (a territory), grouped Head > channel > manager, with Target,
 * Achieved (Zoho Total Sales with Tax), Balance to target, Today's invoicing and %, a total at every
 * level and a grand total. Vacant territories are red, as on the sheet, and still count in the totals.
 *
 * Read-only. The page loads when opened and when Refresh is pressed; there is no automatic refresh.
 * All rules live in the backend (services/salesPerformanceService.js); this file only draws them.
 */
const whole = (n) => (n === null || n === undefined ? '—' : Math.round(Number(n)).toLocaleString('en-PH'));
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pesoShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `₱${(v / 1e6).toLocaleString('en-PH', { maximumFractionDigits: 2 })}M`;
  if (Math.abs(v) >= 1e3) return `₱${(v / 1e3).toLocaleString('en-PH', { maximumFractionDigits: 1 })}K`;
  return peso(v);
};
const shiftMonth = (m, by) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const manilaMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
const manilaDay = (back = 0) => new Date(Date.now() + 8 * 3600 * 1000 - back * 86400000).toISOString().slice(0, 10);
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const rangeLabel = (r) => (r.from === r.to ? dayLabel(r.from) : `${dayLabel(r.from)} – ${dayLabel(r.to)}`);

const TONE = {
  on: 'bg-green-100 text-green-800',
  risk: 'bg-amber-100 text-amber-900',
  behind: 'bg-red-100 text-red-800'
};
const Pct = ({ value, status }) => (value === null || value === undefined
  ? <span className="text-slate-400">—</span>
  : <span className={`inline-block min-w-[3.5rem] text-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${TONE[status] || 'bg-slate-100 text-slate-700'}`}>{value}%</span>);

const cols = ['Head', 'Channel', 'Manager', 'Sales person', 'Zoho name', 'HQ', 'Target', 'Achieved', 'Balance to target', "Today's invoicing", '% age'];
// Shorter headings on screen so all eleven columns fit; the hover text and the CSV keep the full names.
const shortCols = ['Head', 'Channel', 'Manager', 'Sales person', 'Zoho name', 'HQ', 'Target', 'Achieved', 'Balance', 'Today', '% age'];

/** The nested structure from the server as one flat list of display rows (also used for the CSV). */
function flatten(data) {
  const out = [];
  for (const h of data.heads) {
    let headFirst = true;
    for (const g of h.groups) {
      let groupFirst = true;
      for (const m of g.managers) {
        let mgrFirst = true;
        for (const r of m.rows) {
          out.push({ kind: 'row', head: headFirst ? h.head : '', channel: groupFirst ? g.label : '', manager: mgrFirst ? m.manager : '', ...r });
          headFirst = false; groupFirst = false; mgrFirst = false;
        }
        if (m.subtotal) out.push({ kind: 'sub', label: 'TOTAL', manager: m.manager, ...m.subtotal });
      }
      out.push({ kind: 'group', label: g.total_label, ...g.total });
    }
    out.push({ kind: 'head', label: `${h.head.toUpperCase()} Total`, ...h.total });
  }
  out.push({ kind: 'grand', label: 'Grand Total', ...data.grand_total });
  return out;
}

const Td = ({ children, right, className = '' }) => <td className={`px-1 py-1 align-top ${right ? 'text-right tabular-nums whitespace-nowrap' : ''} ${className}`}>{children}</td>;

function Row({ r }) {
  if (r.kind === 'row') {
    const red = r.vacant ? 'text-red-600' : '';
    return (
      <tr className="hover:bg-slate-50">
        <Td className="font-semibold text-ink-primary whitespace-nowrap">{r.head}</Td>
        <Td className="font-medium whitespace-nowrap">{r.channel}</Td>
        <Td className="whitespace-nowrap">{r.manager}</Td>
        <Td className={`whitespace-nowrap ${red}`}>{r.person}</Td>
        <Td className={`whitespace-nowrap ${red}`}>{r.zoho_name}</Td>
        <Td>{r.hq}</Td>
        <Td right>{r.target_php === null && r.target_covered_by
          ? <span className="text-[11px] text-ink-secondary" title="This territory's sales count here; its target is part of the holder's own target">in {r.target_covered_by}</span>
          : whole(r.target_php)}</Td>
        <Td right>{whole(r.achieved_php)}</Td>
        <Td right>{whole(r.balance_php)}</Td>
        <Td right>{r.today_php ? whole(r.today_php) : r.today_php === null ? '—' : '0'}</Td>
        <Td right><Pct value={r.pct_of_target} status={r.status} /></Td>
      </tr>
    );
  }
  const style = {
    sub: 'bg-slate-100 font-semibold',
    group: 'bg-slate-200 font-semibold',
    head: 'bg-orange-100 font-bold text-orange-900',
    grand: 'bg-sky-200 font-bold text-sky-950'
  }[r.kind];
  return (
    <tr className={style}>
      <td colSpan={6} className="px-1 py-1 whitespace-nowrap">
        {r.label}{r.kind === 'sub' && r.manager ? <span className="ml-2 text-[11px] font-normal text-ink-secondary">{r.manager}</span> : null}
      </td>
      <Td right>{whole(r.target_php)}</Td>
      <Td right>{whole(r.achieved_php)}</Td>
      <Td right>{whole(r.balance_php)}</Td>
      <Td right>{r.today_php === null ? '—' : whole(r.today_php)}</Td>
      <Td right><Pct value={r.pct_of_target} status={r.status} /></Td>
    </tr>
  );
}

const SalesPerformancePage = () => {
  const [month, setMonth] = useState(manilaMonth());
  // Oct 24, 2026 (Aaron): pick dates like Zoho's Date Range; null = the whole month above.
  const [range, setRange] = useState(null);
  const [fresh, setFresh] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const period = range ? { from: range.from, to: range.to } : { month };
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['sales-performance', period, fresh],
    queryFn: () => client.get('/api/kpi/sales-performance', { params: { ...period, ...(fresh ? { fresh: 1 } : {}) } }).then((r) => r.data?.data),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  const thisMonth = data?.currentMonth || manilaMonth();
  const rows = useMemo(() => (data ? flatten(data) : []), [data]);

  if (isError && error?.response?.status === 404) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-ink-primary">Sales Performance</h1>
        <p className="text-sm text-ink-secondary mt-2">The KPI pages are switched off.</p>
      </div>
    );
  }

  const g = data?.grand_total;
  // The Excel file is built on the server from the same numbers as this page, so it carries the widths,
  // number formats and colours a CSV cannot.
  const download = async () => {
    setDownloading(true); setDownloadError('');
    try {
      const res = await client.get('/api/kpi/sales-performance/export', { params: period, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = `sales-performance-${range ? `${range.from}_${range.to}` : month}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Could not make the Excel file. Try again.');
    } finally { setDownloading(false); }
  };
  const refresh = () => { if (fresh) refetch(); else setFresh(1); };
  const noTargets = data && g && g.with_target === 0;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Sales Performance</h1>
          <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
            The sales sheet, live: every Zoho salesperson by head, channel and manager. Achieved is Zoho Total Sales with Tax (invoices minus credit notes);
            Balance to target is Target minus Achieved; Today's invoicing is today's invoices minus credit notes. Red rows are vacant territories; they still count.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
            <button type="button" onClick={() => { setRange(null); setFresh(0); }} className={`px-2.5 py-1 rounded-md font-semibold ${!range ? 'bg-getmeds-blue text-white' : 'text-ink-secondary'}`}>Month</button>
            <button type="button" onClick={() => { setRange({ from: manilaDay(), to: manilaDay() }); setFresh(0); }} className={`px-2.5 py-1 rounded-md font-semibold ${range ? 'bg-getmeds-blue text-white' : 'text-ink-secondary'}`}>Dates</button>
          </div>
          {range ? (
            <>
              <button type="button" onClick={() => { setRange({ from: manilaDay(), to: manilaDay() }); setFresh(0); }} className={`px-2.5 py-1.5 rounded-lg border text-sm ${range.from === manilaDay() && range.to === manilaDay() ? 'border-getmeds-blue text-getmeds-blue font-semibold' : 'border-slate-300 bg-white'}`}>Today</button>
              <button type="button" onClick={() => { setRange({ from: manilaDay(1), to: manilaDay(1) }); setFresh(0); }} className={`px-2.5 py-1.5 rounded-lg border text-sm ${range.from === manilaDay(1) && range.to === manilaDay(1) ? 'border-getmeds-blue text-getmeds-blue font-semibold' : 'border-slate-300 bg-white'}`}>Yesterday</button>
              <label className="text-xs text-ink-secondary">From</label>
              <input type="date" value={range.from} max={range.to} onChange={(e) => { if (e.target.value && e.target.value <= range.to) { setRange({ ...range, from: e.target.value }); setFresh(0); } }}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm bg-white" aria-label="From date" />
              <label className="text-xs text-ink-secondary">To</label>
              <input type="date" value={range.to} min={range.from} max={manilaDay()} onChange={(e) => { if (e.target.value && e.target.value >= range.from && e.target.value <= manilaDay()) { setRange({ ...range, to: e.target.value }); setFresh(0); } }}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm bg-white" aria-label="To date" />
            </>
          ) : (<>
          <button type="button" aria-label="Previous month" onClick={() => { setMonth(shiftMonth(month, -1)); setFresh(0); }} className="p-1.5 rounded-lg border border-slate-300 bg-white"><ChevronLeft className="w-4 h-4" /></button>
          <input type="month" value={month} max={thisMonth} onChange={(e) => { if (e.target.value && e.target.value <= thisMonth) { setMonth(e.target.value); setFresh(0); } }}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm bg-white" aria-label="Month" />
          <button type="button" aria-label="Next month" disabled={month >= thisMonth} onClick={() => { setMonth(shiftMonth(month, 1)); setFresh(0); }} className="p-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
          </>)}
          <button type="button" onClick={refresh} disabled={isFetching} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />Refresh
          </button>
          <button type="button" onClick={download} disabled={!rows.length || downloading} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold disabled:opacity-50">
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}Excel
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
        <span className={`px-2.5 py-1 rounded-full font-semibold border ${data?.running ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-slate-50 text-ink-secondary border-slate-300'}`}>
          {range ? `${rangeLabel(range)} · ${data?.multi_month ? 'no target (the dates cover two months)' : `${monthLabel(range.to.slice(0, 7))} target`}`
            : `${monthLabel(month)} · ${data?.running ? `so far, day ${data.today?.slice(8, 10)}` : 'final'}`}
        </span>
        {data?.zoho?.fetched_at && <span className="text-ink-secondary">Zoho read {new Date(data.zoho.fetched_at).toLocaleString('en-PH')}{data.zoho.cached ? ' (kept for 5 minutes; Refresh reads again)' : ''}</span>}
        {data?.reconciliation && (Math.abs(data.reconciliation.together_php - (data.zoho.total_with_tax_php ?? data.reconciliation.together_php)) < 0.005
          ? <span className="inline-flex items-center gap-1 text-pharmacy-green-dark"><CheckCircle2 className="w-3.5 h-3.5" />The sheet plus "not on the structure" equals Zoho's total ({peso(data.reconciliation.together_php)})</span>
          : <span className="inline-flex items-center gap-1 text-state-error font-semibold"><AlertTriangle className="w-3.5 h-3.5" />Totals do not match Zoho's own figure</span>)}
      </div>

      {downloadError && <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{downloadError}</p>}
      {data && !data.zoho_available && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="inline w-4 h-4 mr-1" />Waiting for Zoho: {data.zoho?.error}. Targets are shown; Achieved needs Zoho.</p>
      )}
      {data?.zoho?.truncated && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="inline w-4 h-4 mr-1" />Zoho returned more invoices than the page reads at once, so the figures may be short.</p>
      )}
      {data?.zoho?.warning && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{data.zoho.warning}</p>}
      {noTargets && (
        <p className="mt-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-ink-secondary">
          No territory has a target for {monthLabel(month)} in the sales structure, so % and Balance are blank. Targets are loaded from the sales sheet (User Management → By team).
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
        {[
          ['Target', g ? (g.target_php ? pesoShort(g.target_php) : 'Not set') : '—', g ? `${g.with_target} of ${g.rows} territories have one` : ''],
          ['Achieved', g && data.zoho_available ? pesoShort(g.achieved_php) : '—', 'Zoho Total Sales with Tax'],
          ['% age', g && g.pct_of_target !== null ? `${g.pct_of_target}%` : '—', g?.target_php ? 'achieved ÷ target' : 'needs targets'],
          ['Balance to target', g && g.target_php ? pesoShort(g.balance_php) : '—', 'target − achieved'],
          [range ? `On ${dayLabel(range.to)}` : "Today's invoicing", g && data.running ? pesoShort(g.today_php) : '—', range ? 'invoices − credit notes that day' : data?.running ? 'invoices − credit notes today' : 'running month only']
        ].map(([t, v, sub]) => (
          <div key={t} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{t}</p>
            <p className="text-2xl font-bold mt-1 text-ink-primary tabular-nums">{v}</p>
            <p className="text-xs text-ink-secondary mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-x-auto">
        {isLoading ? <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>
          : isError ? <p className="p-6 text-sm text-red-700">{error?.response?.data?.error?.message || 'Could not load Sales Performance.'} <button className="underline" onClick={() => refetch()}>Try again</button></p>
          : (
            <table className="w-full text-[12px]" style={{ minWidth: 960 }}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200 bg-slate-50">
                  {shortCols.map((c, i) => (range && c === 'Today' ? dayLabel(range.to).replace(/, \d{4}$/, '') : c)).map((c, i) => <th key={`${c}-${i}`} title={cols[i]} className={`px-1 py-2 whitespace-nowrap ${i >= 6 ? 'text-right' : ''}`}>{c}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => <Row key={`${r.kind}-${r.territory_id || r.label}-${i}`} r={r} />)}
              </tbody>
            </table>
          )}
      </div>

      {data?.targets_not_on_structure?.rows?.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <p className="p-3 text-sm text-ink-secondary border-b border-slate-200">
            <b className="text-ink-primary">Targets not on the structure.</b> Targets set on Sales KPIs for people who hold no territory on the sheet, and vacant targets with no territory row. They are not in the totals above; together with them the target equals the Overview's company target.
          </p>
          <table className="w-full text-sm" style={{ minWidth: 420 }}>
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200"><th className="px-2.5 py-2">Person / territory</th><th className="px-2.5 py-2 text-right">Target</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.targets_not_on_structure.rows.map((r) => <tr key={r.person}><Td className="font-medium">{r.person}</Td><Td right>{whole(r.target_php)}</Td></tr>)}
              <tr className="bg-slate-100 font-semibold"><Td>Total</Td><Td right>{whole(data.targets_not_on_structure.total_php)}</Td></tr>
            </tbody>
          </table>
        </div>
      )}

      {data?.not_on_structure?.rows?.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <p className="p-3 text-sm text-ink-secondary border-b border-slate-200">
            <b className="text-ink-primary">Not on the structure.</b> Sales Zoho recorded under a salesperson that is not a territory on the sheet. They are not in the totals above; together they make the Zoho figure whole.
          </p>
          <table className="w-full text-sm" style={{ minWidth: 520 }}>
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200"><th className="px-2.5 py-2">Zoho salesperson</th><th className="px-2.5 py-2 text-right">Achieved</th><th className="px-2.5 py-2 text-right">Today's invoicing</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.not_on_structure.rows.map((r) => (
                <tr key={r.salesperson}><Td className="font-medium">{r.salesperson}</Td><Td right>{whole(r.achieved_php)}</Td><Td right>{data.running ? whole(r.today_php) : '—'}</Td></tr>
              ))}
              <tr className="bg-slate-100 font-semibold"><Td>Total not on the structure</Td><Td right>{whole(data.not_on_structure.total_php)}</Td><Td right /></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default SalesPerformancePage;
