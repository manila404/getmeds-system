import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays, Wallet, Truck, PackageCheck, AlertTriangle, Timer, RefreshCw,
  Search, Download, ChevronLeft, ChevronRight, X, Hourglass
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { formatPHT } from '../../utils/dateUtils';
import { formatHours } from '../../utils/formatDuration';
import { useSyncJobs } from '../../context/SyncJobsContext';
import { fetchZohoImportStatus } from '../../api/queries';
import StockAnnouncementsBanner from '../../components/stock/StockAnnouncements';
import OrderStatusBadge, { statusStyles } from '../../components/ui/OrderStatusBadge';
import Skeleton from '../../components/ui/Skeleton';
import KpiCard, { KpiCardSkeleton } from '../../components/dashboard/KpiCard';
import ActionNeededStrip, { ActionNeededSkeleton } from '../../components/dashboard/ActionNeededStrip';
import ZohoSyncStatus from '../../components/dashboard/ZohoSyncStatus';
import RecentActivity from '../../components/dashboard/RecentActivity';

/**
 * Sep 24, 2026: the Management/Admin dashboard, restructured.
 *
 * Top to bottom: what needs attention (Action Needed) → how operations are
 * doing (clickable KPIs) → the orders themselves, with stock news and recent
 * activity alongside. Every filter — status, source, dates, rep, search, the
 * "stuck" view — lives in the URL, so a filtered view can be shared, bookmarked
 * and survives a refresh (they used to be component state, gone on reload).
 *
 * The dashboard defaults to NATIVE orders (raised in this app). The ~61,000
 * orders adopted from Zoho are history, dated by Zoho — mixed in they swamped
 * every count and made the processing-time average read 25,004h. They're one
 * click away under "Imported history" / "All".
 */

// Sep 9, 2026: the Orders table is paginated because the Zoho import made it
// unbounded — the live org has 65,000+ Sales Orders, and this page used to
// render every row the API returned.
const PAGE_SIZE = 25;

// What "Export CSV" will fetch at most. The API caps a page at 5,000 for the
// same reason the table is paginated; asking for more silently gets 5,000
// back, so the number is stated here rather than discovered.
const EXPORT_MAX = 5000;

const SOURCES = [
  { key: 'native', label: 'Current operations' },
  { key: 'imported', label: 'Imported history' },
  { key: 'all', label: 'All orders' }
];

/**
 * Sep 9, 2026: this column used to show the MedRep, and the Zoho import is
 * what made that wrong. An order adopted from Zoho has no MedRep — nobody here
 * raised it — so its medrep_id is the admin account that ran the import, and
 * the column read as one person against every imported order.
 *
 * The Salesperson is the thing that actually differs per order and that Zoho
 * knows about. The backend resolves it (COALESCE(o.salesperson, u.salesperson)
 * — see management.controller.js); this only handles the display.
 *
 * `salesperson` is stored as "<division> | <display name>" — the exact string
 * Zoho matches on — so the division prefix is dropped for reading. The name is
 * what identifies the person; the division is already the order's own field.
 * Falling back to the MedRep name covers an old local order raised before
 * sign-up collected a division, which has neither value to show.
 */
const salespersonOf = (order) => {
  const raw = order.salesperson_name;
  if (!raw) return order.medrep_name || '—';
  const parts = String(raw).split('|');
  return (parts.length > 1 ? parts.slice(1).join('|') : parts[0]).trim() || raw;
};

/**
 * Sep 10, 2026: who owns this order IN THIS SYSTEM, as opposed to what Zoho
 * recorded on it.
 *
 * An imported order still sitting with the admin who ran the import is not
 * really "assigned to Aaron Manila" in any meaningful sense — it is waiting to
 * be given to someone. Saying so is the difference between a table that looks
 * finished and one that shows what is left to do.
 */
const assignedTo = (order) => {
  const imported = String(order.getmeds_order_id || '').startsWith('ZOHO-');
  const role = (order.medrep_role || '').toLowerCase();
  if (imported && role && role !== 'medrep') return 'Unassigned';
  return order.medrep_name || '—';
};

