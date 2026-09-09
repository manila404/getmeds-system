import React, { useState, useEffect } from 'react';
import client from '../../api/client';
import LoadingSpinner from '../../components/ui/LoadingSpinner';
import ErrorMessage from '../../components/ui/ErrorMessage';
import { RefreshCw, AlertTriangle, Clock, CheckCircle2, XCircle, Zap } from 'lucide-react';
import toast from 'react-hot-toast';

// Sep 9, 2026: the roadmap's Phase 1 item 1 — "nothing tells you a Zoho
// sync failed except a MedRep noticing 'Not yet synced' on an order detail
// page." The backend has tracked this all along (zohoRetryService's outbox,
// GET/POST /api/admin/zoho/queue — see admin.controller.js) but nothing in
// the app ever showed it. This page is that missing view: pending items
// still waiting on their backoff window, permanently-failed ones that need
// a human, and a manual "Retry Now" that ignores the backoff — the same
// force pass the admin API already supported.
const statusMeta = {
  pending: {
    label: 'Pending retry',
    icon: <Clock className="w-3.5 h-3.5" />,
    className: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  succeeded: {
    label: 'Recovered',
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    className: 'bg-pharmacy-green/10 text-pharmacy-green border-pharmacy-green/30',
  },
  failed_permanent: {
    label: 'Needs attention',
    icon: <XCircle className="w-3.5 h-3.5" />,
    className: 'bg-red-50 text-red-700 border-red-200',
  },
};

const formatDate = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value;
  }
};

const ZohoSyncHealthPage = () => {
  const [queue, setQueue] = useState([]);
  const [summary, setSummary] = useState({ pending: 0, succeeded: 0, failed_permanent: 0 });
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchQueue();
  }, []);

  const fetchQueue = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.get('/api/admin/zoho/queue');
      const data = res.data?.data || {};
      setQueue(Array.isArray(data.queue) ? data.queue : []);
      setSummary(data.summary || { pending: 0, succeeded: 0, failed_permanent: 0 });
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error?.message ||
        err.message ||
        'Failed to load the Zoho sync queue';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleRetryNow = async () => {
    setRetrying(true);
    try {
      const res = await client.post('/api/admin/zoho/queue/retry');
      const processed = res.data?.data?.processed ?? 0;
      toast.success(
        processed > 0
          ? `Retried ${processed} order${processed === 1 ? '' : 's'} against Zoho.`
          : 'Nothing was eligible to retry right now.'
      );
      await fetchQueue();
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error?.message ||
        'Retry pass failed to run';
      toast.error(errorMsg);
    } finally {
      setRetrying(false);
    }
  };

  // Only pending/failed rows matter day to day — a long-lived history of
  // every past recovery would just bury today's actual problem.
  const actionable = queue.filter((q) => q.status === 'pending' || q.status === 'failed_permanent');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="w-7 h-7 text-getmeds-blue" />
            <h1 className="text-2xl font-semibold text-ink-primary">Zoho Sync Health</h1>
          </div>
          <p className="text-sm text-ink-secondary mt-1">
            Orders whose Sales Order push to Zoho failed and is waiting on retry, plus any that gave up after repeated attempts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRetryNow}
            disabled={retrying || summary.pending === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-sm font-medium text-white bg-getmeds-blue hover:bg-getmeds-blue-dark shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={summary.pending === 0 ? 'Nothing pending to retry' : 'Retry all pending items now, ignoring backoff'}
          >
            <Zap className={`w-4 h-4 ${retrying ? 'animate-pulse' : ''}`} />
            {retrying ? 'Retrying…' : 'Retry Now'}
          </button>
          <button
            onClick={fetchQueue}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 rounded-md text-sm font-medium text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary shadow-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-ink-secondary">Pending retry</p>
          <p className="text-2xl font-semibold text-amber-700 mt-1">{summary.pending ?? 0}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-ink-secondary">Recovered</p>
          <p className="text-2xl font-semibold text-pharmacy-green mt-1">{summary.succeeded ?? 0}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-ink-secondary">Needs attention</p>
          <p className="text-2xl font-semibold text-red-700 mt-1">{summary.failed_permanent ?? 0}</p>
        </div>
      </div>

      {summary.failed_permanent > 0 && (
        <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <AlertTriangle className="w-4.5 h-4.5 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-800">
            {summary.failed_permanent} order{summary.failed_permanent === 1 ? '' : 's'} gave up retrying automatically after
            repeated failures and need manual follow-up — check the reason below, fix it in Zoho or here, then use the order's
            own "Retry Zoho Sync" button on its detail page.
          </p>
        </div>
      )}

      {error && <ErrorMessage message={error} />}

      {loading ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner size="lg" />
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[900px] divide-y divide-slate-200">
              <thead className="bg-getmeds-blue">
                <tr>
                  <th className="px-6 py-3 text-left text-[13px] font-semibold text-white">Order</th>
                  <th className="px-6 py-3 text-left text-[13px] font-semibold text-white">Status</th>
                  <th className="px-6 py-3 text-left text-[13px] font-semibold text-white">Attempts</th>
                  <th className="px-6 py-3 text-left text-[13px] font-semibold text-white">Last error</th>
                  <th className="px-6 py-3 text-left text-[13px] font-semibold text-white">Next attempt</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {actionable.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-ink-secondary">
                      Nothing pending or failed — every order has synced to Zoho.
                    </td>
                  </tr>
                ) : (
                  actionable.map((row) => {
                    const meta = statusMeta[row.status] || statusMeta.pending;
                    return (
                      <tr key={row.id} className="hover:bg-surface transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-[13px] font-semibold text-ink-primary">
                            {row.getmeds_order_id || `#${row.order_id}`}
                          </div>
                          <div className="text-[11px] text-ink-secondary">{row.order_status || '—'}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${meta.className}`}>
                            {meta.icon}
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-[13px] text-ink-secondary">
                          {row.attempts ?? 0}
                        </td>
                        <td className="px-6 py-4 text-[13px] text-ink-secondary max-w-xs truncate" title={row.last_error || ''}>
                          {row.last_error || '—'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-[13px] text-ink-secondary">
                          {row.status === 'pending' ? formatDate(row.next_attempt_at) : '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default ZohoSyncHealthPage;
