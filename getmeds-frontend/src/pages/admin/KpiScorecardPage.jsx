/**
 * KPI Scorecard — try-out (Oct 21, 2026): NZSD and HRR per Zoho salesperson, read from the copy
 * of Zoho's invoices (GET /api/kpi-scorecard/nzsd and /hrr; backend services/kpiScorecardService.js).
 * Admin only. Routed only when VITE_KPI_SCORECARD=true; the backend needs GETMEDS_KPI_SCORECARD=true.
 * Laid out like the approved mock-up (getmeds-documents/kpi/kpi-admin-mockup.html).
 *
 * Rules for this first version (Aaron, Oct 21): NZSD counts the invoice's creation day, Mon–Fri,
 * no holidays yet; HRR counts all customers until hospitals are tagged.
 */
import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, RefreshCw, Info, Download } from 'lucide-react';
import client from '../../api/client';
import Modal from '../../components/ui/Modal';

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const manilaMonth = () => manilaToday().slice(0, 7);
const shift = (m, by) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return d.toISOString().slice(0, 7); };
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const monthName = (m) => monthLabel(m).split(' ')[0];
const peso = (n) => `₱${Math.round(Number(n) || 0).toLocaleString('en-PH')}`;
const DIVISIONS = ['', 'HOS', 'STC', 'B&B', 'URO', 'B2B', 'B2C', 'BID', 'CLIDP', 'TeleSales', 'MT'];

