import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ShoppingBag, Clock, Truck, CheckCircle, AlertTriangle, RefreshCw, Eye,
  DownloadCloud, Zap, ChevronLeft, ChevronRight, X
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import SyncProgressIndicator from '../../components/SyncProgressIndicator';
import { useSyncJobs } from '../../context/SyncJobsContext';
import { fetchZohoImportStatus } from '../../api/queries';

const STATUS_COLORS = {
  draft: 'bg-slate-100 text-slate-700 border border-slate-300',
  submitted: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  validating: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_pending: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_created: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  waiting_for_payment: 'bg-state-warning-light text-amber-950 border border-state-warning font-semibold',
  payment_verified: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30',
  ready_for_dispatch: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  picking_packing: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  dispatched: 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40',
  tracking_shared: 'bg-teal-50 text-teal-800 border border-teal-200',
  completed: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/40',
  on_hold: 'bg-state-error-light text-red-800 border border-state-error/30',
  exception: 'bg-state-error-light text-red-950 border border-state-error font-bold',
  cancelled: 'bg-state-error-light text-red-700 border border-state-error/30',
};

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

// Sep 9, 2026: the Orders table is paginated because the Zoho import made it
// unbounded — the live org has 65,000+ Sales Orders, and this page used to
// render every row the API returned.
const PAGE_SIZE = 25;

// What "Export CSV" will fetch at most. The API caps a page at 5,000 for the
// same reason the table is paginated; asking for more silently gets 5,000
// back, so the number is stated here rather than discovered.
const EXPORT_MAX = 5000;

