/**
 * Admin Overview — try-out page (Oct 14, 2026).
 *
 * Total Sales with Tax (first card) comes from Zoho in Live mode: invoices dated in the
 * period minus credit notes, with tax — the same total as Zoho's "Sales by
 * Salesperson" report. The other cards and the chart use the app's own orders.
 *
 * Live numbers only (Oct 14, 2026: the Sample data switch was removed):
 * GET /api/admin-overview (backend controllers/adminOverview.controller.js).
 * Read-only, Admin only.
 *
 * Target Performance: the gauge, Sales and Team Leads are live (Zoho Total Sales
 * with Tax vs the Sales KPIs targets). Management, Finance, Operations and Admin
 * are still example KPIs from src/mocks/adminOverviewMock.js, marked Sample —
 * they are not tracked anywhere in the app yet.
 * Create account never creates anything here; it points to User Management.
 *
 * Reachable only when VITE_ADMIN_OVERVIEW_MOCK=true, at /admin/overview-mock.
 * If not approved, delete this file, src/mocks/adminOverviewMock.js, the
 * backend route/controller, and the lines marked "ADMIN OVERVIEW" in App.jsx,
 * Sidebar.jsx and the backend's app.js.
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Cell, ReferenceLine, Tooltip,
} from 'recharts';
import {
  ArrowUpRight, Upload, Plus, Target, ChevronRight, Radio, RefreshCw, Loader2, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import Modal from '../../components/ui/Modal';
import { useAuth } from '../../hooks/useAuth';
import {
  ADMIN_NAME,
  KPI_GROUPS, ROLE_OPTIONS, TEAM_OPTIONS,
} from '../../mocks/adminOverviewMock';

// ── Formatting helpers ───────────────────────────────────────────────────
const peso = (n, digits = 2) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const pesoShort = (n) => {
  if (Math.abs(n) >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `₱${Math.round(n / 1_000)}K`;
  return `₱${Math.round(n)}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Dates are plain 'YYYY-MM-DD' strings; handled without time zones.
const parts = (iso) => iso.split('-').map(Number);
const fmtDay = (iso) => { const [, m, d] = parts(iso); return `${MONTHS[m - 1]} ${d}`; };
const fmtRange = (from, to) => {
  const [fy] = parts(from); const [ty] = parts(to);
  return from === to ? `${fmtDay(from)}, ${ty}` : `${fmtDay(from)}${fy !== ty ? `, ${fy}` : ''} – ${fmtDay(to)}, ${ty}`;
};
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const sum = (rows, key = 'amount') => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

/** Big money figure with the centavos greyed out, as in the design. */
const Money = ({ value, className = '' }) => {
  const [whole, cents] = peso(value).split('.');
  return <span className={className}>{whole}<span className="text-slate-400">.{cents}</span></span>;
};

// ── Order status labels (live data uses the app's status codes) ──────────
const ORDER_STATUS_LABEL = {
  pending_management_approval: 'Pending approval', submitted: 'Submitted', validating: 'Validating',
  so_pending: 'Sales Order pending', so_created: 'Sales Order created',
  ready_for_finance_verified: 'Waiting for Finance', ready_for_draft_invoice: 'For invoicing',
  ready_for_invoice_sent: 'Invoice sent', ready_for_dispatch: 'Ready for dispatch',
  picking_packing: 'Picking & packing', dispatched: 'Dispatched', tracking_shared: 'In transit',
  completed: 'Completed', on_hold: 'On hold', exception: 'Exception', cancelled: 'Cancelled', deleted: 'Deleted',
};
const statusLabel = (s) => ORDER_STATUS_LABEL[s] || s;
const isPendingApproval = (s) => s === 'pending_management_approval' || s === 'Pending approval';