// Same colours as the mock-up: green from 80% of the points, amber above 0, red at 0.
const toneKey = (pts, max) => (pts >= max * 0.8 ? 'on' : pts > 0 ? 'risk' : 'bad');
const TONE = { on: 'bg-state-success-light text-pharmacy-green-700', risk: 'bg-state-warning-light text-amber-700', bad: 'bg-state-error-light text-red-700' };
const COLOR = { on: '#15803d', risk: '#d97706', bad: '#dc2626' };
const Pts = ({ pts, max }) => <span className={`inline-block min-w-[28px] rounded-full px-2 py-0.5 text-center text-[11px] font-semibold ${TONE[toneKey(pts, max)]}`}>{pts}</span>;
const Card = ({ title, value, sub, red }) => (
  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
    <p className="text-xs font-semibold text-ink-secondary">{title}</p>
    <p className={`mt-0.5 text-2xl font-bold tabular-nums ${red ? 'text-red-700' : 'text-ink-primary'}`}>{value}</p>
    {sub && <p className="text-[11px] text-ink-secondary">{sub}</p>}
  </div>
);
const Panel = ({ title, aside, children }) => (
  <div className="rounded-2xl border border-slate-200 bg-white p-3 overflow-x-auto">
    <div className="mb-1 flex items-center justify-between gap-2 px-1"><p className="text-sm font-bold text-ink-primary">{title}</p>{aside && <span className="text-[11px] text-ink-secondary">{aside}</span>}</div>
    {children}
  </div>
);
const Th = ({ children, right }) => <th className={`whitespace-nowrap border-b border-slate-200 px-2 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-secondary ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
const Td = ({ children, right, strong, wrap }) => <td className={`${wrap ? '' : 'whitespace-nowrap'} border-b border-slate-100 px-2 py-2 text-[13px] ${right ? 'text-right tabular-nums' : ''} ${strong ? 'font-semibold text-ink-primary' : ''}`}>{children}</td>;
const Chip = ({ children, className = 'border border-slate-200 bg-white' }) => <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs ${className}`}>{children}</span>;
const Bar = ({ v, color, mark }) => (
  <div className="relative h-[7px] min-w-[110px] rounded-full bg-slate-100">
    <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, v || 0)}%`, background: color }} />
    {mark != null && <div className="absolute -top-[3px] -bottom-[3px] w-[2px] bg-ink-primary" style={{ left: `${mark}%` }} />}
  </div>
);
const Legend = ({ color, children }) => <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ background: color }} />{children}</span>;

/** Every calendar day of the month, up to today in the running month. */
function calendarDays(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = manilaToday();
  const out = [];
  for (let d = 1; d <= last; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (today.slice(0, 7) === month && iso > today) break;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    out.push({ iso, day: d, weekend: dow === 0 || dow === 6 });
  }
  return out;
}

function useScorecard(kind, month, prefix) {
  return useQuery({
    queryKey: ['kpi-scorecard', kind, month, prefix],
    queryFn: () => client.get(`/api/kpi-scorecard/${kind}`, { params: { month, prefix: prefix || undefined } }).then((r) => r.data.data),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

const Nzsd = ({ d, month }) => {
  const people = d.people;
  const days = calendarDays(month);
  const avg = people.length ? Math.round(people.reduce((a, p) => a + (p.nzsd_pct || 0), 0) / people.length * 10) / 10 : 0;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3">
        <Card title="Working days so far" value={d.working_days.length} sub="Mon–Fri, no holidays set yet" />
        <Card title="Average NZSD" value={`${avg}%`} sub={`all ${people.length} CHCs`} />
        <Card title="Zero-sales days" value={people.reduce((a, p) => a + p.zero_days.length, 0)} sub="across all CHCs" red />
        <Card title="Below 70%" value={people.filter((p) => (p.nzsd_pct || 0) < 70).length} sub="two months in a row = review" />
      </div>
      <Panel title={`${monthName(month)}, day by day`} aside={days.length ? `1 → ${days[days.length - 1].day}` : ''}>
        <table className="w-full">
          <thead><tr><Th>CHC</Th><Th>Days</Th><Th right>Zero days</Th><Th right>NZSD</Th><Th right>Pts</Th></tr></thead>
          <tbody>
            {people.map((p) => {
              const sold = new Set([...p.sold_days, ...(p.weekend_sales_days || [])]);
              return (
                <tr key={p.salesperson}>
                  <Td strong>{p.salesperson}</Td>
                  <Td>
                    <div className="flex gap-[3px]">
                      {days.map((x) => (
                        <span key={x.iso} title={`${x.iso}${x.weekend ? ' · weekend' : sold.has(x.iso) ? ' · invoiced' : ' · zero sales'}`}
                          className="block h-4 w-4 rounded" style={{ background: x.weekend ? '#e2e8f0' : sold.has(x.iso) ? '#34a853' : '#e5534b' }} />
                      ))}
                    </div>
                  </Td>
                  <Td right>{p.zero_days.length}</Td>
                  <Td right>{p.nzsd_pct == null ? '—' : `${p.nzsd_pct.toFixed(1)}%`}</Td>
                  <Td right><Pts pts={p.points} max={15} /></Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-2 flex flex-wrap gap-3 px-1 text-[11px] text-ink-secondary">
          <Legend color="#34a853">At least one invoice</Legend>
          <Legend color="#e5534b">Zero sales</Legend>
          <Legend color="#e2e8f0">Weekend</Legend>
          <Legend color="#b8c4d6">Holiday or approved leave (not set up yet)</Legend>
        </div>
      </Panel>
    </>
  );
};

const Hrr = ({ d }) => (
  <>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3">
      <Card title="HRR, all CHCs" value={d.total.hrr_pct == null ? '—' : `${d.total.hrr_pct}%`} sub={`${d.total.kept} of ${d.total.last_month_customers} accounts kept`} />
      <Card title="Accounts last month" value={d.total.last_month_customers} sub={monthName(d.previous_month)} />
      <Card title="Lapsed so far" value={d.total.last_month_customers - d.total.kept} sub={`no invoice yet in ${monthName(d.month)}`} red />
      <Card title="At 85% or more" value={`${d.people.filter((p) => (p.hrr_pct || 0) >= 85).length} of ${d.people.length}`} sub="CHCs on target" />
    </div>
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-3">
      <div className="xl:col-span-3">
        <Panel title="Per CHC">
          <table className="w-full">
            <thead><tr><Th>CHC</Th><Th right>Last month</Th><Th right>Kept</Th><Th right>Lapsed</Th><Th>Retention</Th><Th right>HRR</Th><Th right>Pts</Th></tr></thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.salesperson}>
                  <Td strong>{p.salesperson}</Td><Td right>{p.last_month_customers}</Td><Td right>{p.kept}</Td><Td right>{p.lapsed}</Td>
                  <Td><Bar v={p.hrr_pct} color={COLOR[toneKey(p.points, 15)]} mark={85} /></Td>
                  <Td right>{p.hrr_pct == null ? '—' : `${p.hrr_pct.toFixed(1)}%`}</Td>
                  <Td right><Pts pts={p.points} max={15} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 px-1 text-[11px] text-ink-secondary">The line on each bar is the 85% target.</p>
        </Panel>
      </div>
      <div className="xl:col-span-2">
        <Panel title="Lapsed accounts to call" aside={`bought in ${monthName(d.previous_month).slice(0, 3)}, not yet in ${monthName(d.month).slice(0, 3)}`}>
          <table className="w-full">
            <thead><tr><Th>CHC</Th><Th>Account</Th><Th right>{monthName(d.previous_month).slice(0, 3)} sales</Th></tr></thead>
            <tbody>
              {d.lapsed.slice(0, 40).map((l) => (
                <tr key={`${l.salesperson}|${l.customer}`}><Td>{l.salesperson.replace(/^HOS \| /i, '')}</Td><Td wrap>{l.customer}</Td><Td right>{peso(l.last_month_sales)}</Td></tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 px-1 text-[11px] text-ink-secondary">{d.lapsed.length > 40 ? `Top 40 of ${d.lapsed.length}. ` : ''}The morning pulse check and the 15th-of-month rescue list, ready without a spreadsheet.</p>
        </Panel>
      </div>
    </div>
  </>
);

// ── "How this is calculated" (Oct 21, 2026, Aaron): where each number comes from in Zoho and
// how to check it there, so the figures can be evaluated before anyone relies on them.
const INFO = {
  nzsd: {
    title: 'NZSD · No Zero Sales Days — how this is calculated',
    formula: 'NZSD % = working days with at least one invoice ÷ working days so far × 100',
    bands: '95–100% → 15 pts · 90–94% → 12 · 80–89% → 9 · 70–79% → 6 · below 70% → 0',
    source: [
      'Zoho Books → Sales → Invoices, read by GetMeds through its Zoho connection (read only).',
      'Fields used: Salesperson, Created Time (when the invoice was created in Zoho), Status.',
      'Each salesperson is the Zoho Salesperson on the invoice (a territory such as HOS | LAGUNA), not the GetMeds account.',
    ],
    rules: [
      'A day counts when at least one invoice was CREATED that day (Manila time). Created Time can’t be backdated; the invoice Date can.',
      'Working days are Monday to Friday. Holidays and approved leave are not deducted yet.',
      'Draft and Void invoices don’t count; invoices deleted in Zoho don’t count.',
      'Invoices created on a Saturday or Sunday count as sales, but weekends are not scored.',
      'The running month is scored up to today.',
    ],
    check: [
      'In Zoho Books, open Sales → Invoices and choose All Invoices.',
      'Filter Salesperson = the row you want to check (for example HOS | LAGUNA).',
      'Sort by Created Time and note the dates that have at least one invoice, leaving out Draft and Void.',
      'Count the Monday–Friday dates of the month (up to today) with no invoice: that is the “Zero days” column.',
    ],
    open: [
      'Holidays and leave calendar (who keeps it).',
      'Whether Saturday is a working day.',
      'The playbook counts only Sent or Paid invoices; this counts every invoice except Draft and Void (Overdue and Partially Paid are real sales).',
    ],
  },
  hrr: {
    title: 'HRR · Retention — how this is calculated',
    formula: 'HRR % = customers invoiced last month AND this month ÷ customers invoiced last month × 100',
    bands: '95–100% → 15 pts · 85–94% → 12 · 75–84% → 8 · below 75% → 0',
    source: [
      'Zoho Books → Sales → Invoices, read by GetMeds through its Zoho connection (read only).',
      'Fields used: Salesperson, Customer, Invoice Date, Total, Status.',
      'Each salesperson is the Zoho Salesperson on the invoice; a customer counts for the salesperson on its invoices.',
    ],
    rules: [
      'The invoice DATE decides the month.',
      '“Last month” customers = every customer with at least one invoice last month for that salesperson.',
      '“Kept” = those customers that have at least one invoice this month for the same salesperson. New customers this month don’t change HRR.',
      'All customers count, not only hospitals, because hospitals are not tagged on customers yet.',
      'Draft and Void invoices don’t count; invoices deleted in Zoho don’t count.',
      'During the month, “Lapsed” means no invoice yet; a customer can still re-order before month end.',
    ],
    check: [
      'In Zoho Books, open Reports → Sales by Customer (or the saved report “HRR – Account Retention”).',
      'Date range: this month, Compare with: Previous Period.',
      'Filter or read the customers of one salesperson (Sales → Invoices, filter Salesperson, for last month and this month).',
      'Customers with sales last month and this month are “Kept”; last month only are “Lapsed”. Kept ÷ last month = HRR.',
      'Already checked: September, Division HOS = 39.1% (77 of 197), the same as the manual count in the KPI report.',
    ],
    open: [
      'Tag hospitals on the customer record so HRR becomes hospitals only, as the playbook says.',
      'About 1,100 HOS invoices carry a non-hospital Source in Zoho (KPI report).',
      'Some territories appear under two Zoho names (for example HOS | Ana Mae Otucan and HOS | PARANAQUE) and are counted separately until aliases are linked.',
    ],
  },
};

const InfoModal = ({ kind, data, onClose }) => {
  if (!kind) return null;
  const i = INFO[kind];
  const Section = ({ title, items, ordered }) => {
    const List = ordered ? 'ol' : 'ul';
    return (
      <div className="mt-4">
        <p className="text-sm font-semibold text-ink-primary">{title}</p>
        <List className={`mt-1 space-y-1 pl-5 text-sm text-ink-secondary ${ordered ? 'list-decimal' : 'list-disc'}`}>{items.map((x) => <li key={x}>{x}</li>)}</List>
      </div>
    );
  };
  return (
    <Modal isOpen onClose={onClose} title={i.title} className="sm:!max-w-2xl">
      <div className="overflow-y-auto pr-1">
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{i.formula}</p>
        <p className="mt-2 text-xs text-ink-secondary">Points (Hospital CHC playbook): {i.bands}</p>
        <Section title="Where the data comes from" items={[
          ...i.source,
          `GetMeds keeps a copy of Zoho’s invoices, refreshed every 15 minutes with a full check every night. This page reads that copy${data?.covered_from ? `, which starts ${data.covered_from}` : ''}${data?.as_of ? ` and was last refreshed ${new Date(data.as_of).toLocaleString('en-PH')}` : ''}.`,
        ]} />
        <Section title="How each number is worked out" items={i.rules} />
        <Section title="How to check it in Zoho" items={i.check} ordered />
        <Section title="Still to decide" items={i.open} />
      </div>
    </Modal>
  );
};

const TITLES = {
  nzsd: ['NZSD · No Zero Sales Days', 'Working days with at least one invoice, counted by the invoice’s creation time (it can’t be backdated).'],
  hrr: ['HRR · Hospital Retention Rate', 'Accounts invoiced last month that were invoiced again this month. All customers count until hospitals are tagged.'],
};

const KpiScorecardPage = () => {
  const navigate = useNavigate();
  const { tab: tabParam } = useParams();
  const tab = tabParam === 'hrr' ? 'hrr' : 'nzsd';
  const [month, setMonth] = useState(manilaMonth());
  const [prefix, setPrefix] = useState('HOS');
  const [info, setInfo] = useState(null);
  const { data, isLoading, isError, error, refetch, isFetching } = useScorecard(tab, month, prefix);

  const download = () => {
    if (!data?.available) return;
    const head = [[`GetMeds KPI Scorecard — ${TITLES[tab][0]} — ${monthLabel(month)}${prefix ? ` — ${prefix}` : ''}`], ['From the Zoho invoice copy, as of', data.as_of || ''], []];
    const rows = tab === 'nzsd'
      ? [['CHC', 'Working days', 'Days with sales', 'Zero days', 'NZSD %', 'Points', 'Zero-sales dates'],
        ...data.people.map((p) => [p.salesperson, p.working_days, p.days_with_sales, p.zero_days.length, p.nzsd_pct, p.points, p.zero_days.join(' ')])]
      : [['CHC', 'Last month', 'Kept', 'Lapsed', 'HRR %', 'Points'], ...data.people.map((p) => [p.salesperson, p.last_month_customers, p.kept, p.lapsed, p.hrr_pct, p.points]),
        [], ['Lapsed accounts'], ['CHC', 'Account', 'Last month sales'], ...data.lapsed.map((l) => [l.salesperson, l.customer, l.last_month_sales])];
    downloadCsv(`getmeds-kpi-${tab}-${month}${prefix ? `-${prefix.toLowerCase()}` : ''}.csv`, [...head, ...rows]);
  };
  const pill = 'inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs disabled:opacity-40';

  return (
    <div className="max-w-7xl mx-auto px-4 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-white text-xs">
          <button type="button" aria-label="Previous month" onClick={() => setMonth(shift(month, -1))} className="px-2.5 py-1">‹</button>
          <span className="px-1">{monthLabel(month)}</span>
          <button type="button" aria-label="Next month" disabled={month >= manilaMonth()} onClick={() => setMonth(shift(month, 1))} className="px-2.5 py-1 disabled:opacity-30">›</button>
        </span>
        <Chip>Scorecard: Hospital CHC</Chip>
        <select value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="Division" className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs">
          {DIVISIONS.map((p) => <option key={p} value={p}>{p ? `Division: ${p}` : 'All divisions'}</option>)}
        </select>
        <Chip className="bg-state-success-light font-semibold text-pharmacy-green-700">Live · read from the Zoho invoice copy</Chip>
        <Chip className="bg-state-warning-light font-semibold text-amber-800">Try-out</Chip>
        <button type="button" onClick={download} disabled={!data?.available} className={pill}><Download className="h-3.5 w-3.5" />Download</button>
        <button type="button" onClick={() => refetch()} disabled={isFetching} className={pill}><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />Refresh</button>
        <button type="button" onClick={() => setInfo(tab)} className={`${pill} font-semibold text-getmeds-blue hover:bg-blue-50`}><Info className="h-3.5 w-3.5" />How this is calculated</button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {[['nzsd', 'NZSD · Zero-sales days'], ['hrr', 'HRR · Retention']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => navigate(`/admin/kpi-scorecard/${k}`)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${tab === k ? 'border-getmeds-blue bg-getmeds-blue text-white' : 'border-slate-300 bg-white text-ink-secondary'}`}>{label}</button>
        ))}
      </div>

      <h1 className="mt-3 text-xl font-bold text-ink-primary">{TITLES[tab][0]} <span className="ml-1 align-middle rounded-full bg-state-success-light px-2 py-0.5 text-[11px] font-semibold text-pharmacy-green-700">15 pts</span></h1>
      <p className="mb-3 text-[13px] text-ink-secondary">{TITLES[tab][1]}{data?.as_of ? ` As of ${new Date(data.as_of).toLocaleString('en-PH')}.` : ''}</p>

      {isLoading ? <p className="flex items-center gap-2 text-sm text-ink-secondary"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        : isError ? <p className="text-sm text-red-700">{error?.response?.data?.error?.message || 'Could not load the KPIs.'}</p>
          : !data?.available ? <p className="rounded-lg border border-amber-200 bg-state-warning-light p-3 text-sm text-amber-800">{data?.reason}</p>
            : tab === 'nzsd' ? <Nzsd d={data} month={month} /> : <Hrr d={data} />}

      <InfoModal kind={info} data={data} onClose={() => setInfo(null)} />
    </div>
  );
};

export default KpiScorecardPage;