const ManagementDashboardPage = () => {
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  // Every filter resets to page 1. Without this, narrowing a filter while on
  // page 12 leaves you on an empty page that looks like "no results" rather
  // than "you are past the end of a shorter list".
  const applyFilter = (fn) => (value) => { fn(value); setPage(1); };

  const orderParams = () => {
    const p = new URLSearchParams();
    if (statusFilter) p.set('status', statusFilter);
    if (dateFrom) p.set('date_from', dateFrom);
    if (dateTo) p.set('date_to', dateTo);
    return p;
  };

  // Sep 9, 2026: the Sales Order import. The job itself is tracked above the
  // router (see context/SyncJobsContext.jsx) precisely so that navigating away
  // from this page mid-import does not abandon it — an import of several
  // hundred orders runs for minutes, which is far longer than anyone will sit
  // on one screen.
  const { startSync, jobFor, isRunning, isStarting } = useSyncJobs();
  const importJob = jobFor('salesorders');
  const importBusy = isRunning('salesorders') || isStarting;

  const { data: importStatusRes } = useQuery({
    queryKey: ['zoho-import-status'],
    queryFn: fetchZohoImportStatus
  });
  const importStatus = importStatusRes?.data || {};

  const { data: summaryRes, isLoading: loadingStats, refetch } = useQuery({
    queryKey: ['management-summary'],
    queryFn: () => client.get('/api/management/summary').then(r => r.data),
    refetchInterval: 60000
  });
  const stats = summaryRes?.data || {};

  const { data: ordersRes, isLoading: loadingOrders, isFetching: fetchingOrders } = useQuery({
    queryKey: ['management-orders', statusFilter, dateFrom, dateTo, page],
    queryFn: () => {
      const p = orderParams();
      p.set('page', String(page));
      p.set('limit', String(PAGE_SIZE));
      return client.get(`/api/management/orders?${p}`).then(r => r.data);
    },
    // Sep 9, 2026: keeps the previous page on screen while the next one loads,
    // instead of blanking the table to a spinner on every page click.
    placeholderData: (prev) => prev
  });
  const orders = ordersRes?.data?.orders || [];
  const pagination = ordersRes?.data?.pagination || { total: 0, page: 1, pages: 1 };
  const hasFilters = !!(statusFilter || dateFrom || dateTo);

  const clearFilters = () => {
    setStatusFilter('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const statCards = [
    { title: 'Total Orders', value: stats.total_orders || 0, icon: ShoppingBag, color: 'blue', sub: `${stats.orders_today || 0} today` },
    { title: 'Pending Payment', value: stats.pending_payment_count || 0, icon: Clock, color: 'orange', sub: 'Awaiting Finance' },
    { title: 'Ready for Dispatch', value: stats.ready_dispatch_count || 0, icon: Truck, color: 'indigo', sub: 'In queue' },
    { title: 'Completed', value: stats.completed_count || 0, icon: CheckCircle, color: 'green', sub: 'All time' },
    { title: 'Exceptions / On Hold', value: stats.exception_count || 0, icon: AlertTriangle, color: 'red', sub: 'Need attention' },
    {
      title: 'Avg Processing Time',
      value: stats.avg_processing_time_hours != null ? `${stats.avg_processing_time_hours}h` : 'N/A',
      icon: Clock, color: 'purple', sub: 'Submit → Complete'
    },
  ];

  const colorMap = {
    blue: 'bg-getmeds-blue/15 text-getmeds-blue',
    orange: 'bg-amber-100 text-amber-800',
    indigo: 'bg-indigo-100 text-indigo-800',
    green: 'bg-pharmacy-green/15 text-pharmacy-green',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
  };
  const iconColorMap = {
    blue: 'text-getmeds-blue', orange: 'text-amber-600', indigo: 'text-indigo-600',
    green: 'text-pharmacy-green', red: 'text-red-600', purple: 'text-purple-600',
  };

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

      const headers = ['Order ID', 'Customer', 'Salesperson', 'Status', 'Total', 'Payment', 'Created'];
      // Quote every field: customer names contain commas, and an unquoted one
      // silently shifts every later column in that row.
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = all.map(o => [
        o.getmeds_order_id, o.customer_name, salespersonOf(o), o.status,
        o.total_amount, o.payment_status || '', o.created_at
      ]);
      const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');

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

  const statusByStatus = stats.orders_by_status || {};
  const statusChartData = Object.entries(statusByStatus).map(([s, c]) => ({ status: s, count: c }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Management Dashboard</h1>
          <p className="text-sm text-ink-secondary mt-1">Real-time overview of all orders and KPIs.</p>
        </div>

        <div className="flex flex-col items-start md:items-end gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface hover:text-ink-primary">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>

            <button
              onClick={() => startSync('salesorders', 'quick')}
              disabled={importBusy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-blue-600 bg-blue-600 text-white hover:bg-blue-700 transition-all shadow-xs cursor-pointer disabled:opacity-50"
              title="Fast — only the Sales Orders created or changed in Zoho since the last import (read-only)"
            >
              <Zap size={15} />
              Quick Sync Orders
            </button>

            <button
              onClick={() => startSync('salesorders', 'full')}
              disabled={importBusy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-xs cursor-pointer disabled:opacity-50"
              title={
                `Pulls Sales Orders straight from Zoho — including ones raised in Zoho rather than here — and rebuilds ` +
                `each order's trail from Zoho's own history. Read-only: nothing is ever written to Zoho. ` +
                `Up to ${importStatus.per_run_limit || 500} per run; run it again to continue a large history.`
              }
            >
              <DownloadCloud size={15} />
              Retrieve All Sales Orders
            </button>
          </div>

          <SyncProgressIndicator
            job={importJob}
            labels={{ full: 'Retrieving Sales Orders from Zoho', quick: 'Quick Sync (Sales Orders)' }}
          />

          {!importJob && (importStatus.imported_orders > 0 || importStatus.last_full_import_at) && (
            <p className="text-[11px] text-ink-secondary text-right">
              {(importStatus.imported_orders || 0).toLocaleString()} order(s) imported from Zoho
              {importStatus.zoho_log_entries
                ? `, ${importStatus.zoho_log_entries.toLocaleString()} Zoho log entries on file`
                : ''}
              {importStatus.last_full_import_at ? ` — last full import ${formatPHT(importStatus.last_full_import_at)}` : ''}
              {/* The detail backlog, stated rather than left to be discovered.
                  An order here with no line items is not broken — its summary
                  came from Zoho's list and its detail has not been fetched
                  yet. Opening the order pulls it on demand; so does another
                  run of the import. */}
              {importStatus.awaiting_detail > 0 && (
                <>
                  <br />
                  {importStatus.awaiting_detail.toLocaleString()} still awaiting full detail (line items + Zoho
                  history) — {importStatus.per_run_limit?.toLocaleString?.() || importStatus.per_run_limit} per run,
                  or pulled on demand when the order is opened.
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      {loadingStats ? (
        <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {statCards.map((card, i) => {
            const Icon = card.icon;
            return (
              <div key={i} className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
                <div className="inline-flex mb-3">
                  <Icon className={`w-7 h-7 ${iconColorMap[card.color]}`} />
                </div>
                <p className="text-2xl font-bold text-ink-primary">{card.value}</p>
                <p className="text-xs font-semibold text-ink-primary mt-0.5">{card.title}</p>
                <p className="text-xs text-ink-secondary mt-0.5">{card.sub}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Orders by status breakdown */}
      {statusChartData.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3">Orders by Status</h2>
          <div className="flex flex-wrap gap-2">
            {statusChartData.map(({ status, count }) => (
              <button
                key={status}
                onClick={() => applyFilter(setStatusFilter)(status === statusFilter ? '' : status)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${statusFilter === status ? 'ring-2 ring-getmeds-blue' : ''} ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-700'}`}
              >
                <span className="capitalize">{status.replace(/_/g, ' ')}</span>
                <span className="font-bold">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Orders Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-primary whitespace-nowrap">
            All Orders
            {statusFilter && <span className="ml-1 text-getmeds-blue capitalize">· {statusFilter.replace(/_/g, ' ')}</span>}
            <span className="ml-2 font-normal text-ink-secondary">
              {pagination.total.toLocaleString()} total
            </span>
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            {/* Date range. Filters on the order's created date — the same value
                the Date column shows — so what is filtered and what is read
                are the same thing. */}
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              From
              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => applyFilter(setDateFrom)(e.target.value)}
                className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              To
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => applyFilter(setDateTo)(e.target.value)}
                className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
              />
            </label>

            {hasFilters && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-ink-secondary hover:text-ink-primary border border-slate-200 rounded hover:bg-surface"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}

            <button
              onClick={downloadCSV}
              disabled={exporting}
              className="px-2.5 py-1 text-xs border border-slate-200 rounded text-ink-secondary hover:bg-surface disabled:opacity-50"
              title="Exports every order matching the current filters, not just this page"
            >
              {exporting ? 'Preparing…' : '⬇ Export CSV'}
            </button>
          </div>
        </div>
        {loadingOrders ? (
          <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-ink-secondary text-sm">
            {hasFilters ? 'No orders match these filters.' : 'No orders found.'}
          </div>
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Order ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Salesperson</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Total</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-ink-secondary uppercase"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {orders.map(order => (
                <tr key={order.id} className="hover:bg-surface transition-colors">
                  <td className="px-4 py-3 text-sm font-mono font-semibold text-getmeds-blue">{order.getmeds_order_id}</td>
                  <td className="px-4 py-3 text-sm font-medium text-ink-primary">{order.customer_name}</td>
                  <td className="px-4 py-3 text-sm text-ink-secondary">{salespersonOf(order)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-700'}`}>
                      {order.status?.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">{formatPHT(order.created_at, 'date')}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/orders/${order.id}`} className="inline-flex items-center gap-1 text-xs text-getmeds-blue hover:text-getmeds-blue-dark font-semibold">
                      <Eye className="w-3.5 h-3.5" /> View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              {fetchingOrders && <span className="ml-2 text-ink-secondary">updating…</span>}
            </p>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={pagination.page <= 1}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-200 rounded text-ink-secondary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </button>
              <span className="text-xs text-ink-secondary">
                Page <span className="font-semibold text-ink-primary">{pagination.page.toLocaleString()}</span>{' '}
                of {pagination.pages.toLocaleString()}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                disabled={pagination.page >= pagination.pages}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-200 rounded text-ink-secondary hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ManagementDashboardPage;
