import React from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, AlertTriangle, Hourglass, CloudOff, UserPlus, CheckCircle2, ChevronRight } from 'lucide-react';
import Skeleton from '../ui/Skeleton';

/**
 * "What needs me right now" — the first thing on the dashboard, above the
 * KPIs. Each item is a count that goes straight to whatever resolves it: a
 * page (approvals, exceptions, Zoho failures, pending customers) or a filter
 * on the orders table below (stuck orders).
 *
 * Sep 24, 2026: this used to be a stock-announcements banner. Stock news is
 * worth knowing but it is rarely something an admin must ACT on; approvals,
 * holds and failed syncs are, so they take the prime position and stock news
 * moved to the side panel.
 *
 * Items whose count is null are omitted rather than shown as zero — null means
 * "this viewer has no such queue" (a Team Lead has no approvals or Zoho
 * failures), and a zero would wrongly claim it had been checked and was clear.
 */
const TONES = {
  danger: { wrap: 'border-state-error/30 bg-state-error-light/60 hover:bg-state-error-light', icon: 'text-state-error', count: 'text-state-error' },
  warning: { wrap: 'border-state-warning/40 bg-state-warning-light/60 hover:bg-state-warning-light', icon: 'text-state-warning', count: 'text-amber-700' },
  calm: { wrap: 'border-slate-200 bg-white hover:bg-surface', icon: 'text-ink-secondary', count: 'text-ink-primary' }
};

const Item = ({ icon: Icon, count, label, sub, tone, to, onClick }) => {
  // Nothing to act on → the item goes quiet instead of shouting a zero.
  const t = TONES[count > 0 ? tone : 'calm'];
  const body = (
    <>
      <Icon className={`w-5 h-5 shrink-0 ${t.icon}`} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className={`text-lg font-bold tabular-nums ${t.count}`}>{Number(count).toLocaleString()}</span>
          <span className="text-xs font-semibold text-ink-primary truncate">{label}</span>
        </p>
        {sub && <p className="text-[11px] text-ink-secondary truncate">{sub}</p>}
      </div>
      <ChevronRight className="w-4 h-4 shrink-0 text-slate-300" />
    </>
  );
  const cls = `flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${t.wrap}`;
  return to ? (
    <Link to={to} className={cls}>{body}</Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>{body}</button>
  );
};

export const ActionNeededSkeleton = () => (
  <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
    {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[58px] rounded-xl" />)}
  </div>
);

const ActionNeededStrip = ({ data, isTeamLead = false, onShowStale }) => {
  if (!data) return null;

  const items = [];
  if (!isTeamLead && data.pending_approvals != null) {
    items.push({ key: 'approvals', icon: ClipboardCheck, count: data.pending_approvals, label: 'Awaiting approval', sub: 'Approval Queue', tone: 'warning', to: '/management/approvals' });
  }
  if (!isTeamLead && data.holds != null) {
    items.push({ key: 'holds', icon: AlertTriangle, count: data.holds, label: 'On hold / exceptions', sub: 'Exception Hub', tone: 'danger', to: '/management/exceptions' });
  }
  if (data.stale_orders != null) {
    items.push({ key: 'stale', icon: Hourglass, count: data.stale_orders, label: `Stuck over ${data.stale_hours || 48}h`, sub: 'Show in the table below', tone: 'warning', onClick: onShowStale });
  }
  if (data.failed_syncs != null) {
    items.push({ key: 'syncs', icon: CloudOff, count: data.failed_syncs, label: 'Zoho syncs failed', sub: 'Zoho Sync Health', tone: 'danger', to: '/admin/zoho-sync' });
  }
  if (!isTeamLead && data.pending_customers != null) {
    items.push({ key: 'customers', icon: UserPlus, count: data.pending_customers, label: 'Customers pending', sub: 'Pending Customers', tone: 'warning', to: '/management/pending-customers' });
  }
  if (!items.length) return null;

  const allClear = items.every((i) => !i.count);
  if (allClear) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-pharmacy-green/30 bg-pharmacy-green/10 px-4 py-3 text-sm text-pharmacy-green-dark">
        <CheckCircle2 className="w-5 h-5 shrink-0" />
        <span className="font-semibold">All clear</span>
        <span className="text-ink-secondary">— nothing needs your attention right now.</span>
      </div>
    );
  }

  return (
    <section aria-label="Needs attention">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-secondary mb-2">Needs your attention</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {items.map(({ key, ...rest }) => <Item key={key} {...rest} />)}
      </div>
    </section>
  );
};

export default ActionNeededStrip;
