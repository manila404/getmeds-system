import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import Skeleton from '../ui/Skeleton';

/**
 * The latest decisions and problems across the viewer's orders — what an admin
 * would otherwise open five pages to piece together. The event list is curated
 * server-side (see management.controller.js's getRecentActivity); this only
 * decides how each one reads.
 */
const EVENTS = {
  ORDER_SUBMITTED: { label: 'Submitted', tone: 'neutral' },
  ORDER_RESUBMITTED: { label: 'Resubmitted', tone: 'neutral' },
  MANAGEMENT_APPROVED: { label: 'Approved', tone: 'ok' },
  MANAGEMENT_REJECTED: { label: 'Rejected', tone: 'bad' },
  MANAGEMENT_SENT_BACK: { label: 'Sent back', tone: 'warn' },
  FINANCE_VERIFIED: { label: 'Finance verified', tone: 'ok' },
  FINANCE_REJECTED: { label: 'Finance rejected', tone: 'bad' },
  EXCEPTION_SET: { label: 'Marked exception', tone: 'bad' },
  DISPATCH_HOLD: { label: 'Dispatch hold', tone: 'warn' },
  TRACKING_ON_HOLD: { label: 'Tracking on hold', tone: 'warn' },
  ZOHO_SYNC_FAILED_PERMANENT: { label: 'Zoho sync failed', tone: 'bad' },
  ZOHO_SYNC_RECOVERED: { label: 'Zoho sync recovered', tone: 'ok' },
  ORDER_COMPLETED: { label: 'Completed', tone: 'ok' }
};
const DOT = { ok: 'bg-pharmacy-green', bad: 'bg-state-error', warn: 'bg-state-warning', neutral: 'bg-state-neutral' };

const RecentActivity = () => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['management-activity'],
    queryFn: () => client.get('/api/management/activity?limit=8').then((r) => r.data?.data?.events || []),
    refetchInterval: 60000,
    staleTime: 30000
  });
  const events = data || [];

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <Activity className="w-4 h-4 text-getmeds-blue" />
        <h2 className="text-sm font-semibold text-ink-primary">Recent activity</h2>
      </div>

      {isLoading ? (
        <div className="p-4 space-y-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}
        </div>
      ) : isError ? (
        <p className="px-4 py-6 text-center text-xs text-ink-secondary">Couldn't load recent activity.</p>
      ) : events.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-ink-secondary">Nothing to report in the last 30 days.</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {events.map((e) => {
            const meta = EVENTS[e.event_type] || { label: e.event_type, tone: 'neutral' };
            return (
              <li key={e.id}>
                <Link to={`/orders/${e.order_id}`} className="flex gap-3 px-4 py-2.5 hover:bg-surface transition-colors">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${DOT[meta.tone]}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-ink-primary">
                      <span className="font-semibold">{meta.label}</span>
                      <span className="text-ink-secondary"> · </span>
                      <span className="font-mono text-getmeds-blue">{e.getmeds_order_id}</span>
                    </p>
                    <p className="text-[11px] text-ink-secondary truncate">
                      {[e.customer_name, e.actor_name && `by ${e.actor_name}`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="text-[11px] text-ink-secondary shrink-0 pt-0.5">{formatPHT(e.created_at, 'timeline')}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};

export default RecentActivity;