const statusLabel = (s) => String(s || '').replace(/_/g, ' ');

const ManagementDashboardPage = () => {
  // Sep 21, 2026: this component is also mounted at /team-lead. That route is
  // read-only by design — see App.jsx's route comment — so the Zoho sync
  // controls (the only things on this page that write anything, even though
  // it's only local rows) are hidden for that role, and the heading reads as a
  // team view rather than a global one. The API already returns this
  // account's team instead of a division once the caller's role is 'team_lead'.
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const isTeamLead = role === 'team_lead';
  const isAdmin = role === 'admin';

  // ── Filters, held in the URL ────────────────────────────────────────────
  const [sp, setSp] = useSearchParams();
  const statusFilter = sp.get('status') || '';
  const source = SOURCES.some((s) => s.key === sp.get('source')) ? sp.get('source') : 'native';
  const dateFrom = sp.get('from') || '';
  const dateTo = sp.get('to') || '';
  // '' = everyone, a number = that rep, 'unassigned' = still with the admin
  // who ran the Zoho import.
  const medrepFilter = sp.get('medrep') || '';
  const staleHours = parseInt(sp.get('stale'), 10) || 0;
  const searchQ = sp.get('q') || '';
  const page = Math.max(1, parseInt(sp.get('page'), 10) || 1);

  // Every filter change resets to page 1 (unless it IS a page change) — narrowing
  // a filter while on page 12 would otherwise leave you on an empty page that
  // reads as "no results" rather than "past the end of a shorter list".
  const update = useCallback((changes, { replace = false } = {}) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(changes).forEach(([k, v]) => {
        if (v === '' || v == null || v === false) next.delete(k);
        else next.set(k, String(v));
      });
      if (!('page' in changes)) next.delete('page');
      return next;
    }, { replace });
  }, [setSp]);

  // Search is typed locally and written to the URL after a pause, so it doesn't
  // fire a request (or a history entry) per keystroke.
  const [searchInput, setSearchInput] = useState(searchQ);
  useEffect(() => { setSearchInput(searchQ); }, [searchQ]);
  useEffect(() => {
    if (searchInput.trim() === searchQ) return undefined;
    const t = setTimeout(() => update({ q: searchInput.trim() }, { replace: true }), 350);
    return () => clearTimeout(t);
  }, [searchInput, searchQ, update]);

  const tableRef = useRef(null);
  const scrollToTable = () => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const orderParams = () => {
    const p = new URLSearchParams();
    p.set('source', source);
    if (statusFilter) p.set('status', statusFilter);
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    if (medrepFilter === 'unassigned') p.set('unassigned', 'true');
    else if (medrepFilter) p.set('medrep_id', medrepFilter);
    if (searchQ) p.set('search', searchQ);
    if (staleHours) p.set('stale_hours', String(staleHours));
    return p;
  };

  // ── Zoho sync ───────────────────────────────────────────────────────────
  // Sep 9, 2026: the Sales Order import. The job itself is tracked above the
  // router (see context/SyncJobsContext.jsx) precisely so that navigating away
  // from this page mid-import does not abandon it — an import of several
  // hundred orders runs for minutes, far longer than anyone sits on one screen.
  const { startSync, jobFor, isRunning, isStarting } = useSyncJobs();
  const importJob = jobFor('salesorders');
  const importBusy = isRunning('salesorders') || isStarting;

  const { data: importStatusRes } = useQuery({
    queryKey: ['zoho-import-status'],
    queryFn: fetchZohoImportStatus,
    enabled: !isTeamLead
  });
  const importStatus = importStatusRes?.data || {};

  // ── Data ────────────────────────────────────────────────────────────────
  const { data: summaryRes, isLoading: loadingStats, refetch } = useQuery({
    queryKey: ['management-summary', source],
    queryFn: () => client.get(`/api/management/summary?source=${source}`).then((r) => r.data),
    refetchInterval: 60000
  });
  const stats = summaryRes?.data || {};
  const groups = stats.status_groups || {};

  const { data: ordersRes, isLoading: loadingOrders, isFetching: fetchingOrders } = useQuery({
    queryKey: ['management-orders', source, statusFilter, dateFrom, dateTo, medrepFilter, searchQ, staleHours, page],
    queryFn: () => {
      const p = orderParams();
      p.set('page', String(page));
      p.set('limit', String(PAGE_SIZE));
      return client.get(`/api/management/orders?${p}`).then((r) => r.data);
    },
    // Keeps the previous page on screen while the next one loads, instead of
    // blanking the table on every page click.
    placeholderData: (prev) => prev
  });
  const orders = ordersRes?.data?.orders || [];
  const pagination = ordersRes?.data?.pagination || { total: 0, page: 1, pages: 1 };
  const hasFilters = !!(statusFilter || dateFrom || dateTo || medrepFilter || searchQ || staleHours);

  // The reps to filter by. Same endpoint the order form's "create this order
  // for" picker uses — enabled for management and admin, empty for anyone else.
  const { data: medrepsRes } = useQuery({
    queryKey: ['medrep-options'],
    queryFn: () => client.get('/api/orders/meta/medreps').then((r) => r.data)
  });
  const medrepOptions = medrepsRes?.data?.medreps || [];

  const clearFilters = () => {
    setSearchInput('');
    setSp((prev) => {
      const next = new URLSearchParams();
      if (prev.get('source')) next.set('source', prev.get('source'));
      return next;
    });
  };

  // ── KPI cards → filters ────────────────────────────────────────────────
  // A card filters the table to the SAME status list it counted (the API sends
  // it back as status_groups), so the number on the card and the total above
  // the table can't disagree. Clicking the active card again clears it.
  const groupKey = (key) => (groups[key] || []).join(',');
  const isGroupActive = (key) => !!groups[key] && statusFilter === groupKey(key) && !staleHours;
  const toggleGroup = (key) => {
    if (!groups[key]) return;
    update({ status: isGroupActive(key) ? '' : groupKey(key), stale: '' });
    if (!isGroupActive(key)) scrollToTable();
  };

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayActive = dateFrom === todayIso && dateTo === todayIso;
  const toggleToday = () => {
    update(todayActive ? { from: '', to: '' } : { from: todayIso, to: todayIso });
    if (!todayActive) scrollToTable();
  };

  const showStale = () => {
    // "Stuck" is defined for native orders only (see getSummary), so this also
    // returns the view to the default source.
    update({ stale: stats.action_needed?.stale_hours || 48, status: '', source: '' });
    scrollToTable();
  };

  const processing = (() => {
    if (source === 'imported') return { value: '—', sub: 'Not tracked for imported orders', hint: undefined };
    if (stats.median_processing_time_hours == null) return { value: '—', sub: 'No completed orders yet', hint: undefined };
    return {
      value: formatHours(stats.median_processing_time_hours),
      sub: 'Median · submit → last update',
      hint:
        `Median of ${(stats.processing_sample_size || 0).toLocaleString()} orders raised in this app. ` +
        `Average: ${formatHours(stats.avg_processing_time_hours)} (a few slow orders pull it above the typical case). ` +
        `Orders imported from Zoho are excluded — their dates come from Zoho, not this app.`
    };
  })();

  const kpis = [
    { key: 'today', title: 'Orders Today', value: (stats.orders_today || 0).toLocaleString(), sub: `${(stats.orders_this_week || 0).toLocaleString()} this week`, icon: CalendarDays, tone: 'blue', active: todayActive, onClick: toggleToday, hint: 'Show orders created today' },
    { key: 'pending_payment', title: 'Pending Payment', value: (stats.pending_payment_count || 0).toLocaleString(), sub: 'Invoiced, awaiting payment', icon: Wallet, tone: 'warning', active: isGroupActive('pending_payment'), onClick: () => toggleGroup('pending_payment') },
    { key: 'ready_dispatch', title: 'Ready for Dispatch', value: (stats.ready_dispatch_count || 0).toLocaleString(), sub: 'Packing or awaiting pickup', icon: Truck, tone: 'blue', active: isGroupActive('ready_dispatch'), onClick: () => toggleGroup('ready_dispatch') },
    { key: 'in_transit', title: 'In Transit', value: (stats.dispatched_count || 0).toLocaleString(), sub: 'Dispatched, not yet completed', icon: PackageCheck, tone: 'success', active: isGroupActive('in_transit'), onClick: () => toggleGroup('in_transit') },
    { key: 'exceptions', title: 'Exceptions / On Hold', value: (stats.exception_count || 0).toLocaleString(), sub: 'Held, failed or cancelled', icon: AlertTriangle, tone: 'danger', active: isGroupActive('exceptions'), onClick: () => toggleGroup('exceptions') },
    { key: 'processing', title: 'Processing Time', value: processing.value, sub: processing.sub, icon: Timer, tone: 'neutral', hint: processing.hint }
  ];

  // ── Export ──────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);

  /**
   * Export every order matching the CURRENT filters, not the 25 on screen.
   *
   * Sep 9, 2026: this used to export `orders`, which was the whole result set
   * back when the API returned everything. Now that the table is paginated,
   * exporting `orders` would quietly hand over one page and call it the
   * orders export — so it re-fetches with a large page size instead.
   */
  const downloadCSV = async () => {
    setExporting(true);
    try {
      const p = orderParams();
      p.set('page', '1');
      p.set('limit', String(EXPORT_MAX));
      const res = await client.get(`/api/management/orders?${p}`);
      const all = res.data?.data?.orders || [];
      const total = res.data?.data?.pagination?.total ?? all.length;

      const headers = ['Order ID', 'Customer', 'Salesperson', 'Assigned To', 'Status', 'Total', 'Payment', 'Created'];
      // Quote every field: customer names contain commas, and an unquoted one
      // silently shifts every later column in that row.
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = all.map((o) => [
        o.getmeds_order_id, o.customer_name, salespersonOf(o), assignedTo(o), o.status,
        o.total_amount, o.payment_status || '', o.created_at
      ]);
      const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'getmeds_orders.csv';
      a.click();
      URL.revokeObjectURL(url);

      if (total > all.length) {
        toast(`Exported the first ${all.length.toLocaleString()} of ${total.toLocaleString()} matching orders — narrow the date range to export the rest.`, { icon: '⚠️', duration: 8000 });
      }
    } catch (err) {
      toast.error('Could not build the export — please try again.');
    } finally {
      setExporting(false);
    }
  };

  const statusPills = Object.entries(stats.orders_by_status || {})
    .map(([s, c]) => ({ status: s, count: c }))
    .sort((a, b) => b.count - a.count);

  const inputCls = 'px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs text-ink-primary bg-white focus:outline-none focus:ring-2 focus:ring-getmeds-blue/40 focus:border-getmeds-blue';

  return (
    <div className="space-y-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary tracking-tight">
            {isTeamLead ? 'My Team' : 'Management Dashboard'}
          </h1>
          <p className="text-sm text-ink-secondary mt-1">
            {isTeamLead
              ? "Real-time overview of your team's orders and KPIs — view only."
              : 'Real-time overview of orders and KPIs.'}
          </p>
        </div>

        {!isTeamLead && (
          <ZohoSyncStatus
            importStatus={importStatus}
            importJob={importJob}
            importBusy={importBusy}
            failedSyncs={stats.action_needed?.failed_syncs ?? null}
            canViewHealth={isAdmin}
            onSync={(mode) => startSync('salesorders', mode)}
          />
        )}
      </div>

      {/* ── Needs attention ──────────────────────────────────────────────── */}
      {loadingStats ? (
        <ActionNeededSkeleton />
      ) : (
        <ActionNeededStrip data={stats.action_needed} isTeamLead={isTeamLead} onShowStale={showStale} />
      )}

      {/* ── Scope bar: what the numbers below are counting ──────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div role="tablist" aria-label="Which orders to show" className="inline-flex rounded-xl border border-slate-200 bg-slate-100/70 p-1 self-start">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={source === s.key}
              onClick={() => update({ source: s.key === 'native' ? '' : s.key, status: '', stale: '' })}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                source === s.key ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-lg text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary self-start sm:self-auto"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* ── KPIs ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {loadingStats
          ? [0, 1, 2, 3, 4, 5].map((i) => <KpiCardSkeleton key={i} />)
          : kpis.map(({ key, ...card }) => <KpiCard key={key} {...card} />)}
      </div>

      {/* ── Orders + side panel ──────────────────────────────────────────── */}
      <div className="grid gap-6 min-[1700px]:grid-cols-[minmax(0,1fr)_320px] items-start">
        <div className="space-y-4 min-w-0">
          {/* Orders by status — quick filters for the table below. */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink-primary">Orders by status</h2>
              <span className="text-[11px] text-ink-secondary">Click a status to filter the table</span>
            </div>
            {loadingStats ? (
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7 w-28 rounded-full" />)}
              </div>
            ) : statusPills.length === 0 ? (
              <p className="text-xs text-ink-secondary">No orders in this view.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {statusPills.map(({ status, count }) => {
                  const active = statusFilter === status && !staleHours;
                  return (
                    <button
                      key={status}
                      aria-pressed={active}
                      onClick={() => update({ status: active ? '' : status, stale: '' })}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all hover:shadow-sm ${
                        active ? 'ring-2 ring-getmeds-blue ring-offset-1' : ''
                      } ${statusStyles[status] || 'bg-slate-100 text-slate-700 border-slate-200'}`}
                    >
                      <span className="capitalize">{statusLabel(status)}</span>
                      <span className="font-bold tabular-nums">{count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Orders table */}
          <div ref={tableRef} className="bg-white shadow-sm rounded-xl overflow-hidden border border-slate-200 scroll-mt-4">
            <div className="px-4 py-3 border-b border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-ink-primary whitespace-nowrap">
                  Orders
                  <span className="ml-2 font-normal text-ink-secondary">{pagination.total.toLocaleString()} total</span>
                </h2>

                {statusFilter && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-getmeds-blue/10 px-2.5 py-0.5 text-[11px] font-semibold text-getmeds-blue-dark">
                    {statusFilter.includes(',') ? `${statusFilter.split(',').length} statuses` : statusLabel(statusFilter)}
                    <button aria-label="Clear status filter" onClick={() => update({ status: '' })}><X className="w-3 h-3" /></button>
                  </span>
                )}
                {staleHours > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-state-warning-light px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                    <Hourglass className="w-3 h-3" /> Stuck over {staleHours}h
                    <button aria-label="Clear stuck filter" onClick={() => update({ stale: '' })}><X className="w-3 h-3" /></button>
                  </span>
                )}

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {hasFilters && (
                    <button onClick={clearFilters} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-ink-secondary hover:text-ink-primary border border-slate-200 rounded-lg hover:bg-surface">
                      <X className="w-3 h-3" /> Clear filters
                    </button>
                  )}
                  <button
                    onClick={downloadCSV}
                    disabled={exporting}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg text-ink-secondary hover:bg-surface disabled:opacity-50"
                    title="Exports every order matching the current filters, not just this page"
                  >
                    <Download className="w-3.5 h-3.5" /> {exporting ? 'Preparing…' : 'Export CSV'}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search order ID, customer or SO number"
                    className={`${inputCls} pl-8 w-64`}
                  />
                </label>

                {/* Sep 10, 2026: "show me this rep's orders" — the only practical
                    way to CHECK that an Order Ownership assignment landed. */}
                <select
                  value={medrepFilter}
                  onChange={(e) => update({ medrep: e.target.value })}
                  className={inputCls}
                  title="Filter by the MedRep an order is assigned to"
                >
                  <option value="">All MedReps</option>
                  <option value="unassigned">Unassigned (still with the importer)</option>
                  {medrepOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.display_name || m.name}</option>
                  ))}
                </select>

                {/* Filters on the order's created date — the same value the Date
                    column shows — so what is filtered and what is read are the
                    same thing. */}
                <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                  From
                  <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => update({ from: e.target.value })} className={inputCls} />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                  To
                  <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => update({ to: e.target.value })} className={inputCls} />
                </label>
              </div>
            </div>

            {loadingOrders ? (
              <div className="p-4 space-y-2.5">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : orders.length === 0 ? (
              <div className="text-center py-14 px-4">
                <p className="text-sm font-semibold text-ink-primary">
                  {hasFilters ? 'No orders match these filters' : 'No orders here yet'}
                </p>
                <p className="text-xs text-ink-secondary mt-1">
                  {hasFilters
                    ? 'Try widening the date range or clearing a filter.'
                    : source === 'imported' ? 'Nothing has been imported from Zoho.' : 'Orders raised in this app will appear here.'}
                </p>
                {hasFilters && (
                  <button onClick={clearFilters} className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-getmeds-blue border border-getmeds-blue/30 rounded-lg hover:bg-getmeds-blue/5">
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 [&_th]:px-3 [&_td]:px-3">
                  <thead className="bg-surface">
                    <tr>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Order ID</th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Customer</th>
                      <th className="hidden min-[1900px]:table-cell px-4 py-3 text-left text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Salesperson</th>
                      {/* Sep 10, 2026: Salesperson is what ZOHO recorded; Assigned
                          To is who owns it HERE. Both are shown because they answer
                          different questions — the second is the one Order
                          Ownership changes. */}
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Assigned To</th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Status</th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Total</th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-ink-secondary uppercase tracking-wide">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {orders.map((order) => (
                      <tr key={order.id} className="hover:bg-surface transition-colors">
                        {/* Sep 24, 2026: the Order ID is the link to the order.
                            It replaced a separate "View" column, which crowded
                            the right edge of the table. */}
                        <td className="px-4 py-3 text-sm font-mono font-semibold whitespace-nowrap">
                          <Link
                            to={`/orders/${order.id}`}
                            className="text-getmeds-blue hover:text-getmeds-blue-dark hover:underline focus:outline-none focus-visible:underline"
                          >
                            {order.getmeds_order_id}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-ink-primary max-w-[10rem] min-[1500px]:max-w-[14rem] truncate" title={order.customer_name}>{order.customer_name}</td>
                        <td className="hidden min-[1900px]:table-cell px-4 py-3 text-sm text-ink-secondary whitespace-nowrap">{salespersonOf(order)}</td>
                        <td className="px-4 py-3 text-sm text-ink-secondary whitespace-nowrap">{assignedTo(order)}</td>
                        <td className="px-4 py-3 whitespace-nowrap"><OrderStatusBadge status={order.status} /></td>
                        <td className="px-4 py-3 text-sm font-semibold text-ink-primary text-right tabular-nums whitespace-nowrap">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                        <td className="px-4 py-3 text-xs text-ink-secondary whitespace-nowrap">{formatPHT(order.created_at, 'date')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pager. Rendered whenever there is more than one page — and outside
                the loading branch above, so it does not vanish and re-appear on
                every page click. */}
            {pagination.pages > 1 && (
              <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between gap-3">
                <p className="text-xs text-ink-secondary">
                  Showing{' '}
                  <span className="font-semibold text-ink-primary">
                    {((pagination.page - 1) * PAGE_SIZE + 1).toLocaleString()}–
                    {Math.min(pagination.page * PAGE_SIZE, pagination.total).toLocaleString()}
                  </span>{' '}
                  of {pagination.total.toLocaleString()}
                  {fetchingOrders && <span className="ml-2">updating…</span>}
                </p>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => update({ page: Math.max(1, page - 1) })}
                    disabled={pagination.page <= 1}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-200 rounded-lg text-ink-secondary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Previous
                  </button>
                  <span className="text-xs text-ink-secondary">
                    Page <span className="font-semibold text-ink-primary">{pagination.page.toLocaleString()}</span> of {pagination.pages.toLocaleString()}
                  </span>
                  <button
                    onClick={() => update({ page: Math.min(pagination.pages, page + 1) })}
                    disabled={pagination.page >= pagination.pages}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-200 rounded-lg text-ink-secondary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Side panel: stock news (was the full-width banner on top) + activity. */}
        <aside className="space-y-4 min-w-0">
          <StockAnnouncementsBanner variant="panel" />
          <RecentActivity />
        </aside>
      </div>
    </div>
  );
};

export default ManagementDashboardPage;