// ── KPI pills (sample KPIs) ──────────────────────────────────────────────
const STATUS_META = {
  on: { label: 'On target', cls: 'bg-state-success-light text-pharmacy-green-700 border-pharmacy-green-200' },
  risk: { label: 'At risk', cls: 'bg-state-warning-light text-amber-700 border-amber-200' },
  behind: { label: 'Behind', cls: 'bg-state-error-light text-red-700 border-red-200' },
};
const StatusPill = ({ status }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${STATUS_META[status].cls}`}>
    {STATUS_META[status].label}
  </span>
);
const groupScore = (g) => {
  const on = g.kpis.filter((k) => k.status === 'on').length;
  const total = g.kpis.length;
  const cls = on === total ? STATUS_META.on.cls : on * 2 >= total ? STATUS_META.risk.cls : STATUS_META.behind.cls;
  return { on, total, cls };
};
const SamplePill = () => (
  <span className="rounded-full border border-amber-200 bg-state-warning-light px-2 py-0.5 text-[11px] font-semibold text-amber-800">Sample</span>
);
const LivePill = () => (
  <span className="rounded-full border border-pharmacy-green-200 bg-state-success-light px-2 py-0.5 text-[11px] font-semibold text-pharmacy-green-700">Live</span>
);
// Oct 14, 2026: in Live mode Sales and Team Leads come from Zoho vs the KPI page targets;
// the other groups stay sample until their owners agree KPIs and targets.
const LIVE_GROUP_KEYS = ['sales', 'team_leads'];
const sampleGroupsFor = (ds) => (ds.live ? KPI_GROUPS.filter((g) => !LIVE_GROUP_KEYS.includes(g.key)) : KPI_GROUPS);

// ── Live data ────────────────────────────────────────────────────────────
// Shape: { live, from, to, today, orders[], booked[], zoho, target, salesKpi, truncated }
//   order/booked row: { id, ref, date, customer, salesperson, division, status, amount }

const PERIODS = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_30', label: 'Last 30 days' },
  { key: 'last_7', label: 'Last 7 days' },
];
function periodRange(key) {
  const today = manilaToday();
  if (key === 'last_month') {
    const [y, m] = parts(today);
    const firstThis = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastPrev = addDays(firstThis, -1);
    return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
  }
  if (key === 'last_30') return { from: addDays(today, -29), to: today };
  if (key === 'last_7') return { from: addDays(today, -6), to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

const freshRef = { current: false }; // set by Refresh so the backend re-reads Zoho instead of its 5-minute copy
function useLiveOverview(periodKey, enabled) {
  const range = periodRange(periodKey);
  return useQuery({
    queryKey: ['admin-overview', range.from, range.to],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await client.get('/api/admin-overview', { params: { ...range, ...(freshRef.current ? { fresh: 1 } : {}) } });
      freshRef.current = false;
      const d = res.data.data;
      return {
        live: true, from: d.from, to: d.to, today: d.today, orders: d.orders, booked: d.booked, zoho: d.zoho,
        // A monthly target only means something for a period inside one calendar month.
        target: d.months.length === 1 ? d.target_php : null, targetPeople: d.target_people,
        multiMonth: d.months.length > 1, truncated: d.truncated, generatedAt: d.generatedAt,
        salesKpi: d.sales_kpi || null,
      };
    },
  });
}

// ── Chart buckets (day / week / month) ───────────────────────────────────
function dailySeries(ds) {
  const map = new Map();
  for (let d = ds.from; d <= ds.to; d = addDays(d, 1)) map.set(d, { date: d, total: 0, orders: 0 });
  ds.orders.forEach((o) => { const r = map.get(o.date); if (r) { r.total += Number(o.amount) || 0; r.orders += 1; } });
  return [...map.values()];
}
function buildBuckets(ds, mode) {
  const daily = dailySeries(ds);
  if (mode === 'day') {
    return daily.map((d) => {
      const [, m, day] = parts(d.date);
      return {
        key: d.date, label: fmtDay(d.date), tick: day === 1 || d.date === ds.from ? `${MONTHS[m - 1]} ${day}` : String(day),
        from: d.date, to: d.date, total: d.total, orders: d.orders, current: d.date === ds.today,
      };
    });
  }
  const groups = new Map();
  daily.forEach((d) => {
    const [y, m, day] = parts(d.date);
    let key; let label;
    if (mode === 'week') { // weeks start on Monday
      const dt = new Date(Date.UTC(y, m - 1, day));
      dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      key = dt.toISOString().slice(0, 10); label = `Week of ${fmtDay(key)}`;
    } else {
      key = `${y}-${String(m).padStart(2, '0')}`; label = `${MONTHS[m - 1]} ${y}`;
    }
    const g = groups.get(key) || { key, label, from: d.date, to: d.date, total: 0, orders: 0 };
    g.to = d.date; g.total += d.total; g.orders += d.orders;
    groups.set(key, g);
  });
  return [...groups.values()].map((g) => ({
    ...g, tick: mode === 'week' ? fmtDay(g.key) : g.label.split(' ')[0], current: g.from <= ds.today && ds.today <= g.to,
  }));
}

// ── Page ─────────────────────────────────────────────────────────────────
const AdminOverviewMockPage = () => {
  const { user } = useAuth();
  const firstName = (user?.name || user?.full_name || '').split(' ')[0] || ADMIN_NAME;

  // Oct 14, 2026 (Aaron): live numbers only; the Sample data switch was removed.
  const [periodKey, setPeriodKey] = useState('this_month');
  const live = useLiveOverview(periodKey, true);
  const ds = live.data;

  return (
    <div className="max-w-[1400px] mx-auto">
      <SourceBar periodKey={periodKey} setPeriodKey={setPeriodKey} live={live} ds={ds} />
      {live.isLoading && (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-ink-secondary">
          <Loader2 className="animate-spin" size={18} /> Loading live numbers…
        </div>
      )}
      {live.isError && <LiveError error={live.error} onRetry={() => live.refetch()} />}
      {ds && <Overview ds={ds} firstName={firstName} />}
    </div>
  );
};

const SourceBar = ({ periodKey, setPeriodKey, live, ds }) => (
  <div className="mb-4 flex flex-wrap items-center gap-3">
    <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} aria-label="Period"
      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-primary focus:outline-none focus:ring-2 focus:ring-getmeds-blue-200">
      {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
    </select>
    <span className="inline-flex items-center gap-1.5 rounded-full border border-pharmacy-green-200 bg-state-success-light px-3 py-1 text-xs font-semibold text-pharmacy-green-700">
      <Radio size={13} /> Live · read-only{ds?.generatedAt ? ` · as of ${new Date(ds.generatedAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}` : ''}
    </span>
    <button type="button" onClick={() => { freshRef.current = true; live.refetch(); }} disabled={live.isFetching}
      className="inline-flex items-center gap-1 text-xs font-semibold text-getmeds-blue hover:underline disabled:opacity-50">
      <RefreshCw size={13} className={live.isFetching ? 'animate-spin' : ''} /> Refresh
    </button>
  </div>
);

const LiveError = ({ error, onRetry }) => {
  const status = error?.response?.status;
  const msg = status === 403 ? 'Only Admin accounts can see live numbers.'
    : status === 404 ? 'The backend has no /api/admin-overview yet. Restart the backend after pulling the new files.'
      : error?.response?.data?.error?.message || 'Could not reach the backend.';
  return (
    <div className="mb-4 rounded-2xl border border-red-200 bg-state-error-light p-5 text-sm text-red-800">
      <div className="flex items-center gap-2 font-semibold"><AlertTriangle size={16} /> Live numbers didn&apos;t load</div>
      <p className="mt-1">{msg}</p>
      <div className="mt-3">
        <button type="button" onClick={onRetry} className="rounded-lg bg-white px-3 py-1.5 font-semibold text-ink-primary border border-slate-200 hover:bg-slate-50">Try again</button>
      </div>
    </div>
  );
};

const Overview = ({ ds, firstName }) => {
  const [cardDetail, setCardDetail] = useState(null);   // 'booked' | 'aov' | 'orders'
  const [kpiGroup, setKpiGroup] = useState(null);
  const [salesView, setSalesView] = useState(null);     // 'people' | 'teams' (live Sales KPIs)
  const [showTargets, setShowTargets] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [bucket, setBucket] = useState(null);
  const [mode, setMode] = useState('day');

  const totals = useMemo(() => {
    const total = sum(ds.orders);
    const booked = sum(ds.booked);
    const todayRows = ds.orders.filter((o) => o.date === ds.today);
    return {
      total, booked, count: ds.orders.length, aov: ds.orders.length ? total / ds.orders.length : 0,
      zoho: ds.zoho && ds.zoho.available ? ds.zoho : null,
      totalSales: ds.zoho && ds.zoho.available ? ds.zoho.total_sales_with_tax : null,
      pctOfTarget: ds.target && ds.zoho && ds.zoho.available ? Math.round((ds.zoho.total_sales_with_tax / ds.target) * 1000) / 10 : null,
      todayInRange: ds.from <= ds.today && ds.today <= ds.to,
      todayCount: todayRows.length,
      pending: ds.orders.filter((o) => isPendingApproval(o.status)),
      periodLabel: fmtRange(ds.from, ds.to),
    };
  }, [ds]);

  const handleExport = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const daily = dailySeries(ds);
    const lines = [
      [ds.live ? 'GetMeds Admin Overview — LIVE data (read-only export)' : 'GetMeds Admin Overview — SAMPLE data, not real figures'],
      ['Period', totals.periodLabel],
      ['Total sales with tax (Zoho: invoices − credit notes)', totals.zoho ? totals.zoho.total_sales_with_tax.toFixed(2) : `Not available: ${ds.zoho?.error || ''}`],
      ['Balance due (Zoho)', totals.zoho ? totals.zoho.balance_due.toFixed(2) : ''],
      ['Booked in the app (Finance verified)', totals.booked.toFixed(2)],
      ['Monthly target', ds.target ?? 'Not set'],
      ['Orders raised', totals.count], ['Orders total', totals.total.toFixed(2)],
      [],
      ['Daily sales (orders raised)'], ['Date', 'Orders', 'Total (PHP)'],
      ...daily.map((d) => [d.date, d.orders, d.total.toFixed(2)]),
      [],
      ['Orders raised'], ['Order', 'Date', 'Customer', 'Salesperson', 'Division', 'Status', 'Amount (PHP)'],
      ...ds.orders.map((o) => [o.ref, o.date, o.customer, o.salesperson, o.division, statusLabel(o.status), Number(o.amount).toFixed(2)]),
      [],
      ['Booked (Finance verified)'], ['Order', 'Verified on', 'Customer', 'Salesperson', 'Division', 'Status', 'Amount (PHP)'],
      ...ds.booked.map((o) => [o.ref, o.date, o.customer, o.salesperson, o.division, statusLabel(o.status), Number(o.amount).toFixed(2)]),
      [],
      ...(totals.zoho ? [
        ['Total sales by salesperson (Zoho)'], ['Salesperson', 'Invoices', 'Invoice sales with tax', 'Credit notes', 'Credit notes with tax', 'Total sales with tax', 'Balance due'],
        ...totals.zoho.by_salesperson.map((r) => [r.name, r.invoices, r.invoice_total.toFixed(2), r.credit_notes, r.credit_total.toFixed(2), r.total.toFixed(2), r.balance.toFixed(2)]),
        [],
        ['Zoho invoices'], ['Invoice', 'Date', 'Customer', 'Salesperson', 'Sales Order', 'Status', 'Total', 'Balance'],
        ...totals.zoho.invoices.map((i) => [i.number, i.date, i.customer, i.salesperson, i.so_number, i.status, i.total.toFixed(2), i.balance.toFixed(2)]),
        [],
        ['Zoho credit notes'], ['Credit note', 'Date', 'Customer', 'Salesperson', 'Status', 'Total'],
        ...totals.zoho.credit_notes.map((c) => [c.number, c.date, c.customer, c.salesperson, c.status, c.total.toFixed(2)]),
        [],
      ] : []),
      ...(ds.salesKpi && ds.salesKpi.available ? [
        [`Sales KPIs — Zoho Total Sales with Tax vs monthly target (pace ${ds.salesKpi.pace}%)`],
        ['Person', 'Team Lead', 'Target (PHP)', 'Zoho sales with tax (PHP)', '% of target', 'Status'],
        ...ds.salesKpi.people.map((p) => [p.name, p.team_lead, p.target_php.toFixed(2), p.sales_php.toFixed(2), p.pct_of_target ?? '', p.status ? STATUS_META[p.status].label : 'No target']),
        ['Not linked to a person', '', '', ds.salesKpi.unlinked.total.toFixed(2), '', ''],
        [],
        ['Teams (lead + everyone below)'], ['Team Lead', 'People', 'Target (PHP)', 'Zoho sales with tax (PHP)', '% of target', 'Status'],
        ...ds.salesKpi.teams.map((t) => [t.name, t.people, t.target_php.toFixed(2), t.sales_php.toFixed(2), t.pct_of_target ?? '', t.status ? STATUS_META[t.status].label : 'No target']),
        [],
      ] : []),
      ['KPIs (SAMPLE — not tracked yet)'], ['Group', 'KPI', 'Actual', 'Target', 'Status'],
      ...sampleGroupsFor(ds).flatMap((g) => g.kpis.map((k) => [g.label, k.name, k.actual, k.target, STATUS_META[k.status].label])),
    ];
    const csv = lines.map((row) => row.map(esc).join(',')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `getmeds-overview-${ds.live ? 'LIVE' : 'SAMPLE'}-${ds.from}_to_${ds.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${ds.live ? 'live' : 'sample'} data as CSV`);
  };

  return (
    <>
      {ds.truncated && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-state-warning-light px-3 py-2 text-xs text-amber-800">
          This period has more than 5,000 orders, so only the first 5,000 are shown. Pick a shorter period.
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink-primary">Overview</h1>
          <p className="text-sm text-ink-secondary mt-1">Welcome back, {firstName} — here&apos;s how GetMeds is doing.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setShowTargets(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-ink-primary hover:bg-slate-50">
            <Target size={16} /> All targets
          </button>
          <button type="button" onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-ink-primary hover:bg-slate-50">
            <Upload size={16} /> Export
          </button>
          <button type="button" onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-getmeds-blue px-4 py-2 text-sm font-semibold text-white hover:bg-getmeds-blue-hover">
            <Plus size={16} /> Create account
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <StatCard title="Total Sales with Tax" period={totals.periodLabel} onOpen={() => setCardDetail('sales')}
          value={totals.zoho ? <Money value={totals.totalSales} /> : <span className="text-slate-300">—</span>}
          right={!totals.zoho ? <span className="text-red-600">Zoho unavailable</span>
            : totals.pctOfTarget != null ? <><span className="font-semibold text-getmeds-blue">{totals.pctOfTarget}%</span> of target</>
              : <>{pesoShort(totals.zoho.balance_due)} unpaid</>} />
        <StatCard title="Avg. Order Value" period={totals.periodLabel} onOpen={() => setCardDetail('aov')}
          value={<Money value={totals.aov} />}
          right={`${totals.count.toLocaleString('en-PH')} orders`} />
        <StatCard title="Total Orders" period={totals.periodLabel} onOpen={() => setCardDetail('orders')}
          value={totals.count.toLocaleString('en-PH')}
          right={totals.todayInRange ? <><span className="font-semibold text-getmeds-blue">+{totals.todayCount}</span> today</> : ''} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SalesActivity className="lg:col-span-2" ds={ds} total={totals.total} mode={mode} setMode={setMode} onBucket={setBucket} />
        {ds.live
          ? <LiveTargetPerformance k={ds.salesKpi} onSales={setSalesView} />
          : <TargetPerformance onGroup={setKpiGroup} />}
      </div>

      <CardDetailModal kind={cardDetail} ds={ds} totals={totals} onClose={() => setCardDetail(null)} />
      <KpiGroupModal group={kpiGroup} onClose={() => setKpiGroup(null)} />
      <SalesKpiModal view={salesView} k={ds.salesKpi} onClose={() => setSalesView(null)} />
      <AllTargetsModal isOpen={showTargets} onClose={() => setShowTargets(false)} ds={ds} totals={totals}
        onGroup={(g) => { setShowTargets(false); setKpiGroup(g); }} />
      <CreateAccountModal isOpen={showCreate} onClose={() => setShowCreate(false)} />
      <BucketOrdersModal bucket={bucket} ds={ds} mode={mode} onClose={() => setBucket(null)} />
    </>
  );
};

// ── Stat card ────────────────────────────────────────────────────────────
const StatCard = ({ title, value, right, period, onOpen }) => (
  <button type="button" onClick={onOpen}
    className="group text-left rounded-2xl border border-slate-200 bg-white shadow-sm hover:border-getmeds-blue-200 hover:shadow-md transition">
    <div className="px-6 pt-5 pb-4">
      <div className="flex items-start justify-between">
        <span className="font-semibold text-ink-primary">{title}</span>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-ink-primary group-hover:bg-getmeds-blue group-hover:text-white transition"
          aria-label={`Open ${title} details`}>
          <ArrowUpRight size={16} />
        </span>
      </div>
      <div className="mt-3 text-3xl sm:text-4xl font-semibold tracking-tight text-ink-primary">{value}</div>
    </div>
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-6 py-3 text-xs text-ink-secondary">
      <span>{period}</span>
      <span>{right}</span>
    </div>
  </button>
);

// ── Sales Activity chart ─────────────────────────────────────────────────
const AvgLabel = ({ viewBox, value }) => {
  if (!viewBox) return null;
  const text = `Avg. ${pesoShort(value)}`;
  const w = text.length * 6.4 + 14;
  return (
    <g>
      <rect x={viewBox.x - 4} y={viewBox.y - 10} width={w} height={20} rx={10} fill="#1E293B" />
      <text x={viewBox.x - 4 + w / 2} y={viewBox.y + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">{text}</text>
    </g>
  );
};

const ChartTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="rounded-lg bg-ink-primary px-3 py-2 text-xs text-white shadow-lg">
      <div className="font-semibold">{b.label}</div>
      <div>{peso(b.total)} · {b.orders} order{b.orders === 1 ? '' : 's'}</div>
      <div className="text-slate-300 mt-0.5">Click to see the orders</div>
    </div>
  );
};

const SalesActivity = ({ className = '', ds, total, mode, setMode, onBucket }) => {
  const buckets = useMemo(() => buildBuckets(ds, mode), [ds, mode]);
  const avg = buckets.length ? total / buckets.length : 0;
  const current = buckets.find((b) => b.current);
  const avgWord = { day: 'per day', week: 'per week', month: 'per month' }[mode];

  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-ink-primary">Sales Activity</div>
          <div className="mt-1 text-3xl sm:text-4xl font-semibold tracking-tight text-ink-primary"><Money value={total} /></div>
        </div>
        <div className="flex flex-col items-end gap-3">
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Group sales by"
            className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-ink-primary focus:outline-none focus:ring-2 focus:ring-getmeds-blue-200">
            <option value="day">By day</option>
            <option value="week">By week</option>
            <option value="month">By month</option>
          </select>
          <div className="flex items-center gap-4 text-xs text-ink-secondary">
            {current && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-getmeds-blue" />
                {mode === 'day' ? `Today · ${current.label}` : `Current ${mode}`} {pesoShort(current.total)}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-300" /> Others</span>
          </div>
        </div>
      </div>

      <div className="mt-4 h-[300px]">
        {total === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-secondary">No orders in this period.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buckets} margin={{ top: 10, right: 8, left: 0, bottom: 0 }} barCategoryGap={mode === 'day' ? '22%' : '35%'}>
              <defs>
                <pattern id="ovHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill="#EEF2F7" />
                  <line x1="0" y1="0" x2="0" y2="6" stroke="#D5DDE8" strokeWidth="2" />
                </pattern>
              </defs>
              <YAxis tickFormatter={(v) => (v === 0 ? '0' : pesoShort(v))} axisLine={false} tickLine={false}
                tick={{ fontSize: 11, fill: '#94A3B8' }} width={56} />
              <XAxis dataKey="tick" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }}
                interval={mode === 'day' ? 'preserveStartEnd' : 0} minTickGap={8} />
              <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(29,159,218,0.06)' }} />
              <Bar dataKey="total" radius={[12, 12, 12, 12]} minPointSize={4} isAnimationActive={false}
                onClick={(d) => onBucket(d?.payload || d)} className="cursor-pointer">
                {buckets.map((b) => <Cell key={b.key} fill={b.current ? '#1D9FDA' : 'url(#ovHatch)'} />)}
              </Bar>
              {/* Drawn after the bars so the "Avg." label sits on top of them. */}
              <ReferenceLine y={avg} stroke="#94A3B8" strokeDasharray="4 4" label={<AvgLabel value={avg} />} ifOverflow="extendDomain" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-secondary">
        Orders raised in the period, pending approval included. Dashed line: average {avgWord} ({pesoShort(avg)}). Click any bar to see its orders.
      </p>
    </div>
  );
};

// ── Target Performance gauge (sample KPIs) ───────────────────────────────
const Gauge = ({ pct }) => {
  const r = 110; const cx = 140; const cy = 130; const w = 42;
  const pt = (a) => [cx + r * Math.cos(Math.PI - a), cy - r * Math.sin(Math.PI - a)];
  const arc = (from, to) => {
    const [x1, y1] = pt(from); const [x2, y2] = pt(to);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const split = Math.PI * pct;
  return (
    <svg viewBox="0 0 280 150" className="w-full max-w-[300px] mx-auto" role="img" aria-label={`${Math.round(pct * 100)}% of KPIs on target`}>
      <defs>
        <pattern id="ovGaugeHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" fill="#EEF2F7" />
          <line x1="0" y1="0" x2="0" y2="7" stroke="#D5DDE8" strokeWidth="2.5" />
        </pattern>
      </defs>
      <path d={arc(split, Math.PI)} stroke="url(#ovGaugeHatch)" strokeWidth={w} fill="none" />
      <path d={arc(0, split)} stroke="#1D9FDA" strokeWidth={w} fill="none" />
    </svg>
  );
};

const TargetPerformance = ({ onGroup }) => {
  const all = KPI_GROUPS.flatMap((g) => g.kpis);
  const on = all.filter((k) => k.status === 'on').length;
  const pct = on / all.length;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink-primary">Target Performance</span>
        <SamplePill />
      </div>
      <div className="relative mt-4">
        <Gauge pct={pct} />
        <div className="absolute inset-x-0 bottom-0 text-center">
          <div className="text-4xl font-bold text-ink-primary">{Math.round(pct * 100)}%</div>
          <div className="text-sm text-ink-secondary">{on} of {all.length} KPIs on target</div>
        </div>
      </div>
      <div className="mt-4 space-y-1 text-xs text-ink-secondary">
        <div className="flex items-center gap-2"><span className="h-1.5 w-5 rounded-full bg-getmeds-blue" /> KPIs on target</div>
        <div className="flex items-center gap-2"><span className="h-1.5 w-5 rounded-full bg-slate-200" /> At risk or behind</div>
      </div>
      <div className="mt-4 border-t border-slate-100 pt-2">
        {KPI_GROUPS.map((g) => {
          const s = groupScore(g);
          return (
            <button key={g.key} type="button" onClick={() => onGroup(g)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-2.5 text-sm text-ink-primary hover:bg-slate-50">
              <span>{g.label}</span>
              <span className="flex items-center gap-1">
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}>{s.on}/{s.total}</span>
                <ChevronRight size={14} className="text-slate-300" />
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-ink-secondary">
        Example KPIs from the design. Department KPIs aren&apos;t tracked in the app yet.
      </p>
    </div>
  );
};

// ── Target Performance, live (Oct 14, 2026) ──────────────────────────────
// Zoho Total Sales with Tax vs the monthly targets on the Sales KPIs page
// (backend: buildSalesKpis in adminOverview.controller.js).
const chName = (n) => String(n).replace(/^RX · /, '').replace('HOSP', 'HOS').replace('TELESALES', 'Telesales');
const scoreCls = (on, total) => (!total ? 'bg-slate-50 text-ink-secondary border-slate-200'
  : on === total ? STATUS_META.on.cls : on * 2 >= total ? STATUS_META.risk.cls : STATUS_META.behind.cls);

const LiveTargetPerformance = ({ k, onSales }) => {
  const ok = k && k.available;
  const pct = ok && k.total.pct_of_target != null ? k.total.pct_of_target : null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink-primary">Target Performance</span>
        {ok && k.total.status && <StatusPill status={k.total.status} />}
      </div>
      <div className="relative mt-4">
        <Gauge pct={pct == null ? 0 : Math.min(1, pct / 100)} />
        <div className="absolute inset-x-0 bottom-0 text-center">
          <div className="text-4xl font-bold text-ink-primary">{pct == null ? '—' : `${pct}%`}</div>
          <div className="text-sm text-ink-secondary">of this month&apos;s sales target</div>
        </div>
      </div>
      {ok ? (
        <div className="mt-4 space-y-1 text-xs text-ink-secondary">
          <div className="flex justify-between gap-2"><span>Zoho sales with tax</span><span className="tabular-nums text-ink-primary">{peso(k.total.sales_php, 0)}</span></div>
          <div className="flex justify-between gap-2"><span>Target</span><span className="tabular-nums text-ink-primary">{k.total.target_php ? peso(k.total.target_php, 0) : 'Not set'}</span></div>
          <div className="flex justify-between gap-2"><span>Pace for today</span><span className="tabular-nums text-ink-primary">{k.pace}% of the month</span></div>
        </div>
      ) : (
        <div className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-state-warning-light px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{k ? k.reason : 'Sales KPIs are not available.'}</span>
        </div>
      )}
      <div className="mt-4 border-t border-slate-100 pt-2">
        <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
          <span>By sales channel</span>{ok && <span>{k.counts.channels_on_pace} of {k.counts.channels_with_target} on pace</span>}
        </div>
        {ok ? k.channels.map((c) => (
          <button key={c.channel} type="button" onClick={() => onSales(`channel:${c.channel}`)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-sm text-ink-primary hover:bg-slate-50">
            <span className="min-w-0 text-left">
              <span className="block truncate">{chName(c.channel)}</span>
              <span className="block text-[11px] text-ink-secondary tabular-nums">{pesoShort(c.sales_php)}{c.target_php ? ` of ${pesoShort(c.target_php)}` : ' · no target'}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="text-xs font-semibold tabular-nums">{c.pct_of_target != null ? `${c.pct_of_target}%` : '—'}</span>
              {c.status ? <StatusPill status={c.status} /> : null}
              <ChevronRight size={14} className="text-slate-300" />
            </span>
          </button>
        )) : <p className="px-2 py-2 text-xs text-ink-secondary">Channels show once Zoho sales can be read.</p>}
      </div>
      {ok && (
        <div className="mt-2 flex gap-3 px-2 text-xs">
          <button type="button" onClick={() => onSales('people')} className="font-semibold text-getmeds-blue hover:underline">All salespeople ({k.counts.on_pace}/{k.counts.people_with_target} on pace)</button>
          <button type="button" onClick={() => onSales('teams')} className="font-semibold text-getmeds-blue hover:underline">Team leads ({k.counts.teams_on_pace}/{k.counts.teams_with_target})</button>
        </div>
      )}
      <p className="mt-3 text-[11px] leading-snug text-ink-secondary">
        Zoho Total Sales with Tax against the targets on the Sales KPIs page, by the channel of each salesperson&apos;s territory. On target means at or above today&apos;s pace.
      </p>
    </div>
  );
};

const SalesKpiModal = ({ view, k, onClose }) => {
  if (!view || !k || !k.available) return null;
  const teams = view === 'teams';
  const channel = view.startsWith('channel:') ? view.slice(8) : null;
  const ch = channel ? k.channels.find((x) => x.channel === channel) : null;
  const rows = teams ? k.teams : channel ? k.people.filter((p) => p.channel === channel) : k.people;
  const c = k.counts;
  return (
    <Modal isOpen onClose={onClose} className="sm:!max-w-4xl"
      title={teams ? `Team Leads — ${c.teams_on_pace} of ${c.teams_with_target} teams on pace`
        : ch ? `${chName(channel)} — ${ch.pct_of_target != null ? `${ch.pct_of_target}% of target` : 'no target'}`
          : `Sales — ${c.on_pace} of ${c.people_with_target} people on pace`}>
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
        <LivePill /> Zoho Total Sales with Tax (invoices minus credit notes) vs this month&apos;s target. Pace for the period: {k.pace}% of the month.
        {ch && <> {peso(ch.sales_php)} of {ch.target_php ? peso(ch.target_php, 0) : 'no target'}, {ch.people} people.{ch.not_linked_php ? ` Includes ${peso(ch.not_linked_php)} of this channel's Zoho sales not linked to a person.` : ''}</>}
        {!teams && !ch && <> {c.at_risk} at risk, {c.behind} behind, {c.zero_sales} with no sales yet.</>}
      </p>
      <div className="max-h-[55vh] overflow-auto thin-scroll rounded-xl border border-slate-100">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-50">
            <tr><Th>{teams ? 'Team Lead' : 'Person'}</Th><Th>{teams ? 'People' : 'Team Lead'}</Th><Th>Target</Th><Th>Zoho sales</Th><Th>% of target</Th><Th>Status</Th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.user_id}>
                <Td strong>{r.name}{r.title ? <span className="ml-1 text-xs font-normal text-ink-secondary">· {r.title}</span> : null}</Td>
                <Td>{teams ? r.people : (r.team_lead || '—')}</Td>
                <Td>{r.target_php ? peso(r.target_php, 0) : 'Not set'}</Td>
                <Td>{peso(r.sales_php)}</Td>
                <Td>{r.pct_of_target != null ? `${r.pct_of_target}%` : '—'}</Td>
                <Td>{r.status ? <StatusPill status={r.status} /> : <span className="text-xs text-ink-secondary">No target</span>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {teams ? (
        <p className="mt-3 text-xs text-ink-secondary">A team is the Team Lead plus everyone below them, so a Manager&apos;s team includes their Leaders&apos; teams. Rows overlap and don&apos;t add up.</p>
      ) : (
        <div className="mt-3 text-xs text-ink-secondary">
          <p>Each invoice goes to the owner of its app order (by Sales Order number; {c.invoices_via_sales_order} of {c.invoices} invoices). Otherwise it goes to the account whose Zoho salesperson it carries. Credit notes come off by salesperson.</p>
          {!ch && k.unlinked.rows.length > 0 && (
            <p className="mt-1">
              <span className="font-semibold text-ink-primary">Not linked to a person: {peso(k.unlinked.total)}</span> —{' '}
              {k.unlinked.rows.map((r) => `${r.salesperson} ${peso(r.total, 0)}`).join(' · ')}. Raised directly in Zoho, or the salesperson is shared with no single primary account.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};

// ── Shared table bits ────────────────────────────────────────────────────
const Th = ({ children, right }) => (
  <th className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-secondary ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);
const Td = ({ children, right, strong }) => (
  <td className={`px-3 py-2 whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${strong ? 'font-semibold text-ink-primary' : 'text-ink-primary'}`}>{children}</td>
);
const Section = ({ title, children }) => (
  <div className="mb-5">
    <h4 className="mb-2 text-sm font-semibold text-ink-primary">{title}</h4>
    <div className="overflow-x-auto thin-scroll rounded-xl border border-slate-100">{children}</div>
  </div>
);
const Empty = () => <p className="p-4 text-sm text-ink-secondary">No orders.</p>;

function groupBy(rows, key, label = (v) => v) {
  const m = new Map();
  rows.forEach((r) => {
    const name = label(r[key]) || '—';
    const g = m.get(name) || { name, orders: 0, amount: 0 };
    g.orders += 1; g.amount += Number(r.amount) || 0; m.set(name, g);
  });
  return [...m.values()].sort((a, b) => b.amount - a.amount || b.orders - a.orders);
}

const BreakdownTable = ({ rows, label, total, showAvg }) => (
  rows.length ? (
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50"><tr><Th>{label}</Th><Th right>Orders</Th><Th right>{showAvg ? 'Avg. order' : 'Amount'}</Th><Th right>Share</Th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.name}>
            <Td strong>{r.name}</Td><Td right>{r.orders}</Td>
            <Td right>{showAvg ? peso(r.amount / r.orders) : peso(r.amount)}</Td>
            <Td right>{total ? Math.round((r.amount / total) * 100) : 0}%</Td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : <Empty />
);

const OrdersTable = ({ rows, dateLabel = 'Date', limit = 200 }) => (
  rows.length ? (
    <>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50"><tr><Th>Order</Th><Th>{dateLabel}</Th><Th>Customer</Th><Th>Salesperson</Th><Th>Status</Th><Th right>Amount</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.slice(0, limit).map((o) => (
            <tr key={o.id}>
              <Td strong>{o.ref}</Td><Td>{fmtDay(o.date)}</Td><Td>{o.customer}</Td><Td>{o.salesperson}</Td>
              <Td><span className={`text-xs font-semibold ${isPendingApproval(o.status) ? 'text-amber-700' : 'text-ink-secondary'}`}>{statusLabel(o.status)}</span></Td>
              <Td right>{peso(o.amount)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <p className="px-3 py-2 text-xs text-ink-secondary">Showing {limit} of {rows.length}. Export for the full list.</p>}
    </>
  ) : <Empty />
);

// ── Card drill-down ──────────────────────────────────────────────────────
const CardDetailModal = ({ kind, ds, totals, onClose }) => {
  if (!kind) return null;
  let title; let body;
  if (kind === 'sales') {
    title = ds.live ? 'Total Sales with Tax — from Zoho' : 'Total Sales with Tax (sample)';
    const z = totals.zoho;
    const diff = z ? z.total_sales_with_tax - totals.booked : 0;
    body = !z ? (
      <div className="rounded-lg border border-red-200 bg-state-error-light p-3 text-sm text-red-800">
        {ds.zoho?.error || 'Zoho totals were not returned.'} The other cards still use the app&apos;s own orders.
      </div>
    ) : (
      <>
        <div className="mb-4 grid grid-cols-1 gap-x-6 gap-y-1 rounded-xl border border-slate-100 p-4 text-sm sm:grid-cols-2">
          <div className="flex justify-between"><span className="text-ink-secondary">Invoices dated {totals.periodLabel} ({z.invoice_count})</span><span className="tabular-nums">{peso(z.invoice_total)}</span></div>
          <div className="flex justify-between"><span className="text-ink-secondary">Balance due on them</span><span className="tabular-nums">{peso(z.balance_due)}</span></div>
          <div className="flex justify-between"><span className="text-ink-secondary">Less credit notes ({z.credit_note_count})</span><span className="tabular-nums">−{peso(z.credit_note_total)}</span></div>
          <div className="flex justify-between"><span className="text-ink-secondary">Monthly target</span><span className="tabular-nums">{ds.target ? `${peso(ds.target, 0)} (${totals.pctOfTarget}%)` : ds.multiMonth ? 'Pick one month' : 'Not set'}</span></div>
          <div className="flex justify-between border-t border-slate-100 pt-1 font-semibold"><span>Total sales with tax</span><span className="tabular-nums">{peso(z.total_sales_with_tax)}</span></div>
        </div>
        <p className="mb-4 text-xs text-ink-secondary">
          Same rule as Zoho&apos;s Sales by Salesperson report (&quot;Total Sales with Tax&quot; and &quot;Balance Due&quot;). Draft and void invoices are left out.
          {ds.live && z.fetchedAt ? ` Read from Zoho at ${new Date(z.fetchedAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}${z.cached ? ' (kept up to 5 minutes; Refresh re-reads)' : ''}.` : ''}
        </p>
        {z.warning && <p className="mb-4 rounded-lg border border-amber-200 bg-state-warning-light px-3 py-2 text-xs text-amber-800">{z.warning}</p>}
        {z.truncated && <p className="mb-4 rounded-lg border border-amber-200 bg-state-warning-light px-3 py-2 text-xs text-amber-800">Zoho returned more than 6,000 records, so the total may be incomplete. Pick a shorter period.</p>}
        <Section title="By salesperson">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><Th>Salesperson</Th><Th right>Invoices</Th><Th right>Invoice sales with tax</Th><Th right>Credit notes</Th><Th right>Total sales with tax</Th><Th right>Balance due</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {z.by_salesperson.map((r) => (
                <tr key={r.name}><Td strong>{r.name}</Td><Td right>{r.invoices}</Td><Td right>{peso(r.invoice_total)}</Td>
                  <Td right>{r.credit_total ? `−${peso(r.credit_total)}` : '—'}</Td><Td right>{peso(r.total)}</Td><Td right>{peso(r.balance)}</Td></tr>
              ))}
              <tr className="bg-slate-50 font-semibold"><Td strong>Total</Td><Td right>{z.invoice_count}</Td><Td right>{peso(z.invoice_total)}</Td>
                <Td right>{z.credit_note_total ? `−${peso(z.credit_note_total)}` : '—'}</Td><Td right>{peso(z.total_sales_with_tax)}</Td><Td right>{peso(z.balance_due)}</Td></tr>
            </tbody>
          </table>
        </Section>
        {z.credit_notes.length > 0 && (
          <Section title="Credit notes">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50"><tr><Th>Credit note</Th><Th>Date</Th><Th>Customer</Th><Th>Salesperson</Th><Th right>Amount</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {z.credit_notes.map((c) => <tr key={c.number}><Td strong>{c.number}</Td><Td>{fmtDay(c.date)}</Td><Td>{c.customer}</Td><Td>{c.salesperson}</Td><Td right>{peso(c.total)}</Td></tr>)}
              </tbody>
            </table>
          </Section>
        )}
        <Section title="Compared with the app">
          <div className="p-4 text-sm text-ink-secondary">
            Finance verified {ds.booked.length} orders worth {peso(totals.booked)} in the app in this period, {peso(Math.abs(diff))} {diff >= 0 ? 'less' : 'more'} than
            Zoho&apos;s total sales. The two count different things: Zoho counts invoices by invoice date and takes off credit notes;
            the app counts orders by the day Finance verified them, and leaves out sales made directly in Zoho.
          </div>
        </Section>
      </>
    );
  } else if (kind === 'aov') {
    title = 'Avg. Order Value — breakdown';
    body = (
      <>
        <p className="mb-4 text-sm text-ink-secondary">
          {peso(totals.total)} across {totals.count} orders raised in {totals.periodLabel} (pending included) = {peso(totals.aov)} per order.
        </p>
        <Section title="By division"><BreakdownTable rows={groupBy(ds.orders, 'division')} label="Division" total={totals.total} showAvg /></Section>
        <Section title="By salesperson (top 10)"><BreakdownTable rows={groupBy(ds.orders, 'salesperson').slice(0, 10)} label="Salesperson" total={totals.total} showAvg /></Section>
        <Section title="Largest orders"><OrdersTable rows={[...ds.orders].sort((a, b) => b.amount - a.amount).slice(0, 10)} /></Section>
      </>
    );
  } else {
    title = 'Total Orders — breakdown';
    const todayRows = ds.orders.filter((o) => o.date === ds.today);
    body = (
      <>
        <p className="mb-4 text-sm text-ink-secondary">
          {totals.count} orders raised in {totals.periodLabel}{totals.todayInRange ? `; ${totals.todayCount} of them today (${fmtDay(ds.today)})` : ''}.
        </p>
        <Section title="By status"><BreakdownTable rows={groupBy(ds.orders, 'status', statusLabel)} label="Status" total={totals.total} /></Section>
        <Section title="By division"><BreakdownTable rows={groupBy(ds.orders, 'division')} label="Division" total={totals.total} /></Section>
        {totals.todayInRange && <Section title={`Today's orders (${fmtDay(ds.today)})`}><OrdersTable rows={todayRows} /></Section>}
      </>
    );
  }
  return <Modal isOpen onClose={onClose} title={title} className="sm:!max-w-3xl">{body}</Modal>;
};

// ── KPI group drill-down (sample) ────────────────────────────────────────
const KpiTable = ({ kpis }) => (
  <table className="min-w-full text-sm">
    <thead className="bg-slate-50"><tr><Th>KPI</Th><Th>Actual</Th><Th>Target</Th><Th>Status</Th></tr></thead>
    <tbody className="divide-y divide-slate-100">
      {kpis.map((k) => (
        <tr key={k.name}><Td strong>{k.name}</Td><Td>{k.actual}</Td><Td>{k.target}</Td><Td><StatusPill status={k.status} /></Td></tr>
      ))}
    </tbody>
  </table>
);

const KpiGroupModal = ({ group, onClose }) => {
  if (!group) return null;
  const s = groupScore(group);
  return (
    <Modal isOpen onClose={onClose} title={`${group.label} KPIs — ${s.on} of ${s.total} on target`} className="sm:!max-w-2xl">
      <p className="mb-3 flex items-center gap-2 text-sm text-ink-secondary"><SamplePill /> Example figures from the design. Owner: {group.owner}.</p>
      <div className="overflow-x-auto thin-scroll rounded-xl border border-slate-100"><KpiTable kpis={group.kpis} /></div>
    </Modal>
  );
};

const AllTargetsModal = ({ isOpen, onClose, onGroup, ds, totals }) => {
  const [filter, setFilter] = useState('all');
  if (!isOpen) return null;
  const filters = [['all', 'All'], ['on', 'On target'], ['risk', 'At risk'], ['behind', 'Behind']];
  const allKpis = sampleGroupsFor(ds).flatMap((g) => g.kpis);
  return (
    <Modal isOpen onClose={onClose} title="All targets" className="sm:!max-w-3xl">
      <div className="mb-5 rounded-xl border border-slate-100 p-4 text-sm">
        <div className="mb-1 flex items-center gap-2 font-semibold text-ink-primary">
          Sales target vs Total Sales with Tax {ds.live ? <span className="rounded-full border border-pharmacy-green-200 bg-state-success-light px-2 py-0.5 text-[11px] text-pharmacy-green-700">Live</span> : <SamplePill />}
        </div>
        {ds.target ? (
          <>
            <div className="text-ink-secondary">{totals.zoho ? `${peso(totals.totalSales)} total sales with tax` : 'Total sales with tax unavailable'} of {peso(ds.target, 0)}{totals.pctOfTarget != null && <> — <span className="font-semibold text-getmeds-blue">{totals.pctOfTarget}%</span></>}</div>
            <div className="mt-2 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-getmeds-blue" style={{ width: `${Math.min(100, totals.pctOfTarget || 0)}%` }} /></div>
          </>
        ) : <div className="text-ink-secondary">{ds.multiMonth ? 'This period spans two months. Pick This month or Last month to compare with the monthly target.' : 'No monthly targets are set for this period. Set them on the Sales KPIs page.'}</div>}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SamplePill />
        {filters.map(([key, label]) => {
          const n = key === 'all' ? allKpis.length : allKpis.filter((k) => k.status === key).length;
          return (
            <button key={key} type="button" onClick={() => setFilter(key)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${filter === key ? 'border-getmeds-blue bg-getmeds-blue text-white' : 'border-slate-200 bg-white text-ink-primary hover:bg-slate-50'}`}>
              {label} ({n})
            </button>
          );
        })}
      </div>
      {sampleGroupsFor(ds).map((g) => {
        const kpis = filter === 'all' ? g.kpis : g.kpis.filter((k) => k.status === filter);
        if (!kpis.length) return null;
        const s = groupScore(g);
        return (
          <div key={g.key} className="mb-5">
            <button type="button" onClick={() => onGroup(g)} className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-primary hover:text-getmeds-blue">
              {g.label} <span className={`rounded-full border px-2 py-0.5 text-xs ${s.cls}`}>{s.on}/{s.total}</span>
              <ChevronRight size={14} />
            </button>
            <div className="overflow-x-auto thin-scroll rounded-xl border border-slate-100"><KpiTable kpis={kpis} /></div>
          </div>
        );
      })}
    </Modal>
  );
};

// ── Chart bar drill-down ─────────────────────────────────────────────────
const BucketOrdersModal = ({ bucket, ds, mode, onClose }) => {
  if (!bucket) return null;
  const rows = ds.orders.filter((o) => o.date >= bucket.from && o.date <= bucket.to);
  const bookedRows = ds.booked.filter((o) => o.date >= bucket.from && o.date <= bucket.to);
  const range = bucket.from === bucket.to ? fmtDay(bucket.from) : `${fmtDay(bucket.from)} – ${fmtDay(bucket.to)}`;
  return (
    <Modal isOpen onClose={onClose} title={`${mode === 'day' ? fmtDay(bucket.from) : bucket.label} — ${rows.length} orders`} className="sm:!max-w-3xl">
      <p className="mb-3 text-sm text-ink-secondary">
        {range}: {peso(sum(rows))} raised. Finance verified {bookedRows.length} order{bookedRows.length === 1 ? '' : 's'} worth {peso(sum(bookedRows))} in the same days.
      </p>
      <div className="overflow-x-auto thin-scroll rounded-xl border border-slate-100"><OrdersTable rows={rows} /></div>
    </Modal>
  );
};

// ── Create account (never creates anything on this page) ─────────────────
const EMPTY = { name: '', email: '', role: 'medrep', team: TEAM_OPTIONS[0] };
const CreateAccountModal = ({ isOpen, onClose }) => {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState(null);
  if (!isOpen) return null;
  const needsTeam = form.role === 'medrep' || form.role === 'team_lead';
  const close = () => { setForm(EMPTY); setErrors({}); setDone(null); onClose(); };
  const submit = (e) => {
    e.preventDefault();
    const err = {};
    if (!form.name.trim()) err.name = 'Enter a name';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) err.email = 'Enter a valid email';
    setErrors(err);
    if (Object.keys(err).length) return;
    setDone({ ...form, team: needsTeam ? form.team : '—' });
    toast('Preview only — no account was created', { icon: '🧪' });
  };
  const input = 'mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue-200';
  return (
    <Modal isOpen onClose={close} title="Create account">
      {done ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-amber-200 bg-state-warning-light p-3 text-amber-800">
            This page is a preview, so nothing was saved. To create a real account, use{' '}
            <Link to="/admin/users" className="font-semibold underline">User Management</Link>. It would create:
          </div>
          <dl className="grid grid-cols-3 gap-y-1">
            <dt className="text-ink-secondary">Name</dt><dd className="col-span-2 font-semibold">{done.name}</dd>
            <dt className="text-ink-secondary">Email</dt><dd className="col-span-2">{done.email}</dd>
            <dt className="text-ink-secondary">Role</dt><dd className="col-span-2">{ROLE_OPTIONS.find((r) => r.value === done.role)?.label}</dd>
            <dt className="text-ink-secondary">Team</dt><dd className="col-span-2">{done.team}</dd>
          </dl>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => { setForm(EMPTY); setDone(null); }} className="rounded-lg border border-slate-200 px-4 py-2 font-semibold hover:bg-slate-50">Add another</button>
            <button type="button" onClick={close} className="rounded-lg bg-getmeds-blue px-4 py-2 font-semibold text-white hover:bg-getmeds-blue-hover">Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3 text-sm" noValidate>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-secondary">
            Preview of the new form — nothing is saved here. Real accounts: <Link to="/admin/users" className="font-semibold text-getmeds-blue hover:underline">User Management</Link>.
          </p>
          <label className="block font-medium text-ink-primary">Full name
            <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            {errors.name && <span className="text-xs text-red-600">{errors.name}</span>}
          </label>
          <label className="block font-medium text-ink-primary">Email
            <input type="email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            {errors.email && <span className="text-xs text-red-600">{errors.email}</span>}
          </label>
          <label className="block font-medium text-ink-primary">Role
            <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          {needsTeam && (
            <label className="block font-medium text-ink-primary">Team
              <select className={input} value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })}>
                {TEAM_OPTIONS.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={close} className="rounded-lg border border-slate-200 px-4 py-2 font-semibold hover:bg-slate-50">Cancel</button>
            <button type="submit" className="rounded-lg bg-getmeds-blue px-4 py-2 font-semibold text-white hover:bg-getmeds-blue-hover">Create account</button>
          </div>
        </form>
      )}
    </Modal>
  );
};

export default AdminOverviewMockPage;
